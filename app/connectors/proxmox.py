from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import os
import requests
import time
import logging
from urllib.parse import urlsplit, urlunsplit


_DOCKER_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _docker_host_alias() -> str:
    alias = str(
        os.environ.get("PROXMOX_API_HOST_OVERRIDE")
        or os.environ.get("DOCKER_HOST_ALIAS")
        or "host.docker.internal"
    ).strip()
    return alias or "host.docker.internal"


def _running_in_container() -> bool:
    try:
        marker = os.environ.get("IN_DOCKER")
        if marker is not None:
            return str(marker).strip().lower() not in {"", "0", "false", "no"}
    except Exception:
        pass
    return os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")


def _normalize_container_localhost_url(base_url: Optional[str]) -> Optional[str]:
    try:
        raw = str(base_url or "").strip()
    except Exception:
        raw = ""
    if not raw or not _running_in_container():
        return base_url

    try:
        parsed = urlsplit(raw)
    except Exception:
        return base_url

    host = (parsed.hostname or "").strip().lower()
    if host not in _DOCKER_LOCAL_HOSTS:
        return base_url

    alias = _docker_host_alias()

    auth = ""
    if parsed.username:
        auth = parsed.username
        if parsed.password:
            auth += f":{parsed.password}"
        auth += "@"

    host_literal = alias
    if ":" in alias and not alias.startswith("["):
        host_literal = f"[{alias}]"

    netloc = f"{auth}{host_literal}"
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"

    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))


def _rewrite_url_hostname(url: str, replacement_host: str) -> str:
    parsed = urlsplit(str(url or ""))
    auth = ""
    if parsed.username:
        auth = parsed.username
        if parsed.password:
            auth += f":{parsed.password}"
        auth += "@"

    host_literal = replacement_host
    if ":" in replacement_host and not replacement_host.startswith("["):
        host_literal = f"[{replacement_host}]"

    netloc = f"{auth}{host_literal}"
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))


def _looks_like_name_resolution_error(exc: BaseException) -> bool:
    pending = [exc]
    seen = set()
    needles = (
        "failed to resolve",
        "name resolution",
        "temporary failure in name resolution",
        "name or service not known",
        "nodename nor servname provided",
    )
    while pending:
        current = pending.pop(0)
        if current is None:
            continue
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        text = f"{type(current).__name__}: {current}".lower()
        if any(needle in text for needle in needles):
            return True
        reason = getattr(current, "reason", None)
        cause = getattr(current, "__cause__", None)
        context = getattr(current, "__context__", None)
        for candidate in (reason, cause, context):
            if isinstance(candidate, BaseException):
                pending.append(candidate)
    return False


def _fallback_request_url(url: str) -> Optional[str]:
    if not _running_in_container():
        return None
    try:
        parsed = urlsplit(str(url or "").strip())
    except Exception:
        return None
    host = (parsed.hostname or "").strip().lower()
    if not host or host in _DOCKER_LOCAL_HOSTS:
        return None
    alias = _docker_host_alias()
    if not alias or alias.strip().lower() == host:
        return None
    return _rewrite_url_hostname(url, alias)


class GuestAgentUnavailableError(RuntimeError):
    """Raised when the QEMU guest agent is not installed or not reachable."""
    pass


@dataclass
class ProxmoxClient:
    base_url: str
    token: Optional[str] = None
    verify: bool = True
    username: Optional[str] = None
    password: Optional[str] = None
    _session: Optional[requests.Session] = None
    _logger: logging.Logger = field(default_factory=lambda: logging.getLogger(__name__), init=False, repr=False)

    def __post_init__(self):
        if self.username and '@' not in self.username:
            self.username += '@pam'
            
        normalized = _normalize_container_localhost_url(self.base_url)
        if normalized and normalized != self.base_url:
            self._logger.warning(
                "Rewriting Proxmox base URL from %s to %s for container-to-host access",
                self.base_url,
                normalized,
            )
            self.base_url = normalized

    def _ensure_session(self) -> requests.Session:
        if self._session is not None:
            return self._session
        self._session = requests.Session()
        self._session.verify = self.verify
        self._install_request_fallback(self._session)
        if self.token:
            self._session.headers.update({"Authorization": f"PVEAPIToken={self.token}"})
            return self._session
        # Use username/password login
        if not (self.username and self.password):
            raise RuntimeError("Missing Proxmox credentials")
        url = f"{self.base_url.rstrip('/')}/api2/json/access/ticket"
        resp = self._session.post(url, data={"username": self.username, "password": self.password}, timeout=15)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox login failed {resp.status_code}: {resp.text}")
        data = resp.json().get("data", {})
        ticket = data.get("ticket")
        csrf = data.get("CSRFPreventionToken") or data.get("csrfpreventiontoken")
        if not ticket:
            raise RuntimeError("Proxmox login did not return a ticket")
        # Set cookie for subsequent requests
        self._session.cookies.set("PVEAuthCookie", ticket)
        # For POST/PUT/DELETE with ticket-based auth, Proxmox requires CSRFPreventionToken header
        if csrf:
            self._session.headers.update({"CSRFPreventionToken": csrf})
        return self._session

    def _install_request_fallback(self, session: requests.Session) -> None:
        if getattr(session, "_sce_proxmox_dns_fallback_installed", False):
            return
        original_request = session.request
        logger = self._logger

        def request_with_fallback(method, url, *args, **kwargs):
            try:
                return original_request(method, url, *args, **kwargs)
            except requests.RequestException as exc:
                fallback_url = _fallback_request_url(str(url or "")) if _looks_like_name_resolution_error(exc) else None
                if not fallback_url or fallback_url == url:
                    raise
                logger.warning(
                    "Retrying Proxmox request via %s after DNS resolution failure for %s",
                    fallback_url,
                    url,
                )
                return original_request(method, fallback_url, *args, **kwargs)

        session.request = request_with_fallback  # type: ignore[assignment]
        session._sce_proxmox_dns_fallback_installed = True  # type: ignore[attr-defined]

    def list_nodes(self) -> List[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes"
        resp = s.get(url, timeout=15)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox error {resp.status_code}: {resp.text}")
        data = resp.json()
        return data.get("data", [])

    def list_qemu_vms(self, node: str) -> List[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu"
        resp = s.get(url, timeout=20)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox error {resp.status_code}: {resp.text}")
        data = resp.json()
        return data.get("data", [])

    def get_qemu_config(self, node: str, vmid: int) -> Dict[str, Any]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/config"
        resp = s.get(url, timeout=20)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox error {resp.status_code}: {resp.text}")
        data = resp.json()
        return data.get("data", {})

    def get_qemu_status_current(self, node: str, vmid: int) -> Dict[str, Any]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/status/current"
        resp = s.get(url, timeout=20)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox error {resp.status_code}: {resp.text}")
        data = resp.json()
        return data.get("data", {})

    # --- Helpers for operations ---
    def _wait_task(
        self,
        node: str,
        upid: str,
        timeout: float = 600.0,
        poll: float = 1.5,
        vmid: Optional[int] = None,
        completed_vm_statuses: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        s = self._ensure_session()
        start = time.time()
        desired_vm_statuses = {
            str(value).strip().lower()
            for value in (completed_vm_statuses or [])
            if str(value).strip()
        }

        def _maybe_complete_from_vm_state() -> Optional[Dict[str, Any]]:
            if vmid is None or not desired_vm_statuses:
                return None
            current = self.get_qemu_status_current(node, vmid)
            current_status = str(current.get('status') or current.get('qmpstatus') or '').strip().lower()
            if current_status in desired_vm_statuses:
                return {
                    'status': 'stopped',
                    'exitstatus': 'OK',
                    'completed_via': 'vm_state',
                    'vm_status': current_status,
                }
            return None

        while True:
            url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/tasks/{requests.utils.quote(upid, safe='')}/status"
            r = s.get(url, timeout=30)
            if r.status_code >= 400:
                try:
                    fallback = _maybe_complete_from_vm_state()
                except Exception:
                    fallback = None
                if fallback is not None:
                    return fallback
                raise RuntimeError(f"Proxmox task status error {r.status_code}: {r.text}")
            st = r.json().get('data', {})
            if st.get('status') == 'stopped':
                exitstatus = st.get('exitstatus', '')
                if exitstatus and exitstatus != 'OK':
                    raise RuntimeError(f"Proxmox task failed: {exitstatus}")
                return st
            try:
                fallback = _maybe_complete_from_vm_state()
            except Exception:
                fallback = None
            if fallback is not None:
                return fallback
            if time.time() - start > timeout:
                raise RuntimeError("Proxmox task timed out")
            time.sleep(poll)

    def cluster_nextid(self) -> int:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/cluster/nextid"
        r = s.get(url, timeout=15)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox error {r.status_code}: {r.text}")
        data = r.json().get('data')
        try:
            return int(data)
        except Exception:
            raise RuntimeError(f"Invalid nextid data: {data}")

    def clone_qemu(self, node: str, vmid: int, newid: int, name: str, storage: Optional[str] = None, full: bool = True, target: Optional[str] = None) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/clone"
        payload: Dict[str, Any] = { 'newid': newid, 'name': name, 'full': 1 if full else 0 }
        if storage: payload['storage'] = storage
        if target: payload['target'] = target
        r = s.post(url, data=payload, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox clone error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def set_qemu_nets(self, node: str, vmid: int, nets: List[str], delete_keys: Optional[List[str]] = None):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/config"
        data: Dict[str, Any] = {}
        if delete_keys:
            data['delete'] = ','.join(delete_keys)
        for i, spec in enumerate(nets):
            data[f'net{i}'] = spec
        r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox set net error {r.status_code}: {r.text}")
        return r.json().get('data', '')

    def set_qemu_options(self, node: str, vmid: int, options: Dict[str, Any]):
        """Generic QEMU config setter (e.g., set 'pool' or other options)."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/config"
        r = s.post(url, data=options or {}, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox set VM options error {r.status_code}: {r.text}")
        return r.json().get('data', '')

    def delete_qemu_options(self, node: str, vmid: int, keys: List[str]):
        """Delete one or more QEMU config options via the 'delete' parameter."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/config"
        data = { 'delete': ','.join(list(keys or [])) }
        r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox delete VM options error {r.status_code}: {r.text}")
        return r.json().get('data', '')

    def create_bridge(self, node: str, iface: str, autostart: bool = True, ports: Optional[str] = None, comments: Optional[str] = None):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/network"
        payload: Dict[str, Any] = { 'type': 'bridge', 'iface': iface }
        if autostart:
            payload['autostart'] = 1
        # Proxmox API expects 'bridge_ports' (underscore). Only include when ports are specified.
        if ports is not None:
            payload['bridge_ports'] = ports
        if comments:
            payload['comments'] = comments
        r = s.post(url, data=payload, timeout=30)
        if r.status_code >= 400:
            # If already exists, Proxmox may return 500; treat as non-fatal if message indicates exists
            msg = r.text
            if 'already exists' not in msg.lower() and 'exists' not in msg.lower():
                raise RuntimeError(f"Proxmox create bridge error {r.status_code}: {r.text}")
        return True

    def list_network(self, node: str):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/network"
        r = s.get(url, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox list network error {r.status_code}: {r.text}")
        return r.json().get('data', [])

    def reload_network(self, node: str):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/network"
        r = s.put(url, timeout=30)
        if r.status_code >= 400:
            # Some Proxmox versions/roles return 501 for unsupported reload; treat as non-fatal
            if r.status_code != 501:
                raise RuntimeError(f"Proxmox network reload error {r.status_code}: {r.text}")
        else:
            try:
                res_data = r.json()
            except Exception:
                res_data = {}
            upid = res_data.get('data')
            if upid and isinstance(upid, str) and upid.startswith('UPID:'):
                try:
                    self._wait_task(node, upid, timeout=120)
                except Exception as e:
                    raise RuntimeError(f"Proxmox network reload task failed: {e}")
        return True

    def snapshot_qemu(self, node: str, vmid: int, snapname: str, description: Optional[str] = None) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/snapshot"
        payload: Dict[str, Any] = { 'snapname': snapname }
        if description: payload['description'] = description
        r = s.post(url, data=payload, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox snapshot error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def delete_qemu(self, node: str, vmid: int, purge: bool = True, destroy_unreferenced_disks: bool = True) -> str:
        """Delete (destroy) a QEMU VM. Returns UPID."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}"
        params: Dict[str, Any] = {}
        if purge:
            params['purge'] = 1
        if destroy_unreferenced_disks:
            params['destroy-unreferenced-disks'] = 1
        r = s.delete(url, params=params, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox delete VM error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def delete_bridge(self, node: str, iface: str) -> bool:
        """Delete a Linux bridge interface on the node. Non-fatal if it doesn't exist."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/network/{requests.utils.quote(iface, safe='')}"
        r = s.delete(url, timeout=30)
        if r.status_code >= 400:
            # treat not found as non-fatal; various messages are possible
            msg = (r.text or '').lower()
            if 'no such' in msg or 'does not exist' in msg or 'not found' in msg:
                return False
            raise RuntimeError(f"Proxmox delete bridge error {r.status_code}: {r.text}")
        return True

    # --- QEMU lifecycle and state actions ---
    def _qemu_status_action(self, node: str, vmid: int, action: str, data: Optional[Dict[str, Any]] = None, timeout: int = 60) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/status/{action}"
        r = s.post(url, data=(data or {}), timeout=timeout)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox {action} error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def start_qemu(self, node: str, vmid: int) -> str:
        return self._qemu_status_action(node, vmid, 'start')

    def unlock_qemu(self, node: str, vmid: int) -> str:
        return self._qemu_status_action(node, vmid, 'unlock')

    def stop_qemu(self, node: str, vmid: int) -> str:
        return self._qemu_status_action(node, vmid, 'stop')

    def shutdown_qemu(self, node: str, vmid: int, timeout: Optional[int] = None) -> str:
        data = {}
        if timeout is not None:
            data['timeout'] = int(timeout)
        return self._qemu_status_action(node, vmid, 'shutdown', data=data)

    def reboot_qemu(self, node: str, vmid: int) -> str:
        return self._qemu_status_action(node, vmid, 'reboot')

    def reset_qemu(self, node: str, vmid: int) -> str:
        return self._qemu_status_action(node, vmid, 'reset')

    # pause removed from UI; keep method removed to discourage use

    def resume_qemu(self, node: str, vmid: int) -> str:
        return self._qemu_status_action(node, vmid, 'resume')

    def suspend_qemu(self, node: str, vmid: int) -> str:
        # Proxmox provides 'suspend' to RAM (requires guest agent); may not be supported everywhere
        return self._qemu_status_action(node, vmid, 'suspend')

    def restore_snapshot_qemu(self, node: str, vmid: int, snapname: str, start_after: bool = False) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/snapshot/{requests.utils.quote(snapname, safe='')}/rollback"
        data: Dict[str, Any] = {}
        if start_after:
            data['start'] = 1
        r = s.post(url, data=data, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox snapshot rollback error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def list_snapshots_qemu(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        """Return list of snapshots for a VM (name, snaptime, description, etc.)."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/snapshot"
        r = s.get(url, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox list snapshots error {r.status_code}: {r.text}")
        data = r.json().get('data', [])
        # Normalize fields and ensure snaptime is int when possible
        out: List[Dict[str, Any]] = []
        for d in data:
            try:
                st = d.get('snaptime')
                st = int(st) if st is not None else None
            except Exception:
                st = None
            out.append({
                'name': d.get('name'),
                'snaptime': st,
                'description': d.get('description')
            })
        return out

    def list_qemu_snapshots(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        return self.list_snapshots_qemu(node, vmid)

    def list_lxc_vms(self, node: str) -> List[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc"
        resp = s.get(url, timeout=20)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox error {resp.status_code}: {resp.text}")
        data = resp.json()
        return data.get("data", [])

    def get_lxc_config(self, node: str, vmid: int) -> Dict[str, Any]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/config"
        resp = s.get(url, timeout=20)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox error {resp.status_code}: {resp.text}")
        data = resp.json()
        return data.get("data", {})

    def get_lxc_status_current(self, node: str, vmid: int) -> Dict[str, Any]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/status/current"
        resp = s.get(url, timeout=20)
        if resp.status_code >= 400:
            raise RuntimeError(f"Proxmox error {resp.status_code}: {resp.text}")
        data = resp.json()
        return data.get("data", {})

    def clone_lxc(self, node: str, vmid: int, newid: int, name: str, storage: Optional[str] = None, full: bool = True, target: Optional[str] = None) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/clone"
        payload: Dict[str, Any] = { 'newid': newid, 'hostname': name, 'full': 1 if full else 0 }
        if storage: payload['storage'] = storage
        if target: payload['target'] = target
        r = s.post(url, data=payload, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox clone error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def set_lxc_nets(self, node: str, vmid: int, nets: List[str], delete_keys: Optional[List[str]] = None):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/config"
        data: Dict[str, Any] = {}
        if delete_keys:
            data['delete'] = ','.join(delete_keys)
        for i, spec in enumerate(nets):
            data[f'net{i}'] = spec
        r = s.put(url, data=data, timeout=30)
        if r.status_code in (405, 501):
            r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox set lxc net error {r.status_code}: {r.text}")
        return r.json().get('data', '')

    def set_lxc_options(self, node: str, vmid: int, options: Dict[str, Any]):
        """Generic LXC config setter (e.g., set 'pool' or other options)."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/config"
        r = s.put(url, data=options or {}, timeout=30)
        if r.status_code in (405, 501):
            r = s.post(url, data=options or {}, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox set LXC options error {r.status_code}: {r.text}")
        return r.json().get('data', '')

    def delete_lxc_options(self, node: str, vmid: int, keys: List[str]):
        """Delete one or more LXC config options via the 'delete' parameter."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/config"
        data = { 'delete': ','.join(list(keys or [])) }
        r = s.put(url, data=data, timeout=30)
        if r.status_code in (405, 501):
            r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox delete LXC options error {r.status_code}: {r.text}")
        return r.json().get('data', '')

    def snapshot_lxc(self, node: str, vmid: int, snapname: str, description: Optional[str] = None) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/snapshot"
        payload: Dict[str, Any] = { 'snapname': snapname }
        if description: payload['description'] = description
        r = s.post(url, data=payload, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox lxc snapshot error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def delete_lxc(self, node: str, vmid: int, purge: bool = True, destroy_unreferenced_disks: bool = True) -> str:
        """Delete (destroy) an LXC container. Returns UPID."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}"
        params: Dict[str, Any] = {}
        if purge:
            params['purge'] = 1
        if destroy_unreferenced_disks:
            params['destroy-unreferenced-disks'] = 1
        r = s.delete(url, params=params, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox delete LXC error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def _lxc_status_action(self, node: str, vmid: int, action: str, data: Optional[Dict[str, Any]] = None, timeout: int = 60) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/status/{action}"
        r = s.post(url, data=(data or {}), timeout=timeout)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox lxc {action} error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def start_lxc(self, node: str, vmid: int) -> str:
        return self._lxc_status_action(node, vmid, 'start')

    def unlock_lxc(self, node: str, vmid: int) -> str:
        # Note: Proxmox API doesn't officially expose /status/unlock for LXC like it does for QEMU in all versions.
        # But we'll map it to 'unlock' here to match QEMU. If it fails, API routes can handle or ignore.
        return self._lxc_status_action(node, vmid, 'unlock')

    def stop_lxc(self, node: str, vmid: int) -> str:
        return self._lxc_status_action(node, vmid, 'stop')

    def shutdown_lxc(self, node: str, vmid: int, timeout: Optional[int] = None) -> str:
        data = {}
        if timeout is not None:
            data['timeout'] = int(timeout)
        return self._lxc_status_action(node, vmid, 'shutdown', data=data)

    def reboot_lxc(self, node: str, vmid: int) -> str:
        return self._lxc_status_action(node, vmid, 'reboot')

    def resume_lxc(self, node: str, vmid: int) -> str:
        return self._lxc_status_action(node, vmid, 'resume')

    def suspend_lxc(self, node: str, vmid: int) -> str:
        return self._lxc_status_action(node, vmid, 'suspend')

    def restore_snapshot_lxc(self, node: str, vmid: int, snapname: str, start_after: bool = False) -> str:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/snapshot/{requests.utils.quote(snapname, safe='')}/rollback"
        data: Dict[str, Any] = {}
        if start_after:
            data['start'] = 1
        r = s.post(url, data=data, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox lxc snapshot rollback error {r.status_code}: {r.text}")
        return r.json().get('data', '')  # UPID

    def list_snapshots_lxc(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/lxc/{vmid}/snapshot"
        r = s.get(url, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox list lxc snapshots error {r.status_code}: {r.text}")
        data = r.json().get('data', [])
        out: List[Dict[str, Any]] = []
        for d in data:
            try:
                st = d.get('snaptime')
                st = int(st) if st is not None else None
            except Exception:
                st = None
            out.append({
                'name': d.get('name'),
                'snaptime': st,
                'description': d.get('description')
            })
        return out

    def list_lxc_snapshots(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        return self.list_snapshots_lxc(node, vmid)

    # --- QEMU Guest Agent helpers ---
    def agent_exec(
        self,
        node: str,
        vmid: int,
        command: Any,
        shell: bool = True,
        input_data: Optional[str] = None,
        timeout: int = 300,
        return_partial_on_timeout: bool = False,
    ) -> Dict[str, Any]:
        """Execute a command inside the guest via QEMU Guest Agent and wait for completion.
        Returns dict with keys: exitcode, stdout, stderr.
        """
        s = self._ensure_session()
        exec_url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/agent/exec"
        status_url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/agent/exec-status"
        logger = self._logger
        if shell:
            cmd_text = '' if command is None else str(command)
            command_list = ['/bin/sh', '-lc', cmd_text]
        else:
            if isinstance(command, (list, tuple)):
                command_list = [str(item) for item in command]
            else:
                command_list = [str(command)]
        payload: Dict[str, Any] = {'command': command_list}
        if input_data is not None:
            payload['input-data'] = str(input_data)
        if isinstance(command, (list, tuple)):
            preview_src = ' '.join(str(item) for item in command)
        else:
            preview_src = '' if command is None else str(command)
        cmd_preview = preview_src.replace('\n', ' ').strip()
        if len(cmd_preview) > 240:
            cmd_preview = f"{cmd_preview[:236]} ..."
        logger.info("guest agent exec start node=%s vmid=%s shell=%s cmd=%s", node, vmid, shell, cmd_preview)
        r = s.post(exec_url, json=payload, timeout=10)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox guest agent exec error {r.status_code}: {r.text}")
        pid = (r.json().get('data') or {}).get('pid')
        if pid is None:
            raise RuntimeError("agent exec: no pid returned (is guest agent running?)")
        logger.debug("guest agent exec pid=%s node=%s vmid=%s", pid, node, vmid)
        import time as _t
        start = _t.time()

        def _coerce_bool(value: Any, default: bool = False) -> bool:
            if value is None:
                return default
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value != 0
            if isinstance(value, str):
                norm = value.strip().lower()
                if not norm:
                    return default
                if norm in {'1', 'true', 'yes', 'running', 'ok', 'success', 'up'}:
                    return True
                if norm in {'0', 'false', 'no', 'stopped', 'stop', 'stopping', 'done', 'finished', 'complete', 'completed', 'exited', 'inactive', 'failed', 'error'}:
                    return False
            return bool(value)

        while True:
            elapsed = _t.time() - start
            if elapsed > timeout:
                if return_partial_on_timeout:
                    params = {'pid': pid}
                    stdout = ''
                    stderr = ''
                    exitcode = None
                    try:
                        rs = s.get(status_url, params=params, timeout=10)
                        if rs.status_code < 400:
                            st = rs.json().get('data', {}) if rs.content else {}
                            stdout = st.get('out-data') or ''
                            stderr = st.get('err-data') or ''
                            exitcode_raw = st.get('exitcode')
                            if exitcode_raw not in (None, ''):
                                try:
                                    exitcode = int(str(exitcode_raw).strip())
                                except Exception:
                                    try:
                                        exitcode = int(float(str(exitcode_raw).strip()))
                                    except Exception:
                                        exitcode = None
                    except Exception:
                        pass
                    try:
                        stdout = stdout if isinstance(stdout, str) else str(stdout)
                    except Exception:
                        stdout = ''
                    try:
                        stderr = stderr if isinstance(stderr, str) else str(stderr)
                    except Exception:
                        stderr = ''
                    logger.warning("guest agent exec timeout node=%s vmid=%s pid=%s", node, vmid, pid)
                    return {
                        'exitcode': exitcode,
                        'stdout': stdout,
                        'stderr': stderr,
                        'timed_out': True,
                    }
                raise RuntimeError("agent exec timed out")
            remaining = max(1, timeout - int(elapsed))
            wait_secs = min(remaining, 15)
            params = {'pid': pid}
            try:
                rs = s.get(status_url, params=params, timeout=wait_secs + 5)
            except requests.RequestException as exc:
                raise RuntimeError(f"agent exec-status request failed: {exc}") from exc
            if rs.status_code >= 400:
                raise RuntimeError(f"agent exec-status error {rs.status_code}: {rs.text}")
            st = rs.json().get('data', {}) if rs.content else {}

            exited_raw = st.get('exited')
            exited = _coerce_bool(exited_raw, default=False)
            status = ''
            try:
                status = str(st.get('status') or '').strip().lower()
            except Exception:
                status = ''
            running_flag = _coerce_bool(st.get('running'), default=True)
            exitcode_raw = st.get('exitcode')
            exitcode = None
            if exitcode_raw not in (None, ''):
                try:
                    exitcode = int(str(exitcode_raw).strip())
                except Exception:
                    try:
                        exitcode = int(float(str(exitcode_raw).strip()))
                    except Exception:
                        exitcode = None

            done = exited or not running_flag
            if status and status not in {'', 'running'}:
                done = True
            if exitcode is not None and status in {'success', 'error', 'failed', 'stopped', 'done'}:
                done = True

            if done:
                stdout = st.get('out-data') or ''
                stderr = st.get('err-data') or ''
                try:
                    stdout = stdout if isinstance(stdout, str) else str(stdout)
                except Exception:
                    stdout = ''
                try:
                    stderr = stderr if isinstance(stderr, str) else str(stderr)
                except Exception:
                    stderr = ''
                logger.info(
                    "guest agent exec complete node=%s vmid=%s pid=%s status=%s exitcode=%s",
                    node,
                    vmid,
                    pid,
                    status or '',
                    exitcode,
                )
                return {
                    'exitcode': exitcode,
                    'stdout': stdout,
                    'stderr': stderr
                }

            _t.sleep(1)

    def agent_file_read(
        self,
        node: str,
        vmid: int,
        path: str,
        offset: int = 0,
        count: int = 4 * 1024 * 1024,
        decode: bool = False,
        legacy: bool = False,
    ) -> Dict[str, Any]:
        """Read a file chunk through the Proxmox QEMU guest-agent API."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/nodes/{node}/qemu/{vmid}/agent/file-read"
        params = {'file': str(path)}
        if not legacy:
            params.update({
                'offset': max(0, int(offset)),
                'count': max(1, int(count)),
                'decode': 1 if decode else 0,
            })
        response = s.get(url, params=params, timeout=60)
        if response.status_code >= 400:
            raise RuntimeError(f"Proxmox guest agent file-read error {response.status_code}: {response.text}")
        data = response.json().get('data', {}) if response.content else {}
        return data if isinstance(data, dict) else {}

    def ensure_guest_agent_ready(self, node: str, vmid: int, timeout: int = 10) -> None:
        """Verify that the QEMU guest agent is available for the VM.

        Raises GuestAgentUnavailableError when the agent is not installed or reachable,
        and RuntimeError for other HTTP or transport failures.
        """
        logger = self._logger
        logger.info("guest agent readiness exec start node=%s vmid=%s", node, vmid)
        try:
            result = self.agent_exec(
                node=node,
                vmid=vmid,
                command=['ping', '-c', '1', '127.0.0.1'],
                shell=False,
                timeout=max(5, timeout)
            )
        except RuntimeError as exc:
            message = str(exc)
            lowered = message.lower()
            if any(token in lowered for token in ('guest agent', 'not running', 'not available', 'not implemented', '501')):
                logger.warning("guest agent exec readiness failed node=%s vmid=%s message=%s", node, vmid, message)
                raise GuestAgentUnavailableError(message or "Guest agent is not available") from exc
            logger.error("guest agent exec readiness error node=%s vmid=%s error=%s", node, vmid, exc)
            raise

        exitcode = result.get('exitcode')
        if exitcode not in (0, None):
            stderr_txt = (result.get('stderr') or '').strip()
            logger.warning(
                "guest agent exec readiness ping exitcode=%s node=%s vmid=%s stderr=%s",
                exitcode,
                node,
                vmid,
                stderr_txt,
            )
            raise GuestAgentUnavailableError(
                f"Guest agent ping command exited with {exitcode}: {stderr_txt or 'no output'}"
            )
        logger.info("guest agent readiness exec success node=%s vmid=%s", node, vmid)

    # --- Users and Pools ---
    def get_user(self, userid: str) -> Optional[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/users/{requests.utils.quote(userid, safe='')}"
        r = s.get(url, timeout=15)
        if r.status_code == 404:
            return None
        # The standard Proxmox API does not implement GET on the single-user
        # endpoint on some versions (405/501). Fall back to the supported user
        # listing endpoint and filter it, as we also do for version-specific
        # 400/500 responses for a missing user.
        if r.status_code in (400, 405, 500, 501):
            url_list = f"{self.base_url.rstrip('/')}/api2/json/access/users"
            rl = s.get(url_list, params={ 'full': 1 }, timeout=20)
            if rl.status_code >= 400:
                raise RuntimeError(f"Proxmox get user (fallback) error {rl.status_code}: {rl.text}")
            try:
                wanted = str(userid)
                for u in (rl.json().get('data') or []):
                    if (u or {}).get('userid') == wanted:
                        return u
            except Exception:
                pass
            return None
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox get user error {r.status_code}: {r.text}")
        return r.json().get('data')

    def create_user(self, userid: str, password: Optional[str] = None, enable: bool = True, expire: Optional[int] = None, comment: Optional[str] = None):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/users"
        data: Dict[str, Any] = { 'userid': userid }
        if password is not None:
            data['password'] = password
        if enable is not None:
            data['enable'] = 1 if enable else 0
        if expire is not None:
            data['expire'] = int(expire)
        if comment:
            data['comment'] = comment
        r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            # 409 conflict if exists
            if r.status_code != 409:
                raise RuntimeError(f"Proxmox create user error {r.status_code}: {r.text}")
        return True

    def delete_user(self, userid: str):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/users/{requests.utils.quote(userid, safe='')}"
        r = s.delete(url, timeout=30)
        if r.status_code >= 400 and r.status_code != 404:
            raise RuntimeError(f"Proxmox delete user error {r.status_code}: {r.text}")
        return True

    def update_user(self, userid: str, password: Optional[str] = None, enable: Optional[bool] = None, expire: Optional[int] = None, comment: Optional[str] = None):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/users/{requests.utils.quote(userid, safe='')}"
        data: Dict[str, Any] = {}
        if password is not None:
            data['password'] = password
        if enable is not None:
            data['enable'] = 1 if enable else 0
        if expire is not None:
            data['expire'] = int(expire)
        if comment is not None:
            data['comment'] = comment
        r = s.put(url, data=data, timeout=30)
        if r.status_code in (405, 501):
            r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox update user error {r.status_code}: {r.text}")
        return True

    def get_role(self, roleid: str) -> Optional[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/roles/{requests.utils.quote(roleid, safe='')}"
        r = s.get(url, timeout=15)
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
             # Fallback to listing if direct get not supported/authorized
             url_list = f"{self.base_url.rstrip('/')}/api2/json/access/roles"
             rl = s.get(url_list, timeout=20)
             if rl.status_code < 400:
                 try:
                     wanted = str(roleid)
                     for role in (rl.json().get('data') or []):
                         if (role or {}).get('roleid') == wanted:
                             return role
                 except Exception:
                     pass
             return None
        return r.json().get('data')

    def create_role(self, roleid: str, privileges: List[str]):
        """Create a new role with the given privileges."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/roles"
        data: Dict[str, Any] = {'roleid': roleid}
        if privileges:
            data['privs'] = ",".join(privileges)
        r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            if r.status_code != 409: # 409 Conflict means already exists
                raise RuntimeError(f"Proxmox create role error {r.status_code}: {r.text}")
        return True

    def get_pool(self, poolid: str) -> Optional[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/pools/{requests.utils.quote(poolid, safe='')}"
        r = s.get(url, timeout=15)
        if r.status_code == 404:
            return None
        # Some versions may return 400/500 on non-existent pool; fall back to list and filter
        if r.status_code in (400, 500):
            url_list = f"{self.base_url.rstrip('/')}/api2/json/pools"
            rl = s.get(url_list, timeout=20)
            if rl.status_code >= 400:
                raise RuntimeError(f"Proxmox get pool (fallback) error {rl.status_code}: {rl.text}")
            try:
                target = str(poolid)
                for p in (rl.json().get('data') or []):
                    if (p or {}).get('poolid') == target:
                        return p
            except Exception:
                pass
            return None
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox get pool error {r.status_code}: {r.text}")
        return r.json().get('data')

    def list_pools(self) -> List[Dict[str, Any]]:
        """List pools.

        Used by refresh endpoints to avoid N per-instance get_pool() calls.
        """
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/pools"
        r = s.get(url, timeout=20)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox list pools error {r.status_code}: {r.text}")
        return list(r.json().get('data') or [])

    def create_pool(self, poolid: str, comment: Optional[str] = None):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/pools"
        data: Dict[str, Any] = { 'poolid': poolid }
        if comment:
            data['comment'] = comment
        r = s.post(url, data=data, timeout=30)
        if r.status_code >= 400:
            if r.status_code != 409:
                raise RuntimeError(f"Proxmox create pool error {r.status_code}: {r.text}")
        return True

    def delete_pool(self, poolid: str):
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/pools/{requests.utils.quote(poolid, safe='')}"
        r = s.delete(url, timeout=30)
        if r.status_code >= 400 and r.status_code != 404:
            raise RuntimeError(f"Proxmox delete pool error {r.status_code}: {r.text}")
        return True

    def list_pool_members(self, poolid: str) -> List[Dict[str, Any]]:
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/pools/{requests.utils.quote(poolid, safe='')}"
        r = s.get(url, timeout=15)
        if r.status_code == 404:
            return []
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox get pool error {r.status_code}: {r.text}")
        data = r.json().get('data') or {}
        return list(data.get('members') or [])

    def add_pool_member(self, poolid: str, vmid: int):
        """Add a VM to a pool by PUT-ing to the pool resource with a 'vms' field.
        If the VM is already in the pool, raise a clear error message rather than a generic HTTP error.
        """
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/pools/{requests.utils.quote(poolid, safe='')}"
        data = { 'vms': int(vmid) }
        try:
            logging.getLogger(__name__).debug(f"add_pool_member: PUT {url} data={data}")
        except Exception:
            pass
        r = s.put(url, data=data, timeout=30)
        try:
            logging.getLogger(__name__).debug(f"add_pool_member: -> {r.status_code}")
        except Exception:
            pass
        # Treat success and known duplicate statuses as success
        if r.status_code < 400 or r.status_code == 409:
            return True
        # If the server returns an error, check if the VM is already a member and report clearly
        try:
            members = self.list_pool_members(poolid) or []
            for m in members:
                try:
                    if str(m.get('type','')).lower() == 'qemu' and int(m.get('vmid')) == int(vmid):
                        raise RuntimeError("VM already in pool")
                except Exception:
                    continue
        except Exception:
            # ignore membership-check errors and fall through to generic error below
            pass
        # Attempt to detect duplicate message hints in body
        msg_low = (r.text or '').lower()
        if any(k in msg_low for k in ('already', 'exists', 'duplicate')):
            return True
        raise RuntimeError(f"Proxmox add pool member error {r.status_code}: {r.text}")

    def remove_pool_member(self, poolid: str, vmid: int):
        """Remove a member from a pool using PUT on the pool resource with delete=1 and vmid.
        Some servers may not support this (501)."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/pools/{requests.utils.quote(poolid, safe='')}"
        params = { 'delete': int(1), 'vms': int(vmid) }
        try:
            logging.getLogger(__name__).debug(f"remove_pool_member: PUT {url} params={params}")
        except Exception:
            pass
        r = s.put(url, params=params, timeout=30)
        try:
            logging.getLogger(__name__).debug(f"remove_pool_member: -> {r.status_code}")
        except Exception:
            pass
        if r.status_code < 400 or r.status_code == 404:
            return True
        raise RuntimeError(f"Proxmox remove pool member error {r.status_code}: {r.text}")

    def set_acl_user_pool(self, userid: str, poolid: str, roles: str = 'PVEVMUser', propagate: bool = True):
        """Grant the given roles to a user on a pool path. Uses PUT per API spec (with POST fallback)."""
        return self.set_acl(userid=userid, path=f"/pool/{poolid}", roles=roles, propagate=propagate)

    def set_acl(self, userid: str, path: str, roles: str = 'PVEVMUser', propagate: bool = True):
        """Generic ACL setter using PUT (per Proxmox API). Falls back to POST if PUT not accepted.
        Parameters mirror pvesh set /access/acl.
        """
        import logging as _logging
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/acl"
        norm_path = path if str(path).startswith('/') else f"/{path}"
        data: Dict[str, Any] = {
            'path': norm_path,
            'users': userid,
            'roles': roles,
            'propagate': 1 if propagate else 0,
        }
        def _interpret(resp):
            if resp.status_code < 400:
                # Downgrade to debug unless explicit ACL_DEBUG enabled
                if getattr(__import__('flask').current_app, 'config', {}).get('ACL_DEBUG'):
                    _logging.getLogger(__name__).info(f"set_acl: success user={userid} path={norm_path} roles={roles} via {method}")
                else:
                    _logging.getLogger(__name__).debug(f"set_acl: success user={userid} path={norm_path} via {method}")
                return True
            msg_low = (resp.text or '').lower()
            if resp.status_code == 400 and any(k in msg_low for k in ('already', 'exists', 'duplicate')):
                if getattr(__import__('flask').current_app, 'config', {}).get('ACL_DEBUG'):
                    _logging.getLogger(__name__).info(f"set_acl: duplicate treated success user={userid} path={norm_path} via {method}")
                else:
                    _logging.getLogger(__name__).debug(f"set_acl: duplicate treated success user={userid} path={norm_path} via {method}")
                return True
            if resp.status_code == 501:
                raise RuntimeError(f"ACL endpoint returned 501 (possible permission/method issue) path={norm_path} body={resp.text}")
            if resp.status_code == 403:
                raise RuntimeError(f"ACL permission denied user={userid} path={norm_path} body={resp.text}")
            raise RuntimeError(f"Proxmox set ACL error {resp.status_code} user={userid} path={norm_path}: {resp.text}")
        # Try PUT first
        method = 'PUT'
        try:
            _logging.getLogger(__name__).debug(f"set_acl: {method} {url} data={data}")
        except Exception:
            pass
        r = s.put(url, data=data, timeout=30)
        if r.status_code in (405, 500) and 'put' in (r.text or '').lower():  # fallback heuristic
            method = 'POST'
            try:
                _logging.getLogger(__name__).debug(f"set_acl: fallback POST {url} data={data}")
            except Exception:
                pass
            r = s.post(url, data=data, timeout=30)
        return _interpret(r)

    def delete_acl(self, userid: str, path: str, roles: str = 'PVEVMUser', propagate: bool = True):
        """Delete/remove an ACL assignment (PUT delete=1; POST fallback)."""
        import logging as _logging
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/acl"
        norm_path = path if str(path).startswith('/') else f"/{path}"
        data: Dict[str, Any] = {
            'path': norm_path,
            'users': userid,
            'roles': roles,
            'propagate': 1 if propagate else 0,
            'delete': 1,
        }
        method = 'PUT'
        try:
            _logging.getLogger(__name__).debug(f"delete_acl: {method} {url} data={data}")
        except Exception:
            pass
        r = s.put(url, data=data, timeout=30)
        if r.status_code in (405, 500) and 'put' in (r.text or '').lower():
            method = 'POST'
            try:
                _logging.getLogger(__name__).debug(f"delete_acl: fallback POST {url} data={data}")
            except Exception:
                pass
            r = s.post(url, data=data, timeout=30)
        if r.status_code < 400:
            return True
        msg_low = (r.text or '').lower()
        if r.status_code == 400 and any(k in msg_low for k in ('no such', 'not found', 'does not exist', 'already')):
            return True
        if r.status_code == 501:
            raise RuntimeError(f"ACL delete 501 (permission/method) path={norm_path} body={r.text}")
        if r.status_code == 403:
            raise RuntimeError(f"ACL delete permission denied path={norm_path} body={r.text}")
        raise RuntimeError(f"Proxmox delete ACL error {r.status_code} path={norm_path}: {r.text}")

    def delete_acl_user_pool(self, userid: str, poolid: str, roles: str = 'PVEVMUser', propagate: bool = True):
        return self.delete_acl(userid, f"/pool/{poolid}", roles=roles, propagate=propagate)

    def list_acls(self) -> List[Dict[str, Any]]:
        """List all ACL entries."""
        s = self._ensure_session()
        url = f"{self.base_url.rstrip('/')}/api2/json/access/acl"
        r = s.get(url, timeout=20)
        if r.status_code >= 400:
            raise RuntimeError(f"Proxmox list ACLs error {r.status_code}: {r.text}")
        return r.json().get('data', []) or []

    def delete_all_acls_for_path(self, path: str):
        """Delete all ACL entries (users and groups) for a given path using PUT delete=1 (POST fallback)."""
        import logging as _logging
        s = self._ensure_session()
        norm_path = path if str(path).startswith('/') else f"/{path}"
        try:
            entries = self.list_acls()
        except Exception:
            return False
        url = f"{self.base_url.rstrip('/')}/api2/json/access/acl"
        ok_any = False
        for e in entries:
            try:
                if str(e.get('path') or '') != norm_path:
                    continue
                payload: Dict[str, Any] = {
                    'path': norm_path,
                    'roles': e.get('roleid') or 'PVEVMUser',
                    'propagate': 1 if (e.get('propagate') in (1, True, '1', 'true')) else 0,
                    'delete': 1,
                }
                t = (e.get('type') or '').lower()
                ugid = e.get('ugid') or ''
                if t == 'group':
                    payload['groups'] = ugid
                else:
                    payload['users'] = ugid
                method = 'PUT'
                r = s.put(url, data=payload, timeout=30)
                if r.status_code in (405, 500) and 'put' in (r.text or '').lower():
                    method = 'POST'
                    r = s.post(url, data=payload, timeout=30)
                if r.status_code < 400:
                    ok_any = True
                else:
                    msg_low = (r.text or '').lower()
                    if r.status_code == 400 and any(k in msg_low for k in ('no such', 'not found', 'does not exist')):
                        continue
                    _logging.getLogger(__name__).warning(f"delete_all_acls_for_path: failed method={method} path={norm_path} entry={ugid} status={r.status_code}")
            except Exception:
                continue
        return ok_any

    def set_acl_user_vm(self, userid: str, vmid: int, roles: str = 'PVEVMUser', propagate: bool = True):
        """Grant roles on a specific VM path as a fallback when pool ACLs are unsupported."""
        # Attempt with canonical path; if fails with 501 retry alternative path variant
        vm_path = f"/vms/{int(vmid)}"
        try:
            return self.set_acl(userid, vm_path, roles=roles, propagate=propagate)
        except RuntimeError as e:
            es = str(e)
            if '501' in es and 'vms' in vm_path:
                alt_path = f"vms/{int(vmid)}"  # no leading slash variant
                try:
                    return self.set_acl(userid, alt_path, roles=roles, propagate=propagate)
                except Exception:
                    raise
            raise

    def delete_acl_user_vm(self, userid: str, vmid: int, roles: str = 'PVEVMUser', propagate: bool = True):
        """Remove roles on a specific VM path for a user (revokes per-VM access)."""
        vm_path = f"/vms/{int(vmid)}"
        try:
            return self.delete_acl(userid, vm_path, roles=roles, propagate=propagate)
        except RuntimeError as e:
            es = str(e)
            if '501' in es and 'vms' in vm_path:
                alt_path = f"vms/{int(vmid)}"  # no leading slash variant
                try:
                    return self.delete_acl(userid, alt_path, roles=roles, propagate=propagate)
                except Exception:
                    raise
            raise
