import os
import io
import json
import zipfile
import uuid
import time
import random
import socket
import secrets
import string
import logging
import copy
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Blueprint, request, jsonify, current_app, send_from_directory, send_file
import re
import hashlib
import mimetypes
from urllib.parse import urlparse, urlunparse
from werkzeug.utils import secure_filename
from urllib.parse import urlsplit
import threading
from datetime import datetime, timedelta
import time
def _safe_sleep(sec: float):
    try:
        if sec and sec > 0:
            time.sleep(sec)
    except Exception:
        pass
# ...existing code...
AGEING_LOCK = threading.Lock()
AGEING_APPLIED = {}  # key: node -> set of bridge names ensured in interfaces.new

SECURE_IFACE_RE = re.compile(r'^[A-Za-z0-9_-]{1,15}$')

# VM refresh performance caching
_VM_CONFIG_CACHE = {}  # {f"{node}:{vmid}": (timestamp, config_dict)}
_POOL_CACHE = {}  # {poolid: (timestamp, set_of_vmids)}
_CACHE_TTL_SECONDS = 60  # Cache VM configs for 60 seconds

def _get_cached_vm_config(client, node: str, vmid: int, force_refresh: bool = False):
    """Get VM config with caching for performance"""
    cache_key = f"{node}:{vmid}"
    now = datetime.now()
    
    if not force_refresh and cache_key in _VM_CONFIG_CACHE:
        cached_time, cached_cfg = _VM_CONFIG_CACHE[cache_key]
        if now - cached_time < timedelta(seconds=_CACHE_TTL_SECONDS):
            return cached_cfg
    
    # Fetch fresh from Proxmox
    cfg = client.get_qemu_config(node=node, vmid=int(vmid))
    _VM_CONFIG_CACHE[cache_key] = (now, cfg)
    return cfg

def _clear_vm_cache(project_id=None):
    """Clear cached VM data (call after create/delete/clone operations)"""
    global _VM_CONFIG_CACHE, _POOL_CACHE
    if project_id:
        # Could implement project-specific clearing if needed
        pass
    else:
        _VM_CONFIG_CACHE.clear()
        _POOL_CACHE.clear()

# --- Simple in-process job tracking helpers (re-added after cleanup) ---
# Several endpoints call _start_job/_end_job and allow cancellation via a shared
# _ACTIVE_JOBS registry. Earlier refactors removed these helpers which caused
# NameError exceptions. We restore lightweight, thread-safe versions here.
_ACTIVE_JOBS = {}
_JOB_LOCK = threading.Lock()

def _job_key(pid: str) -> str:
    return f"job:{pid}"

def _start_job(pid: str, action: str):
    """Register a new job for a project. If a prior job exists, mark it finished.
    Only a single active job per pid is tracked (simple model)."""
    try:
        with _JOB_LOCK:
            key = _job_key(pid)
            prev = _ACTIVE_JOBS.get(key)
            if prev and prev.get('status') not in ('completed','cancelled','error'):
                prev['status'] = 'completed'
            _ACTIVE_JOBS[key] = {
                'id': uuid.uuid4().hex,
                'action': action,
                'status': 'running',
                'started': time.time(),
                'progress': 0,
                'cancel': False,
                'log': [],
                # Extended progress metadata for richer UI progress bars
                'phase': 'init',           # high-level phase label (e.g., preflight, cloning, networking, exporting)
                'step': 0,                 # current step number within phase
                'total_steps': 0,          # total steps expected in current phase
                'current': '',             # current item name (vm, file, bridge, etc.)
                'message': 'Starting…',    # human readable status line
                'eta': None,               # optional estimated seconds remaining (float)
            }
    except Exception:
        pass

def _update_job_detail(pid: str, **fields):
    """Lightweight helper to atomically update extended job detail fields.
    Accepts keys: phase, step, total_steps, current, message, progress, eta.
    Silently ignores unknown fields or errors."""
    allowed = {'phase','step','total_steps','current','message','progress','eta'}
    try:
        with _JOB_LOCK:
            rec = _ACTIVE_JOBS.get(_job_key(pid))
            if not rec:
                return
            for k,v in fields.items():
                if k in allowed and v is not None:
                    rec[k] = v
            _ACTIVE_JOBS[_job_key(pid)] = rec
    except Exception:
        pass

def _end_job(pid: str, status: str = 'completed'):
    try:
        with _JOB_LOCK:
            rec = _ACTIVE_JOBS.get(_job_key(pid))
            if rec and not rec.get('cancel'):
                if rec.get('status') == 'running':
                    rec['status'] = status
    except Exception:
        pass

def _cancel_job(pid: str):
    try:
        with _JOB_LOCK:
            rec = _ACTIVE_JOBS.get(_job_key(pid))
            if rec:
                rec['cancel'] = True
                rec['status'] = 'cancelled'
    except Exception:
        pass

def _is_cancelled(pid: str) -> bool:
    try:
        rec = _ACTIVE_JOBS.get(_job_key(pid))
        return bool(rec and rec.get('cancel'))
    except Exception:
        return False

def _validate_iface(name: str) -> str:
    n = str(name or '').strip()
    if not SECURE_IFACE_RE.fullmatch(n):
        raise ValueError(f'invalid iface name: {n!r}')
    return n

from ..connectors.proxmox import ProxmoxClient
from ..connectors.ctfd import CTFdClient, CTFdError
from ..storage.projects import ProjectStore, Project

api_bp = Blueprint("api", __name__)

"""Security helpers:
_secure_route now layers (1) session auth (if enabled) and (2) optional API key for mutating requests.
For authorization, an optional roles list can be provided; user must have at least one required role.
"""
def _secure_route(required_roles=None, api_key=True):
    from functools import wraps
    required_roles = set([r.lower() for r in (required_roles or [])])
    def deco(func):
        @wraps(func)
        def inner(*args, **kwargs):
            # Session auth first (if enabled)
            try:
                app = current_app._get_current_object()
                if app.config.get('AUTH_ENABLE'):
                    cur = getattr(app, 'current_user', lambda: None)() if hasattr(app, 'current_user') else None
                    if not cur:
                        return jsonify({'error': 'authentication required'}), 401
                    if required_roles:
                        have = {r.lower() for r in cur.get('roles', [])}
                        if not (have & required_roles):
                            return jsonify({'error': 'forbidden'}), 403
            except Exception:
                pass
            # API key enforcement (legacy quick-win) – only if configured and flag enabled
            if api_key:
                try:
                    key = current_app.config.get('API_KEY')
                except Exception:
                    key = None
                if key:
                    supplied = request.headers.get('X-API-Key') or request.args.get('api_key')
                    if supplied != key:
                        return jsonify({'error': 'invalid or missing API key'}), 401
            return func(*args, **kwargs)
        return inner
    return deco
@api_bp.after_request
def _api_no_store(resp):
    try:
        # Extra safety against stale caches on API responses
        resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
    except Exception:
        pass
    return resp


def _safe_file_stem(name: str) -> str:
    """Return a filesystem-safe stem from a display name: letters, numbers, _, - only."""
    try:
        stem = re.sub(r"[^A-Za-z0-9_-]+", "_", str(name or "").strip())
        stem = re.sub(r"_+", "_", stem).strip('_')
        return stem or "project"
    except Exception:
        return "project"

def _format_ymdhms(dt):
    try:
        return dt.strftime('%Y%m%d_%H%M%S')
    except Exception:
        return '00000000_000000'

def _parse_iso_datetime(s: str):
    try:
        import datetime as _dt
        if s.endswith('Z'):
            s = s.replace('Z', '+00:00')
        return _dt.datetime.fromisoformat(s)
    except Exception:
        return None


def _iter_project_audio_clips(proj: Project):
    """Yield (key, index, name, bytes, mime) for each valid audio clip on the project."""
    try:
        audio_map = getattr(proj, 'audio', {}) or {}
    except Exception:
        audio_map = {}
    if not isinstance(audio_map, dict):
        return
    for raw_key, entry in audio_map.items():
        if not isinstance(entry, dict):
            continue
        sounds = entry.get('sounds')
        if not isinstance(sounds, list):
            continue
        for idx, sound in enumerate(sounds):
            if not isinstance(sound, dict):
                continue
            data_url = sound.get('dataUrl')
            if not isinstance(data_url, str):
                continue
            mime, raw_bytes = ProjectStore._decode_data_url(data_url)
            if not raw_bytes:
                continue
            try:
                name = str(sound.get('name') or '').strip()
            except Exception:
                name = ''
            yield (raw_key, idx, name, raw_bytes, mime)


def _write_project_audio_to_zip(zf: zipfile.ZipFile, proj: Project) -> int:
    """Write audio clips (if any) to the provided zip file. Returns clips written."""
    written = set()
    total = 0
    try:
        raw_pid = getattr(proj, 'id', '') or 'project'
    except Exception:
        raw_pid = 'project'
    safe_pid = secure_filename(str(raw_pid)) or 'project'
    for raw_key, idx, display_name, raw_bytes, mime in _iter_project_audio_clips(proj):
        try:
            safe_key = secure_filename(str(raw_key or 'event')) or 'event'
        except Exception:
            safe_key = 'event'
        try:
            safe_name = secure_filename(str(display_name or ''))
        except Exception:
            safe_name = ''
        base_root, ext = os.path.splitext(safe_name) if safe_name else ('', '')
        if not base_root:
            base_root = f"clip_{idx + 1}"
        if not ext:
            guessed = mimetypes.guess_extension(mime or '') or ''
            if guessed == '.jpe':  # normalize common alias
                guessed = '.jpg'
            ext = guessed
        if ext and not ext.startswith('.'):
            ext = f".{ext}"
        if not ext:
            ext = '.bin'
        base_root = secure_filename(base_root) or f"clip_{idx + 1}"
        arc_dir = f"materials/audio/{safe_pid}/{safe_key}"
        filename = f"{base_root}{ext}"
        arcname = f"{arc_dir}/{filename}"
        suffix = 2
        while arcname in written:
            arcname = f"{arc_dir}/{base_root}_{suffix}{ext}"
            suffix += 1
        zf.writestr(arcname, raw_bytes)
        written.add(arcname)
        total += 1
    return total
@api_bp.route("/proxmox/verify", methods=["POST"])
@_secure_route()
def proxmox_verify_global():
    """Verify Proxmox API and SSH with provided credentials, without tying to a project.
    Request JSON: { baseUrl, apiPort, sshPort, verifySSL, username, password }
    Response JSON: { ok, proxmox_ok, ssh_ok, proxmox_error?, ssh_error? }
    """
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    base_url = (body.get('baseUrl') or '').strip()
    api_port = body.get('apiPort')
    ssh_port = body.get('sshPort', 22)
    verify_ssl = bool(body.get('verifySSL')) if ('verifySSL' in body) else True
    username = body.get('username') or None
    password = body.get('password') or None
    # Normalize baseUrl with apiPort
    try:
        if api_port is not None and str(api_port).strip() != '':
            p = urlparse(base_url)
            host = p.hostname or ''
            scheme = p.scheme or 'https'
            netloc = host
            if p.username:
                auth = p.username
                if p.password:
                    auth += f":{p.password}"
                netloc = f"{auth}@{netloc}"
            netloc = f"{netloc}:{int(api_port)}"
            base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    prox_ok = False
    ssh_ok = False
    prox_err = None
    ssh_err = None
    # API
    try:
        token = None
        client = ProxmoxClient(base_url=base_url, token=token, username=username, password=password, verify=verify_ssl)
        _ = client.list_nodes()
        prox_ok = True
    except Exception as e:
        prox_err = f"{e}"
    # SSH
    try:
        host = ''
        try:
            host = urlparse(base_url).hostname or ''
        except Exception:
            host = ''
        ssh_user = None
        try:
            if username:
                ssh_user = str(username).split('@')[0]
        except Exception:
            ssh_user = username
        ssh_port_i = int(ssh_port or 22)
        if not (host and ssh_user and password):
            raise RuntimeError("missing host/user/password for ssh test")
        import paramiko  # type: ignore
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(hostname=host, port=ssh_port_i, username=ssh_user, password=password, timeout=8, allow_agent=False, look_for_keys=False)
        try:
            _stdin, stdout, _stderr = c.exec_command('pwd', timeout=5)
            _ = stdout.read()
            ssh_ok = True
        finally:
            try:
                c.close()
            except Exception:
                pass
    except Exception as e:
        ssh_err = f"{e}"
    ok = bool(prox_ok and ssh_ok)
    resp = { 'ok': ok, 'proxmox_ok': bool(prox_ok), 'ssh_ok': bool(ssh_ok) }
    if prox_err: resp['proxmox_error'] = prox_err
    if ssh_err: resp['ssh_error'] = ssh_err
    return jsonify(resp)


@api_bp.route("/projects/<pid>/proxmox/verify", methods=["POST"])
@_secure_route()
def proxmox_verify(pid: str):
    """Verify connectivity to Proxmox API and SSH using provided credentials/ports.
    Request JSON: { baseUrl, apiPort, sshPort, verifySSL, username, password }
    Response JSON: { ok, proxmox_ok, ssh_ok, proxmox_error?, ssh_error? }
    """
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    base_url = (body.get('baseUrl') or getattr(proj, 'proxmox_url', '') or '').strip()
    api_port = body.get('apiPort', getattr(proj, 'proxmox_api_port', 8006))
    ssh_port = body.get('sshPort', getattr(proj, 'proxmox_ssh_port', 22))
    verify_ssl = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    username = body.get('username') or None
    password = body.get('password') or None

    # Normalize/override port on base_url
    try:
        if api_port is not None:
            p = urlparse(base_url)
            host = p.hostname or ''
            scheme = p.scheme or 'https'
            netloc = host
            if p.username:
                auth = p.username
                if p.password:
                    auth += f":{p.password}"
                netloc = f"{auth}@{netloc}"
            netloc = f"{netloc}:{int(api_port)}"
            base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass

    prox_ok = False
    ssh_ok = False
    prox_err = None
    ssh_err = None

    # Verify Proxmox API
    try:
        # If explicit username/password are provided, prefer them over any saved API token
        saved_token = getattr(proj, 'proxmox_api_token', '') or None
        token = None if (username and password) else saved_token
        client = ProxmoxClient(base_url=base_url, token=token, username=username, password=password, verify=verify_ssl)
        # list_nodes is a light-weight call that exercises auth
        _ = client.list_nodes()
        prox_ok = True
    except Exception as e:
        prox_err = f"{e}"

    # Verify SSH connectivity (best-effort)
    try:
        # Determine host: prefer API host
        host = ''
        try:
            host = urlparse(base_url).hostname or ''
        except Exception:
            host = ''
        # Map Proxmox username like 'root@pam' -> system user 'root'
        ssh_user = None
        try:
            if username:
                ssh_user = str(username).split('@')[0]
        except Exception:
            ssh_user = username
        ssh_port_i = int(ssh_port or 22)
        if not (host and ssh_user and password):
            raise RuntimeError("missing host/user/password for ssh test")
        try:
            import paramiko  # type: ignore
        except Exception as e:
            raise RuntimeError(f"ssh unavailable (paramiko not installed): {e}")
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(hostname=host, port=ssh_port_i, username=ssh_user, password=password, timeout=8, allow_agent=False, look_for_keys=False)
            try:
                # very quick no-op: print working directory
                _stdin, stdout, _stderr = c.exec_command('pwd', timeout=5)
                _ = stdout.read()
                ssh_ok = True
            finally:
                c.close()
        except socket.timeout:
            raise RuntimeError("ssh timeout")
        except Exception as e:
            raise RuntimeError(f"ssh error: {e}")
    except Exception as e:
        ssh_err = f"{e}"

    ok = bool(prox_ok and ssh_ok)
    resp = { 'ok': ok, 'proxmox_ok': bool(prox_ok), 'ssh_ok': bool(ssh_ok) }
    if prox_err: resp['proxmox_error'] = prox_err
    if ssh_err: resp['ssh_error'] = ssh_err
    return jsonify(resp)
@api_bp.route("/projects/<pid>/instances/refresh/vm", methods=["POST"])
@_secure_route()
def instances_refresh_vm(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    # Start with project-configured URL and allow overrides from request
    base_url = proj.proxmox_url
    verify = getattr(proj, 'proxmox_verify_ssl', True)
    token = getattr(proj, 'proxmox_api_token', '')
    # Allow session-sent credentials (preferred) or fall back to saved token
    data = {}
    try:
        data = request.get_json(force=True) or {}
    except Exception:
        data = {}
    username = data.get('username') or None
    password = data.get('password') or None
    body_base = (data.get('baseUrl') or '').strip()
    body_port = data.get('apiPort')
    if 'verifySSL' in (data or {}):
        verify = bool(data.get('verifySSL'))
    # Apply baseUrl/apiPort overrides if provided
    if body_base:
        base_url = body_base
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                # Rebuild netloc with username/password if present
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    if not base_url or (not token and not (username and password)):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    instances = int(proj.instances or 0)
    tag = str(proj.tag or '')
    tag_clean = tag.strip()
    tag_clean = tag.strip()
    vms = proj.vms or []
    # Build expected VM descriptors per instance: each item has expected name and/or vmid
    expected = {}
    for i in range(1, instances + 1):
        suffix = f"{tag_clean}{i}"
        exp = []
        for vm in vms:
            vm_name = getattr(vm, 'name', '') or ''
            cfg_vmid = getattr(vm, 'vmid', None)
            # Determine if this VM is expected to be user-accessible (pool member eligible)
            try:
                viewable = bool(getattr(vm, 'viewable_to_user')) if hasattr(vm, 'viewable_to_user') else bool((vm or {}).get('viewable_to_user'))
            except Exception:
                viewable = False
            # Only include specs where either a name or vmid is provided
            spec_name = f"{vm_name}{suffix}" if vm_name else None
            spec_vmid = int(cfg_vmid) if (cfg_vmid is not None and str(cfg_vmid).strip() != '') else None
            if spec_name or spec_vmid is not None:
                exp.append({ 'name': spec_name, 'vmid': spec_vmid, 'viewable': bool(viewable) })
        expected[i] = exp
    client = ProxmoxClient(base_url=base_url, token=token or None, username=username, password=password, verify=verify)
    try:
        t_start = time.time()
        nodes = client.list_nodes()
        
        # Build maps of name -> details, vmid -> name, and lowercase-name -> canonical name
        name_map = {}
        id_map = {}
        lower_name_to_canon = {}
        
        # PERFORMANCE OPTIMIZATION: Fetch VMs from all nodes in parallel
        def _fetch_node_vms(node_info):
            """Helper to fetch VMs from a single node (for parallel execution)"""
            node = node_info.get('node') or node_info.get('id') or ''
            if not node:
                return (node, [], None)
            try:
                # Create a new client instance for thread safety (sessions aren't thread-safe)
                thread_client = ProxmoxClient(base_url=base_url, token=token or None, username=username, password=password, verify=verify)
                qemus = thread_client.list_qemu_vms(node)
                return (node, qemus, None)
            except Exception as e:
                return (node, [], e)
        
        # Execute node fetching in parallel (typically 2-4 nodes, but can be more)
        with ThreadPoolExecutor(max_workers=min(len(nodes), 8)) as executor:
            futures = [executor.submit(_fetch_node_vms, n) for n in nodes]
            
            for future in as_completed(futures):
                node, qemus, error = future.result()
                if error:
                    logging.warning(f"Could not list VMs on node {node}: {error}")
                    continue
                
                # Build maps (same logic as before, now with parallel-fetched data)
                for q in qemus:
                    name = (q.get('name') or q.get('vmid'))
                    if not name:
                        continue
                    vmid_val = int(q.get('vmid')) if q.get('vmid') is not None else None
                    if vmid_val is not None:
                        id_map[vmid_val] = str(q.get('name') or vmid_val)
                    canon = str(name)
                    name_map[canon] = {
                        'node': node,
                        'vmid': vmid_val,
                        'state': q.get('status') or q.get('qmpstatus') or ''
                    }
                    lower_name_to_canon[canon.lower()] = canon
        
        t_fetch = time.time()
        logging.info(f"VM refresh: node fetching took {(t_fetch-t_start)*1000:.0f}ms for {len(nodes)} nodes")
    except Exception as e:
        return jsonify({"error": f"Proxmox: {e}"}), 502

    # Helper: extract network adaptor identifiers from VM config
    def _extract_nets(cfg: dict):
        nets = []
        try:
            for k, v in (cfg or {}).items():
                ks = str(k)
                if not ks.startswith('net'):
                    continue
                label = ''
                if isinstance(v, str):
                    parts = [p.strip() for p in v.split(',') if p]
                    name = next((p.split('=',1)[1] for p in parts if p.startswith('name=')), '')
                    bridge = next((p.split('=',1)[1] for p in parts if p.startswith('bridge=')), '')
                    label = name or bridge or ''
                nets.append(f"{ks}({label})" if label else ks)
        except Exception:
            pass
        return nets

    # Update statuses
    current = { int((e or {}).get('index', 0)): e for e in (proj.instance_statuses or []) }
    out = []
    for i in range(1, instances + 1):
        entry = current.get(i) or { 'index': i, 'created': False, 'managers': {} }
        mgrs = entry.get('managers') or {}
        names = expected[i]
        # Mark created if all expected VM names exist; partial -> pending
        count = 0
        found_details = []
        for spec in names:
            # Match clones by their expected name; do NOT match by configured template VMID
            matched = None
            spec_vmid = spec.get('vmid')
            spec_name = spec.get('name')
            matched = name_map.get(spec_name)
            canon_name = spec_name
            # Fallback: case-insensitive match on VM name
            if not matched and spec_name:
                lc = lower_name_to_canon.get(str(spec_name).lower())
                if lc:
                    matched = name_map.get(lc)
                    canon_name = lc
            if matched:
                count += 1
                vmid = matched.get('vmid')
                node = matched.get('node')
                nets = []
                tmpl_id = None
                tmpl_name = ''
                try:
                    if node and vmid is not None:
                        # Use cached config for performance
                        cfg = _get_cached_vm_config(client, node, vmid)
                        nets = _extract_nets(cfg)
                        # Try to detect clone template from disk config (best-effort)
                        try:
                            if cfg.get('template'):
                                tmpl_id = vmid
                                tmpl_name = str(name_map.get(canon_name, {}).get('name', ''))
                            else:
                                # Detect base template from disk config. Note: these prefixes refer to DISK device keys
                                # (virtio/scsi/ide/sata), not NIC models. NIC default model is handled elsewhere and set to e1000.
                                for ck, cv in (cfg or {}).items():
                                    cks = str(ck)
                                    if not any(cks.startswith(p) for p in ('virtio', 'scsi', 'ide', 'sata')):
                                        continue
                                    if isinstance(cv, str) and 'base=' in cv:
                                        # Look for base=vm-<id>-disk
                                        m = re.search(r"base=vm-(\d+)-disk", cv)
                                        if m:
                                            try:
                                                tmpl_id = int(m.group(1))
                                                tmpl_name = id_map.get(tmpl_id, '')
                                                break
                                            except Exception:
                                                pass
                                # If we didn't detect from config (full clone), use configured expectation
                                if tmpl_id is None and tmpl_name == '':
                                    try:
                                        # Find spec for this detail
                                        if spec_name:
                                            for sp in names:
                                                if sp.get('name') == spec_name:
                                                    if sp.get('vmid') is not None:
                                                        tmpl_id = int(sp['vmid'])
                                                        tmpl_name = id_map.get(tmpl_id, '') or ''
                                                    else:
                                                        # Use configured base name (strip tag+index suffix from spec_name)
                                                        try:
                                                            base_tn = spec_name
                                                            suf = f"{tag_clean}{i}"
                                                            if base_tn and suf and base_tn.endswith(suf):
                                                                base_tn = base_tn[:len(base_tn)-len(suf)]
                                                            tmpl_name = base_tn or ''
                                                        except Exception:
                                                            tmpl_name = (spec_name or '')
                                                    break
                                    except Exception:
                                        pass
                        except Exception:
                            pass
                except Exception:
                    nets = []
                found_details.append({
                    'name': canon_name,
                    'vmid': vmid,
                    'state': matched.get('state') or '',
                    'nets': nets,
                    'node': node,
                    'template_id': tmpl_id,
                    'template_name': tmpl_name,
                })
        if count == len(names) and len(names) > 0:
            mgrs['vm'] = 'created'
            entry['created'] = True
        elif count > 0:
            mgrs['vm'] = 'pending'
            entry['created'] = False
        else:
            mgrs['vm'] = 'missing'
            entry['created'] = False
        entry['managers'] = mgrs
        # For preview, show names we expect (fall back to vmid if name absent)
        entry['preview_vm_names'] = [ (sp.get('name') or f"#{sp.get('vmid')}") for sp in names ]
        entry['vm_details'] = found_details
        # Determine pools status and membership completeness for this instance based on credential username
        try:
            creds = list(getattr(proj, 'credentials', []) or [])
            urec = creds[i-1] if i-1 < len(creds) else None
            uname = (urec or {}).get('username') or ''
            poolid = re.sub(r"[^A-Za-z0-9_-]+", "", str(uname))
            if poolid:
                try:
                    pool_exists = bool(client.get_pool(poolid) is not None)
                    mgrs['pools'] = 'ready' if pool_exists else 'missing'
                    # Compute membership details when pool exists
                    if pool_exists:
                        # All configured VMs for this instance count toward expected pool membership (reverted logic)
                        names_viewable = list(names)
                        member_vmids = set()
                        list_error = False
                        try:
                            members = client.list_pool_members(poolid) or []
                            for m in members:
                                try:
                                    if str(m.get('type') or '').lower() == 'qemu' and m.get('vmid') is not None:
                                        member_vmids.add(int(m.get('vmid')))
                                except Exception:
                                    continue
                        except Exception:
                            list_error = True
                        # Fallback: infer via VM config 'pool' field if list failed or returned none
                        if (list_error or not member_vmids) and found_details:
                            try:
                                # Build map of vmid->node for quick lookup
                                vm_node_map = {}
                                for fd in found_details:
                                    try:
                                        if fd.get('vmid') is not None and fd.get('node'):
                                            vm_node_map[int(fd['vmid'])] = fd['node']
                                    except Exception:
                                        continue
                                for vmid, node in vm_node_map.items():
                                    try:
                                        # Use cached config for performance
                                        cfg = _get_cached_vm_config(client, node, int(vmid))
                                        if str(cfg.get('pool') or '') == poolid:
                                            member_vmids.add(int(vmid))
                                    except Exception:
                                        continue
                            except Exception:
                                pass
                        # Total expected VMs for this instance (all VMs here)
                        total_expected = len(names_viewable)
                        # Count of expected VMs that both exist and are in the pool
                        in_count = 0
                        for spec in names_viewable:
                            try:
                                spec_name = spec.get('name') or ''
                                # Match found_details to spec_name to get vmid (if created)
                                fd = next((d for d in found_details if str(d.get('name') or '') == spec_name), None)
                                if fd and fd.get('vmid') is not None and int(fd.get('vmid')) in member_vmids:
                                    in_count += 1
                            except Exception:
                                continue
                        mgrs['pools_member_total'] = total_expected
                        mgrs['pools_member_count'] = in_count
                        # If nothing is expected, consider it satisfied (green)
                        if total_expected == 0:
                            mgrs['pools_member_state'] = 'all'
                        elif in_count == total_expected:
                            mgrs['pools_member_state'] = 'all'
                        else:
                            # Pool exists but not all configured VMs are members yet
                            mgrs['pools_member_state'] = 'partial'
                except Exception:
                    mgrs['pools'] = 'error'
        except Exception:
            pass
        out.append(entry)
    proj.instance_statuses = out
    s.upsert(proj)
    
    # Log total refresh time for performance monitoring
    t_end = time.time()
    logging.info(f"VM refresh for project {pid} completed in {(t_end-t_start)*1000:.0f}ms")
    
    return jsonify({ 'instance_statuses': out })


@api_bp.route("/projects/<pid>/instances/actions/create", methods=["POST"])
def instances_create(pid: str):
    _start_job(pid, 'create')
    # Clear VM cache since we're creating new VMs
    _clear_vm_cache(pid)
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    # Credentials from body (session) or stored token
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    # Apply apiPort override if provided
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []  # [{ index:int, name:str }]
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    global_linked = bool(getattr(proj, 'proxmox_use_linked_clones', True))

    # Build expected names map for validation and adaptor suffixing
    tag = str(proj.tag or '')
    tag_clean = tag.strip()
    vms_cfg = proj.vms or []
    # Map base name -> VMConfig (case-insensitive helper)
    cfg_map = { getattr(v, 'name', ''): v for v in vms_cfg }
    cfg_map_lc = { str(getattr(v, 'name', '')).lower(): v for v in vms_cfg }

    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)

    # Enumerate cluster VMs by name (case-insensitive) and by vmid
    try:
        nodes = client.list_nodes()
    except Exception as e:
        return jsonify({"error": f"Proxmox: {e}"}), 502
    cluster = []
    for n in nodes:
        node = n.get('node') or n.get('id') or ''
        if not node: continue
        try:
            for q in client.list_qemu_vms(node):
                cluster.append({
                    'node': node,
                    'name': str(q.get('name') or ''),
                    'vmid': int(q.get('vmid')) if q.get('vmid') is not None else None,
                    'template': q.get('template')
                })
        except Exception:
            continue
    name_bucket = {}
    by_id = {}
    existing_names_lc = set()
    for e in cluster:
        if e['vmid'] is not None: by_id[e['vmid']] = e
        key = e['name'].lower()
        if key: name_bucket.setdefault(key, []).append(e)
        if e['name']:
            existing_names_lc.add(e['name'].lower())

    results = []
    skipped = []
    errors = []
    ambiguous_out = []
    bridges_to_reload = set()
    network_applied_nodes = []
    network_apply_errors = []
    # Track bridges created in this batch to avoid re-warn when we reencounter them
    created_bridges = set()  # set of (node, iface)
    notices = []
    # Optional: record vmid retry attempts to surface in response
    vmid_retry_info = []
    # Precompute API host for SSH fallback
    try:
        _api_host_for_ssh = urlparse(base_url).hostname or ''
    except Exception:
        _api_host_for_ssh = ''
    # Helper: SSH exec on a node to run a command (used for post-bridge edits)
    def _ssh_exec(host: str, port: int, username: str, password: str, command: str):
        try:
            import paramiko  # type: ignore
        except Exception as e:
            raise RuntimeError(f"ssh unavailable (paramiko not installed): {e}")
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(hostname=host, port=int(port or 22), username=username, password=password, timeout=10, allow_agent=False, look_for_keys=False)
            try:
                stdin, stdout, stderr = client.exec_command(command, timeout=15)
                out = stdout.read().decode('utf-8', errors='ignore')
                err = stderr.read().decode('utf-8', errors='ignore')
                code = stdout.channel.recv_exit_status()
                return { 'code': code, 'out': out, 'err': err }
            finally:
                client.close()
        except socket.timeout:
            raise RuntimeError("ssh timeout")
        except Exception as e:
            raise RuntimeError(f"ssh error: {e}")
    # Helper: resolve which host to SSH into
    def _resolve_ssh_host(node_name: str) -> str:
        # 1) Explicit override host
        try:
            override = getattr(proj, 'proxmox_ssh_host', '') or ''
            if override:
                return str(override)
        except Exception:
            pass
        # 2) Node -> host mapping
        try:
            mapping = dict(getattr(proj, 'proxmox_node_host_map', {}) or {})
            if node_name and node_name in mapping and mapping[node_name]:
                return str(mapping[node_name])
        except Exception:
            pass
        # 3) If node name resolves locally, use it
        try:
            if node_name:
                socket.getaddrinfo(node_name, None)
                return node_name
        except Exception:
            pass
        # 4) Fallback to API host if present (prefer resolvable)
        try:
            if _api_host_for_ssh:
                try:
                    socket.getaddrinfo(_api_host_for_ssh, None)
                    return _api_host_for_ssh
                except Exception:
                    return _api_host_for_ssh
        except Exception:
            pass
        # 5) Last resort: return node name as-is (may fail)
        return node_name or _api_host_for_ssh or ''
    # Helper: process a single target clone (used by thread pool)
    def process_target(t):
        # Parse input
        try:
            idx = int(t.get('index'))
            base_name = str(t.get('name') or '')
        except Exception:
            return ('error', None, { 'error': 'Invalid target entry' })
        # Normalize base name if a generated name was passed
        try:
            if base_name and tag_clean:
                suffix = f"{tag_clean}{idx}"
                if base_name.endswith(suffix):
                    base_name = base_name[:len(base_name)-len(suffix)]
        except Exception:
            pass
        cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
        if not cfg:
            # Try stripping numeric index or mapping generated name back to config
            try:
                idx_str = str(idx)
                if base_name.endswith(idx_str):
                    cand = base_name[:len(base_name)-len(idx_str)]
                    cfg = cfg_map.get(cand) or cfg_map_lc.get(cand.lower())
            except Exception:
                pass
        if not cfg and tag_clean:
            try:
                for v in vms_cfg:
                    b = getattr(v, 'name', '') or ''
                    if b and (b + f"{tag_clean}{idx}") == str(t.get('name') or ''):
                        cfg = v
                        base_name = b
                        break
            except Exception:
                pass
        if not cfg:
            return ('error', None, { 'index': idx, 'name': base_name, 'reason': 'unknown base name' })
        base_name = getattr(cfg, 'name', base_name) or base_name
        # Locate template source
        if getattr(cfg, 'vmid', None) is not None:
            src = by_id.get(int(cfg.vmid))
            if not src:
                return ('fatal', None, { 'error': f'Template VMID {cfg.vmid} not found in Proxmox' })
        else:
            candidates = name_bucket.get(base_name.lower(), [])
            if len(candidates) == 0:
                return ('error', None, { 'index': idx, 'name': base_name, 'reason': 'template not found' })
            if len(candidates) > 1:
                return ('ambig', None, {
                    'index': idx,
                    'name': base_name,
                    'candidates': [ { 'vmid': int(c.get('vmid')) if c.get('vmid') is not None else None, 'node': c.get('node') } for c in candidates if c.get('vmid') is not None ]
                })
            src = candidates[0]
        node = src['node']
        src_vmid = src['vmid']
        newname = f"{base_name}{tag_clean}{idx}"
        try:
            if newname and newname.lower() in existing_names_lc:
                return ('skip', { 'index': idx, 'name': newname }, None)
        except Exception:
            pass
        # Clone with randomized VMID and retries
        use_linked = getattr(cfg, 'use_linked_clone', None)
        if use_linked is None:
            use_linked = bool(getattr(proj, 'proxmox_use_linked_clones', True))
        # Enhanced heuristic: treat as template for linked-clone eligibility if:
        #  - Proxmox marks template flag OR
        #  - There are existing snapshots OR
        #  - Disk config suggests a base/linked image reference
        try:
            raw_template_flag = bool(src.get('template') in (1, '1', True, 'true'))
        except Exception:
            raw_template_flag = False
        snapshots_present = False
        linked_like_disk = False
        if use_linked:
            try:
                snaps = client.list_qemu_snapshots(node=node, vmid=src_vmid) or []
                snapshots_present = len(snaps) > 0
            except Exception:
                snapshots_present = False
            try:
                cfg_src_full = client.get_qemu_config(node=node, vmid=src_vmid) or {}
                for k,v in (cfg_src_full or {}).items():
                    ks = str(k)
                    if ks.startswith(('scsi','ide','sata','virtio')):
                        val = str(v)
                        if 'base-' in val or re.search(r"\bvm-\d+-disk-\d+\.qcow2", val):
                            linked_like_disk = True
                            break
            except Exception:
                pass
        src_is_effective_template = raw_template_flag or snapshots_present or linked_like_disk
        if use_linked and not src_is_effective_template:
            # Defer downgrade until after first failed attempt (allow Proxmox to decide). Keep flag for attempt.
            try:
                debug_msgs.append(f"linked-clone heuristic: source lacks template indicators (vmid={src_vmid}); will attempt linked; may fallback if Proxmox rejects")
            except Exception:
                pass
        storage_vol = getattr(cfg, 'storage_volume', None) or getattr(proj, 'proxmox_storage_volume', None)
        timeout_sec = int(getattr(cfg, 'clone_timeout_sec', None) or getattr(proj, 'proxmox_clone_timeout_seconds', 1800))
        def do_clone_with_id(chosen_id: int, full_clone: bool):
            return client.clone_qemu(node=node, vmid=src_vmid, newid=chosen_id, name=newname, storage=(None if not full_clone else (storage_vol or None)), full=(1 if full_clone else 0) or bool(full_clone))
        attempts = []
        vmid_attempts = attempts
        newid = None
        fallback_full_used = False
        for _ in range(6):
            if _is_cancelled(pid):
                return ('error', None, { 'index': idx, 'name': newname, 'reason': 'cancelled' })
            candidate = random.randint(10000, 999999)
            attempts.append(candidate)
            if candidate in by_id:
                continue
            try:
                # Attempt linked clone first if requested; rely on Proxmox to error if invalid
                upid = do_clone_with_id(candidate, full_clone=(not use_linked))
                client._wait_task(node, upid, timeout=timeout_sec)
                newid = candidate
                break
            except Exception as e1:
                if use_linked:
                    # Record the failure of linked attempt
                    try:
                        debug_msgs.append(f"linked clone attempt failed for {newname} vmid_candidate={candidate}: {e1}")
                    except Exception:
                        pass
                    try:
                        upid = do_clone_with_id(candidate, full_clone=True)
                        client._wait_task(node, upid, timeout=timeout_sec)
                        newid = candidate
                        fallback_full_used = True
                        try:
                            debug_msgs.append(f"fallback: performed full clone instead of linked for {newname} vmid={candidate}")
                        except Exception:
                            pass
                        break
                    except Exception as e2:
                        msg = f"{e1} | {e2}".lower()
                        if ('already exist' in msg) or ('config' in msg and 'exists' in msg) or ('conflict' in msg):
                            continue
                        return ('error', None, { 'index': idx, 'name': newname, 'reason': f'clone failed: linked clone failed: {e1}; full clone failed: {e2}', 'vmid_attempts': attempts })
                else:
                    msg = str(e1).lower()
                    if ('already exist' in msg) or ('config' in msg and 'exists' in msg) or ('conflict' in msg):
                        continue
                    return ('error', None, { 'index': idx, 'name': newname, 'reason': f'clone failed: {e1}', 'vmid_attempts': attempts })
        if newid is None:
            vmid_retry_info.append({ 'index': idx, 'name': newname, 'attempts': attempts, 'success': False })
            return ('error', None, { 'index': idx, 'name': newname, 'reason': 'vmid conflict or clone failed after retries', 'vmid_attempts': attempts })
        vmid_retry_info.append({ 'index': idx, 'name': newname, 'attempts': attempts, 'success': True, 'vmid': newid })
        try:
            existing_names_lc.add(newname.lower())
        except Exception:
            pass
        # Networking deferred: only record expected bridge names; creation & NIC assignment happen post-clone
        debug_msgs = []
        adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or [])
        expected_bridges_for_vm = []
        for i, a in enumerate(adaptors):
            try:
                base = re.sub(r"[^A-Za-z]", "", str(a or ""))[:8]
                bname = f"{base}{idx}" if base else f"br{idx}"
                if len(bname) > 15:
                    bname = bname[:15]
            except Exception:
                bname = f"br{idx}"
            expected_bridges_for_vm.append(bname)
        post_errors = []  # will accumulate only pool/acl errors now
        # Optional post-clone snapshot
        try:
            skip_snap = getattr(cfg, 'skip_post_clone_snapshot', None)
            if skip_snap is None:
                skip_snap = bool(getattr(proj, 'proxmox_skip_post_clone_snapshot', False))
            if not skip_snap:
                supid = client.snapshot_qemu(node=node, vmid=newid, snapname='post-clone', description='Auto snapshot after clone')
                client._wait_task(node, supid, timeout=900)
        except Exception as e:
            return ('post', { 'index': idx, 'name': newname, 'vmid': newid, 'node': node, 'vmid_attempts': vmid_attempts }, { 'index': idx, 'name': newname, 'reason': f'snapshot failed: {e}', 'vmid_attempts': vmid_attempts })
        # Pool membership: add ALL VMs to pool; ACL only per-VM for user-accessible VMs (no pool ACL grants)
        assignment_info = {}
        try:
            # Determine user-accessible flag from base config
            viewable = False
            try:
                if isinstance(cfg, dict):
                    viewable = bool(cfg.get('viewable_to_user'))
                else:
                    viewable = bool(getattr(cfg, 'viewable_to_user', False))
            except Exception:
                viewable = False
            creds = list(getattr(proj, 'credentials', []) or [])
            urec = creds[idx-1] if idx-1 < len(creds) else None
            uname = (urec or {}).get('username') or ''
            if uname:
                poolid = re.sub(r"[^A-Za-z0-9_-]+", "", str(uname))
                userid = f"{uname}@pve"
                pool_exists = False
                try:
                    pool_exists = bool(client.get_pool(poolid) is not None)
                except Exception as e:
                    post_errors.append({ 'index': idx, 'name': newname, 'reason': f'pool lookup failed: {e}' })
                if pool_exists:
                    # Attempt to add VM to pool (retry + fallback)
                    try:
                        debug_msgs.append(f"add_pool_member: attempting pool={poolid} vmid={int(newid)}")
                    except Exception:
                        pass
                    try:
                        client.add_pool_member(poolid, int(newid))
                        assignment_info['pool'] = poolid
                        assignment_info['pool_member_added'] = True
                        try:
                            debug_msgs.append(f"add_pool_member: success pool={poolid} vmid={int(newid)}")
                        except Exception:
                            pass
                    except Exception as e:
                        msg = str(e)
                        do_retry = ('not found' in msg.lower()) or ('no such' in msg.lower()) or ('does not exist' in msg.lower())
                        if do_retry:
                            try:
                                _safe_sleep(2)
                                try:
                                    debug_msgs.append(f"add_pool_member: retrying pool={poolid} vmid={int(newid)} after transient error")
                                except Exception:
                                    pass
                                client.add_pool_member(poolid, int(newid))
                                assignment_info['pool'] = poolid
                                assignment_info['pool_member_added'] = True
                                try:
                                    debug_msgs.append(f"add_pool_member: success (after retry) pool={poolid} vmid={int(newid)}")
                                except Exception:
                                    pass
                            except Exception as e2:
                                msg2 = str(e2)
                                if ' 501' in msg2 or 'not implemented' in msg2.lower():
                                    try:
                                        client.set_qemu_options(node=node, vmid=int(newid), options={ 'pool': poolid })
                                        assignment_info['pool'] = poolid
                                        assignment_info['pool_member_added'] = True
                                        try:
                                            debug_msgs.append(f"fallback:set_qemu_options pool={poolid} vmid={int(newid)} -> success")
                                        except Exception:
                                            pass
                                    except Exception as e3:
                                        try:
                                            debug_msgs.append(f"fallback:set_qemu_options pool={poolid} vmid={int(newid)} -> failed: {e3}")
                                        except Exception:
                                            pass
                                        post_errors.append({ 'index': idx, 'name': newname, 'reason': f'pool members endpoint unsupported and VM-config fallback failed: {e3}' })
                                else:
                                    try:
                                        debug_msgs.append(f"add_pool_member: failed pool={poolid} vmid={int(newid)}: {e2}")
                                    except Exception:
                                        pass
                                    post_errors.append({ 'index': idx, 'name': newname, 'reason': f'add pool member failed: {e2}' })
                        else:
                            if ' 501' in msg or 'not implemented' in msg.lower():
                                try:
                                    client.set_qemu_options(node=node, vmid=int(newid), options={ 'pool': poolid })
                                    assignment_info['pool'] = poolid
                                    assignment_info['pool_member_added'] = True
                                    try:
                                        debug_msgs.append(f"fallback:set_qemu_options pool={poolid} vmid={int(newid)} -> success")
                                    except Exception:
                                        pass
                                except Exception as e3:
                                    try:
                                        debug_msgs.append(f"fallback:set_qemu_options pool={poolid} vmid={int(newid)} -> failed: {e3}")
                                    except Exception:
                                        pass
                                    post_errors.append({ 'index': idx, 'name': newname, 'reason': f'pool members endpoint unsupported and VM-config fallback failed: {e3}' })
                            else:
                                try:
                                    debug_msgs.append(f"add_pool_member: failed pool={poolid} vmid={int(newid)}: {e}")
                                except Exception:
                                    pass
                                post_errors.append({ 'index': idx, 'name': newname, 'reason': f'add pool member failed: {e}' })
                # ACLs: apply only for user-accessible (viewable) VMs; skip otherwise
                try:
                    if uname and viewable:
                        try:
                            if current_app.config.get('ACL_DEBUG'):
                                current_app.logger.info(f"[create][ACL] checking (user-accessible) user={userid} for vmid={newid} name={newname}")
                        except Exception:
                            pass
                        user_rec = client.get_user(userid)
                        if user_rec is not None:
                            try:
                                if current_app.config.get('ACL_DEBUG'):
                                    current_app.logger.info(f"[create][ACL] applying role=PVEVMUser user={userid} vmid={newid}")
                            except Exception:
                                pass
                            try:
                                client.set_acl_user_vm(userid, int(newid), roles='PVEVMUser', propagate=True)
                                assignment_info['acl_set'] = True
                                try:
                                    debug_msgs.append(f"acl_set: user={userid} vmid={int(newid)} role=PVEVMUser")
                                except Exception:
                                    pass
                                # Verify presence in ACL list (best effort)
                                try:
                                    entries = client.list_acls() or []
                                    found = False
                                    path_variants = {f"/vms/{int(newid)}", f"vms/{int(newid)}"}
                                    for e in entries:
                                        try:
                                            if str(e.get('ugid') or '') == userid and str(e.get('path') or '') in path_variants:
                                                found = True
                                                break
                                        except Exception:
                                            continue
                                    if current_app.config.get('ACL_DEBUG'):
                                        current_app.logger.info(f"[create][ACL] verification user={userid} vmid={newid} present={found}")
                                except Exception as ve:
                                    try:
                                        if current_app.config.get('ACL_DEBUG'):
                                            current_app.logger.warning(f"[create][ACL] verification failed user={userid} vmid={newid}: {ve}")
                                    except Exception:
                                        pass
                            except Exception as e:
                                msg = str(e)
                                try:
                                    current_app.logger.error(f"[create][ACL] failed user={userid} vmid={newid}: {msg}")
                                except Exception:
                                    pass
                                if '501' in msg and 'not implemented' not in msg.lower():
                                    post_errors.append({ 'index': idx, 'name': newname, 'reason': f'ACL permission issue (501) applying user {userid}: {msg}' })
                                elif 'not implemented' in msg.lower():
                                    post_errors.append({ 'index': idx, 'name': newname, 'reason': 'ACL endpoint not implemented on this Proxmox build' })
                                else:
                                    post_errors.append({ 'index': idx, 'name': newname, 'reason': f'per-VM ACL failed: {e}' })
                        else:
                            try:
                                if current_app.config.get('ACL_DEBUG'):
                                    current_app.logger.warning(f"[create][ACL] user not found user={userid} vmid={newid}")
                            except Exception:
                                pass
                            post_errors.append({ 'index': idx, 'name': newname, 'reason': f'user {userid} not found; skipping ACL set' })
                    elif uname and not viewable:
                        try:
                            if current_app.config.get('ACL_DEBUG'):
                                current_app.logger.info(f"[create][ACL] skipping non user-accessible VM user={userid} vmid={newid} name={newname}")
                        except Exception:
                            pass
                except Exception as e:
                    try:
                        current_app.logger.error(f"[create][ACL] ACL processing failed user={userid} vmid={newid}: {e}")
                    except Exception:
                        pass
                    post_errors.append({ 'index': idx, 'name': newname, 'reason': f'ACL processing failed: {e}' })
        except Exception as e:
            post_errors.append({ 'index': idx, 'name': newname, 'reason': f'pool/acl assignment failed: {e}' })
        # Finalize
        if post_errors:
            payload = { 'index': idx, 'name': newname, 'vmid': newid, 'node': node, 'vmid_attempts': vmid_attempts, 'debug': debug_msgs, 'expected_bridges': expected_bridges_for_vm, 'fallback_full_clone': fallback_full_used }
            payload.update(assignment_info)
            return ('post', payload, post_errors)
        payload = { 'index': idx, 'name': newname, 'vmid': newid, 'node': node, 'vmid_attempts': vmid_attempts, 'debug': debug_msgs, 'expected_bridges': expected_bridges_for_vm, 'fallback_full_clone': fallback_full_used }
        payload.update(assignment_info)
        return ('ok', payload, None)

    # Pre-check: if any target's base template name is ambiguous (multiple candidates) and vmid not explicitly configured,
    # return the ambiguous list immediately WITHOUT starting any clones. This guarantees resolution happens first.
    try:
        pre_group = {}
        for t in (targets or []):
            try:
                idx = int(t.get('index'))
                incoming = str(t.get('name') or '')
            except Exception:
                continue
            base_name = incoming
            try:
                suffix = f"{tag_clean}{idx}"
                if base_name.endswith(suffix):
                    base_name = base_name[:len(base_name)-len(suffix)]
            except Exception:
                pass
            cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
            if not cfg:
                # Try mapping generated name back to a config entry
                try:
                    for v in vms_cfg:
                        b = getattr(v, 'name', '') or ''
                        if b and (b + f"{tag_clean}{idx}") == incoming:
                            cfg = v
                            base_name = b
                            break
                except Exception:
                    pass
            if not cfg:
                continue
            if getattr(cfg, 'vmid', None) is not None:
                continue  # explicit VMID disambiguates
            cands = [c for c in (name_bucket.get(base_name.lower(), []) or []) if c.get('vmid') is not None]
            if len(cands) > 1:
                seen = pre_group.setdefault(base_name, {})
                for c in cands:
                    try:
                        key = f"{int(c['vmid'])}@@{c.get('node') or ''}"
                        seen[key] = { 'vmid': int(c['vmid']), 'node': c.get('node') or '' }
                    except Exception:
                        continue
        if pre_group:
            ambiguous_out = [ { 'name': name, 'candidates': list(seen.values()) } for name, seen in pre_group.items() ]
            # Early return: no clones started
            _end_job(pid)
            return jsonify({ 'created': [], 'skipped': [], 'errors': [], 'notices': [], 'ambiguous': ambiguous_out, 'network_applied_nodes': [], 'network_apply_errors': [], 'vmid_retry_info': [] })
    except Exception:
        # If pre-check fails silently, continue; server will still avoid cloning ambiguous entries in process_target
        pass

    # Concurrency control for create jobs
    max_jobs = int(getattr(proj, 'proxmox_max_create_jobs', 20) or 1)
    if max_jobs < 1:
        max_jobs = 1
    # Schedule clones in parallel with a cap
    to_process = list(targets)
    notices = []
    # For de-duplicating warning notices across the entire batch
    notice_keys = set()
    while to_process:
        if _is_cancelled(pid):
            errors.append({'reason': 'cancelled'})
            break
        batch = to_process[:max_jobs]
        to_process = to_process[max_jobs:]
        _update_job_detail(pid, phase='cloning', message=f'Cloning batch ({len(batch)} VM(s))…', total_steps=len(targets))
        with ThreadPoolExecutor(max_workers=len(batch) or 1) as pool:
            futs = {pool.submit(process_target, t): t for t in batch}
            for fut in as_completed(futs):
                t = futs[fut]
                try:
                    kind, ok_payload, err_payload = fut.result()
                    if kind == 'ok':
                        results.append(ok_payload)
                    elif kind == 'post':
                        results.append(ok_payload)
                        if err_payload:
                            def _is_acl_issue(item):
                                try:
                                    return 'acl' in str((item or {}).get('reason', '')).lower()
                                except Exception:
                                    return False
                            def _is_bridge_exists_notice(item):
                                try:
                                    r = str((item or {}).get('reason', '')).lower()
                                    return ('bridge' in r) and (('already exists' in r) or ('not creating' in r and 'bridge' in r))
                                except Exception:
                                    return False
                            def _add_notice_once(item):
                                try:
                                    key = str((item or {}).get('reason', '')).strip() or str(item)
                                    if key not in notice_keys:
                                        notices.append(item)
                                        notice_keys.add(key)
                                except Exception:
                                    notices.append(item)
                            if isinstance(err_payload, list):
                                for it in err_payload:
                                    if _is_acl_issue(it) or _is_bridge_exists_notice(it):
                                        _add_notice_once(it)
                                    else:
                                        errors.append(it)
                            elif isinstance(err_payload, dict):
                                if _is_acl_issue(err_payload) or _is_bridge_exists_notice(err_payload):
                                    _add_notice_once(err_payload)
                                else:
                                    errors.append(err_payload)
                            else:
                                errors.append({'reason': str(err_payload)})
                    elif kind == 'skip':
                        skipped.append({'index': ok_payload['index'], 'name': ok_payload['name'], 'reason': 'already exists'})
                    elif kind == 'ambig':
                        ambiguous_out.append(err_payload)
                    elif kind == 'fatal':
                        errors.append(err_payload)
                    else:  # error
                        if err_payload:
                            errors.append(err_payload)
                except Exception as e:
                    errors.append({'reason': f'create task failed: {e}'})
                finally:
                    try:
                        done = len(results) + len(skipped) + len(errors)
                        pct = int(min(60, (done / max(len(targets), 1)) * 60))
                        _update_job_detail(pid, step=done, progress=pct, current=str(t.get('name') or ''), message=f'Cloned {done}/{len(targets)}')
                    except Exception:
                        pass

    # Post-clone networking phase: create missing bridges, ensure ageing lines in /etc/network/interfaces.new, assign NICs, then reload networks
    try:
        # 1) Aggregate required bridges per node
        bridges_needed = {}
        _update_job_detail(pid, phase='networking', message='Analyzing required bridges…')
        for r in results:
            try:
                node = r.get('node')
                if not node:
                    continue
                for b in (r.get('expected_bridges') or []):
                    if b:
                        bridges_needed.setdefault(node, set()).add(b)
            except Exception:
                continue
        # 2) For each node, create missing bridges
        for node, needed in bridges_needed.items():
            _update_job_detail(pid, phase='networking', current=node, message=f'Ensuring bridges on {node}…')
            existing = set()
            try:
                nets = client.list_network(node) or []
                for net in nets:
                    try:
                        iface = str(net.get('iface') or '')
                        if iface:
                            existing.add(iface)
                    except Exception:
                        continue
            except Exception:
                pass
            for b in sorted(needed):
                if b in existing:
                    continue
                try:
                    client.create_bridge(node=node, iface=b, autostart=True, ports=None, comments=f"Auto-created (post-clone batch)")
                    created_bridges.add((node, b))
                    bridges_to_reload.add(node)
                except Exception as e:
                    errors.append({'reason': f'bridge create failed: {b} node={node}: {e}'})
        # 3) Ensure ageing lines in /etc/network/interfaces.new for all required bridges (batch per node)
        ssh_user = (username or '').split('@')[0] if (username or '') else ''
        ssh_pass = password or ''
        ssh_port = int(getattr(proj, 'proxmox_ssh_port', 22) or 22)
        # Debug: capture why we might skip ageing script
        debug_ageing_meta = {
            'ssh_user_present': bool(ssh_user),
            'ssh_pass_present': bool(ssh_pass),
            'bridges_needed_nodes': list(bridges_needed.keys()),
        }
        if not (ssh_user and ssh_pass):
            errors.append({ 'reason': f'ageing skipped: missing ssh creds meta={debug_ageing_meta}' })
        if ssh_user and ssh_pass:
            import paramiko, shlex  # type: ignore
            for node, needed in bridges_needed.items():
                _update_job_detail(pid, phase='networking', current=node, message=f'Applying ageing settings on {node}…')
                host = _resolve_ssh_host(node)
                if not host:
                    errors.append({ 'reason': f'ageing skipped: no host for node {node}' })
                    continue
                # Validate iface names and build one script instead of N commands
                try:
                    valid_ifaces = []
                    for b in sorted(needed):
                        try:
                            valid_ifaces.append(_validate_iface(b))
                        except ValueError as ve:
                            errors.append({ 'reason': f'invalid iface skipped node={node} bridge={b}: {ve}' })
                    if not valid_ifaces:
                        continue
                    iface_list = ' '.join(valid_ifaces)
                    script_lines = [
                        'set -e',
                        'MAIN=/etc/network/interfaces',
                        'NEW=/etc/network/interfaces.new',
                        'LOG_BASE=/var/tmp/ageing_debug.log',
                        'test -w /var/tmp || LOG_BASE=/tmp/ageing_debug.log',
                        'if [ ! -f "$NEW" ]; then cp "$MAIN" "$NEW"; fi',
                        f'echo "[AGEING][BEGIN] node={node} ifaces: {iface_list}" >> "$LOG_BASE" 2>&1 || true',
                        'add_ageing() {',
                        '  FILE=$1; IFACE=$2; ADDED=0;',
                        '  grep -Eq "^iface ${IFACE} " "$FILE" || { echo "iface ${IFACE} inet manual" >> "$FILE"; ADDED=1; };',
                        "  if ! awk -v IFACE=\\\"$IFACE\\\" 'BEGIN{in=0;have=0} $1==\\\"iface\\\" { if(in && $2!=IFACE) in=0; if($2==IFACE){in=1; next} } in && ($1==\\\"bridge-ageing\\\" || $1==\\\"bridge_ageing\\\") && $2==\\\"0\\\" {have=1} END{exit(have?0:1)}' \"$FILE\" >/dev/null 2>&1; then",
                        '    if grep -Eq "bridge-ageing" "$FILE"; then',
                        '      sed -i "/^iface ${IFACE} /a\\    bridge-ageing 0" "$FILE";',
                        '    else',
                        '      sed -i "/^iface ${IFACE} /a\\    bridge_ageing 0" "$FILE";',
                        '    fi;',
                        '  fi;',
                        "  if awk -v IFACE=\\\"$IFACE\\\" 'BEGIN{in=0;ok=0} $1==\\\"iface\\\" { if(in && $2!=IFACE) in=0; if($2==IFACE){in=1; next} } in && ($1==\\\"bridge-ageing\\\" || $1==\\\"bridge_ageing\\\") && $2==\\\"0\\\" {ok=1} END{exit(ok?0:1)}' \"$FILE\"; then echo \"[AGEING] ensured ${IFACE} in $FILE (added_stanza=$ADDED)\" >> \"$LOG_BASE\"; else echo \"[AGEING] FAILED ${IFACE} in $FILE\" >> \"$LOG_BASE\"; fi;",
                        '}',
                        f'for IFACE in {iface_list}; do add_ageing "$MAIN" "$IFACE"; add_ageing "$NEW" "$IFACE"; done',
                        'for F in "$MAIN" "$NEW"; do [ -f "$F" ] || continue; echo "[AGEING][DUMP-BEGIN] $F" >> "$LOG_BASE"; grep -n "bridge[_-]ageing" "$F" >> "$LOG_BASE" 2>&1 || true; echo "[AGEING][DUMP-END] $F" >> "$LOG_BASE"; done',
                        f'echo "[AGEING][END] node={node}" >> "$LOG_BASE" 2>&1 || true'
                    ]
                    full_cmd = '\n'.join(script_lines)
                except Exception as e:
                    errors.append({ 'reason': f'ageing batch build failed node={node}: {e}' })
                    continue
                # Connect and run with retry on ChannelException
                attempts = 0
                while attempts < 3:
                    attempts += 1
                    try:
                        c = paramiko.SSHClient()
                        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                        c.connect(hostname=host, port=ssh_port, username=ssh_user, password=ssh_pass, timeout=10, allow_agent=False, look_for_keys=False)
                        try:
                            use_sudo = (str(ssh_user).strip().lower() != 'root')
                            # --- Preflight: ensure we can write log and touch marker ---
                            import time as _t
                            preflight = (
                                "LOG_BASE=/var/tmp/ageing_debug.log; "
                                "test -w /var/tmp || LOG_BASE=/tmp/ageing_debug.log; "
                                f"touch $LOG_BASE.preflight_{node} 2>/dev/null || true; "
                                "if [ -f $LOG_BASE.preflight_"+str(node)+" ]; then echo PREF_OK; else echo PREF_FAIL; fi"
                            )
                            pf_wrapped = f"sh -lc {shlex.quote(preflight)}"
                            so, se = _ssh_run_cmd(c, pf_wrapped, sudo=use_sudo, sudo_password=ssh_pass)
                            pre_ok_out = ''
                            try:
                                pre_ok_out = (so.read().decode('utf-8', errors='ignore') if so else '').strip()
                            except Exception:
                                pre_ok_out = ''
                            preflight_ok = 'PREF_OK' in pre_ok_out
                            if not preflight_ok:
                                errors.append({ 'reason': f'ageing preflight failed node={node} out={pre_ok_out!r}' })
                            fallback_used = False
                            batch_stdout = ''
                            batch_stderr = ''
                            if preflight_ok:
                                # --- Run main batch script ---
                                cmd_wrapped = f"sh -lc {shlex.quote(full_cmd)}"
                                try:
                                    so2, se2 = _ssh_run_cmd(c, cmd_wrapped, sudo=use_sudo, sudo_password=ssh_pass)
                                    try:
                                        batch_stdout = (so2.read().decode('utf-8', errors='ignore') if so2 else '')[:200]
                                        batch_stderr = (se2.read().decode('utf-8', errors='ignore') if se2 else '')[:200]
                                    except Exception:
                                        pass
                                except Exception as be:
                                    errors.append({ 'reason': f'ageing batch exec exception node={node}: {be}' })
                                    batch_stderr = str(be)
                                # --- Verify log presence & END marker ---
                                verify_cmd = (
                                    "LOG_BASE=/var/tmp/ageing_debug.log; test -w /var/tmp || LOG_BASE=/tmp/ageing_debug.log; "
                                    f"grep -q '\\[AGEING\\]\\[END\\] node={node}' $LOG_BASE 2>/dev/null && echo LOG_OK || echo LOG_MISSING"
                                )
                                v_wrapped = f"sh -lc {shlex.quote(verify_cmd)}"
                                try:
                                    vso, vse = _ssh_run_cmd(c, v_wrapped, sudo=use_sudo, sudo_password=ssh_pass)
                                    vout = ''
                                    try:
                                        vout = (vso.read().decode('utf-8', errors='ignore') if vso else '').strip()
                                    except Exception:
                                        vout = ''
                                    if 'LOG_MISSING' in vout:
                                        errors.append({ 'reason': f'ageing log missing post-batch node={node} stdout={batch_stdout!r} stderr={batch_stderr!r}' })
                                        fallback_used = True
                                except Exception as ve:
                                    errors.append({ 'reason': f'ageing verify failed node={node}: {ve}' })
                                    fallback_used = True
                            else:
                                fallback_used = True
                            # --- Legacy per-interface fallback if needed ---
                            if fallback_used:
                                for _iface in valid_ifaces:
                                    legacy_cmd = (
                                        "LOG_BASE=/var/tmp/ageing_debug.log; test -w /var/tmp || LOG_BASE=/tmp/ageing_debug.log; "
                                        "MAIN=/etc/network/interfaces; NEW=/etc/network/interfaces.new; "
                                        "[ -f $NEW ] || cp $MAIN $NEW; "
                                        f"for F in $MAIN $NEW; do [ -f $F ] || continue; grep -Eq '^iface {_iface} ' $F || echo 'iface {_iface} inet manual' >> $F; "
                                        f"awk -v IFACE='{_iface}' 'BEGIN{{in=0;found=0}} $1==\"iface\" {{ if(in && $2!=IFACE) in=0; if($2==IFACE){{in=1; next}} }} in && $1==\"bridge-ageing\" && $2==\"0\" {{found=1}} END{{exit(found?0:1)}}' $F >/dev/null 2>&1 || sed -i '/^iface {_iface} /a\\    bridge-ageing 0' $F; done; "
                                        f"echo '[LEGACY] {_iface}' >> $LOG_BASE 2>/dev/null || true"
                                    )
                                    l_wrapped = f"sh -lc {shlex.quote(legacy_cmd)}"
                                    try:
                                        _ssh_run_cmd(c, l_wrapped, sudo=use_sudo, sudo_password=ssh_pass)
                                    except Exception as le:
                                        errors.append({ 'reason': f'legacy ageing failed node={node} iface={_iface}: {le}' })
                                errors.append({ 'reason': f'ageing fallback used node={node}' })
                        finally:
                            try: c.close()
                            except Exception: pass
                        break
                    except Exception as e:
                        retryable = False
                        try:
                            from paramiko.ssh_exception import ChannelException  # type: ignore
                            if isinstance(e, ChannelException):
                                retryable = True
                        except Exception:
                            pass
                        if retryable and attempts < 3:
                            _safe_sleep(0.5 * attempts)
                            continue
                        errors.append({ 'reason': f'ageing batch insert failed node={node}: {e}' })
                        break
        # 4) Assign NICs to each VM now that bridges exist
        for r in results:
            try:
                vmid = r.get('vmid')
                node = r.get('node')
                if vmid is None or not node:
                    continue
                _update_job_detail(pid, phase='networking', current=r.get('name'), message=f'Assigning NICs for {r.get("name") or vmid}…')
                expected = list(r.get('expected_bridges') or [])
                if not expected:
                    continue
                netspecs = [f"e1000,bridge={b}" for b in expected]
                try:
                    existing_cfg = client.get_qemu_config(node=node, vmid=vmid)
                except Exception:
                    existing_cfg = {}
                delete_keys = [k for k in (existing_cfg or {}).keys() if str(k).startswith('net')]
                if delete_keys:
                    try:
                        client.set_qemu_nets(node=node, vmid=vmid, nets=[], delete_keys=delete_keys)
                    except Exception:
                        pass
                client.set_qemu_nets(node=node, vmid=vmid, nets=netspecs, delete_keys=None)
            except Exception as e:
                errors.append({'reason': f'set nets failed post-clone: {e}'})
        # 5) Reload networks on nodes where we created bridges (delayed + conditional re-run)
        #    Pre-reload verification: re-check ageing lines and log stanza excerpts
        if ssh_user and ssh_pass and bridges_needed:
            try:
                import paramiko, shlex  # type: ignore
                for node, needed in bridges_needed.items():
                    if not needed:
                        continue
                    host = _resolve_ssh_host(node)
                    if not host:
                        continue
                    try:
                        iface_list = []
                        for b in sorted(needed):
                            try:
                                iface_list.append(_validate_iface(b))
                            except Exception:
                                continue
                        if not iface_list:
                            continue
                        verify_list = ' '.join(iface_list)
                        script_lines = [
                            'set -e',
                            'MAIN=/etc/network/interfaces',
                            'NEW=/etc/network/interfaces.new',
                            'log=/var/tmp/ageing_debug.log',
                            f'echo "[AGEING-VERIFY] node={node} ifaces: {verify_list}" >> "$log" 2>&1 || true',
                            f'for IFACE in {verify_list}; do',
                            '  FILES="$MAIN"; [ -f "$NEW" ] && FILES="$FILES $NEW";',
                            '  MISSING=1',
                            '  for F in $FILES; do',
                            '    if awk -v I="$IFACE" '"'"'BEGIN{in=0;ok=0} $1=="iface" { if(in && $2!=I) in=0; if($2==I){in=1; next} } in && $1=="bridge-ageing" && $2=="0" {ok=1} END{exit(ok?0:1)}'"'"' "$F"; then MISSING=0; fi',
                            '  done',
                            '  if [ $MISSING -eq 1 ]; then',
                            '    # Re-apply into both MAIN and NEW (idempotent) if missing',
                            '    for F in $FILES; do',
                            '      grep -Eq "^iface ${IFACE} " "$F" || echo "iface ${IFACE} inet manual" >> "$F";',
                            '      awk -v IFACE="$IFACE" '"'"'BEGIN{in=0;found=0} $1=="iface" { if(in && $2!=IFACE) in=0; if($2==IFACE){in=1; next} } in && $1=="bridge-ageing" && $2=="0" {found=1} END{exit(found?0:1)}'"'"' "$F" >/dev/null 2>&1 || sed -i "/^iface ${IFACE} /a\\    bridge-ageing 0" "$F";',
                            '    done',
                            '    echo "[AGEING-VERIFY] reinsert ${IFACE}" >> "$log" 2>&1 || true',
                            '  else',
                            '    echo "[AGEING-VERIFY] present ${IFACE}" >> "$log" 2>&1 || true',
                            '  fi',
                            '  # Log the stanza excerpt (first iface line plus following lines until next iface or blank)',
                            '  for F in $FILES; do',
                            '    echo "[AGEING-STANZA-BEGIN] ${IFACE} $F" >> "$log";',
                            '    awk -v I="$IFACE" '"'"'BEGIN{in=0} $1=="iface" { if(in){exit}; if($2==I){print; in=1; next} } in { if($1=="iface"){exit}; if($0!=""){print} else {print; exit}}'"'"' "$F" >> "$log" 2>&1 || true',
                            '    echo "[AGEING-STANZA-END] ${IFACE} $F" >> "$log";',
                            '  done',
                            'done'
                        ]
                        full_cmd = '; '.join(script_lines)
                        c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                        c.connect(hostname=host, port=ssh_port, username=ssh_user, password=ssh_pass, timeout=10, allow_agent=False, look_for_keys=False)
                        try:
                            use_sudo = (str(ssh_user).strip().lower() != 'root')
                            _ssh_run_cmd(c, f"sh -lc {shlex.quote(full_cmd)}", sudo=use_sudo, sudo_password=ssh_pass)
                        finally:
                            try: c.close()
                            except Exception: pass
                    except Exception as ve:
                        network_apply_errors.append({ 'node': node, 'reason': f'ageing verify failed: {ve}' })
            except Exception:
                pass
        if bridges_to_reload:
            _safe_sleep(5)
        for node in bridges_to_reload:
            try:
                client.reload_network(node)
                network_applied_nodes.append(node)
            except Exception as e:
                network_apply_errors.append({ 'node': node, 'reason': str(e) })
        # Conditional second reload if interfaces.new still present
        if bridges_to_reload and ssh_user and ssh_pass:
            import paramiko  # type: ignore
            for node in list(bridges_to_reload):
                host = _resolve_ssh_host(node)
                if not host:
                    continue
                try:
                    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                    c.connect(hostname=host, port=ssh_port, username=ssh_user, password=ssh_pass, timeout=8, allow_agent=False, look_for_keys=False)
                except Exception:
                    continue
                try:
                    import shlex
                    check_cmd = "[ -f /etc/network/interfaces.new ] && echo NEW || echo NONE"
                    cmd_wrapped = f"sh -lc {shlex.quote(check_cmd)}"
                    use_sudo = (str(ssh_user).strip().lower() != 'root')
                    so, se = _ssh_run_cmd(c, cmd_wrapped, sudo=use_sudo, sudo_password=ssh_pass)
                    out = so.read().decode('utf-8', errors='ignore') if so else ''
                    if 'NEW' in out:
                        try:
                            client.reload_network(node)
                            if node not in network_applied_nodes:
                                network_applied_nodes.append(node)
                        except Exception as e:
                            network_apply_errors.append({ 'node': node, 'reason': f'second reload failed: {e}' })
                finally:
                    try: c.close()
                    except Exception: pass
    except Exception as e:
        errors.append({ 'reason': f'post-clone networking phase failed: {e}' })

    # After creation, verify snapshots, NICs, and bridge-ageing on nodes for created VMs
    verify_issues = []
    try:
        # Build quick lookup of created items
        created_map = {}
        for r in results:
            try:
                key = f"{int(r.get('index'))}|{str(r.get('name') or '')}"
                created_map[key] = r
            except Exception:
                pass
        for r in list(results):
                idx = int(r.get('index'))
                name = str(r.get('name') or '')
                node = str(r.get('node') or '')
                vmid = int(r.get('vmid')) if r.get('vmid') is not None else None
                if vmid is None or not node:
                    continue
                # 1) Snapshot present?
                has_snap = False
                try:
                    snaps = client.list_snapshots_qemu(node=node, vmid=vmid) or []
                    has_snap = bool(snaps)
                except Exception:
                    has_snap = False
                # 2) NICs match expected bridges?
                expected_bridges = set([str(b) for b in (r.get('expected_bridges') or [])])
                actual_bridges = set()
                nets_ok = True
                nets_retries = 0
                try:
                    cfg_now = client.get_qemu_config(node=node, vmid=vmid) or {}
                    for k, v in (cfg_now or {}).items():
                        ks = str(k)
                        if not ks.startswith('net'):
                            continue
                        if isinstance(v, str):
                            parts = [p.strip() for p in v.split(',') if p]
                            bridge = next((p.split('=',1)[1] for p in parts if p.startswith('bridge=')), '')
                            if bridge:
                                actual_bridges.add(bridge)
                    if expected_bridges:
                        nets_ok = expected_bridges.issubset(actual_bridges)
                        # If not OK, allow a couple of short retries (config may not yet be persisted)
                        import time
                        while (not nets_ok) and nets_retries < 2:
                            nets_retries += 1
                            _safe_sleep(1.0)
                            try:
                                cfg_now = client.get_qemu_config(node=node, vmid=vmid) or {}
                                actual_bridges = set()
                                for k, v in (cfg_now or {}).items():
                                    ks = str(k)
                                    if not ks.startswith('net'):
                                        continue
                                    if isinstance(v, str):
                                        parts = [p.strip() for p in v.split(',') if p]
                                        bridge = next((p.split('=',1)[1] for p in parts if p.startswith('bridge=')), '')
                                        if bridge:
                                            actual_bridges.add(bridge)
                                nets_ok = expected_bridges.issubset(actual_bridges)
                            except Exception:
                                break
                    else:
                        nets_ok = True
                except Exception:
                    nets_ok = False
                # 3) Bridge-ageing present on node config for expected bridges?
                ageing_missing = []
                ageing_debug_tokens = {}
                try:
                    ssh_user = (username or '').split('@')[0] if (username or '') else ''
                    ssh_pass = password or ''
                    ssh_port = int(getattr(proj, 'proxmox_ssh_port', 22) or 22)
                    host = _resolve_ssh_host(node)
                    if host and ssh_user and ssh_pass and expected_bridges:
                        import paramiko  # type: ignore
                        c = paramiko.SSHClient()
                        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                        c.connect(hostname=host, port=ssh_port, username=ssh_user, password=ssh_pass, timeout=10, allow_agent=False, look_for_keys=False)
                        try:
                            for b in expected_bridges:
                                try:
                                    import shlex
                                    check_cmd = ("TARGET=/etc/network/interfaces; "
                                                 "if [ -f /etc/network/interfaces.new ]; then TARGET=/etc/network/interfaces.new; fi; "
                                                 "awk -v IFACE='" + str(b) + "' 'BEGIN{in=0;found=0} "
                                                 "$1==\"iface\" && $2==IFACE {in=1; next} "
                                                 "$1==\"iface\" && in {in=0} "
                                                 "in && $1==\"bridge-ageing\" && $2==\"0\" {found=1} "
                                                 "END{if(found) print \"FOUND\"; else print \"MISS\"}' \"$TARGET\"")
                                    cmd_wrapped = f"sh -lc {shlex.quote(check_cmd)}"
                                    use_sudo = (str(ssh_user).strip().lower() != 'root')
                                    so, se = _ssh_run_cmd(c, cmd_wrapped, sudo=use_sudo, sudo_password=ssh_pass)
                                    out = so.read().decode('utf-8', errors='ignore') if so else ''
                                    # Normalize lines; awk prints either FOUND or MISS
                                    tokens = set([ln.strip() for ln in out.splitlines() if ln.strip()])
                                    ageing_debug_tokens[str(b)] = sorted(tokens)
                                    # Only treat as missing if AWK explicitly reported MISS
                                    if 'MISS' in tokens:
                                        ageing_missing.append(str(b))
                                except Exception:
                                    ageing_missing.append(str(b))
                        finally:
                            try:
                                c.close()
                            except Exception:
                                pass
                except Exception:
                    # If SSH unavailable, mark unknown ageing results as missing to allow retry option
                    ageing_missing = list(expected_bridges)
                if (not has_snap) or (not nets_ok) or (ageing_missing):
                    issue_payload = {
                        'index': idx,
                        'name': name,
                        'vmid': vmid,
                        'node': node,
                        'missing_snapshot': (not has_snap),
                        'nets_ok': bool(nets_ok),
                        'nets_expected': list(expected_bridges),
                        'nets_actual': list(actual_bridges),
                        'ageing_missing': list(ageing_missing),
                    }
                    if nets_retries:
                        issue_payload['nets_retries'] = nets_retries
                    if ageing_debug_tokens:
                        issue_payload['ageing_check_tokens'] = ageing_debug_tokens
                    verify_issues.append(issue_payload)
    except Exception:
        pass

    # Only include retry info when there were multiple attempts or failures
    vmid_retry_info_filtered = [r for r in vmid_retry_info if (not r.get('success')) or (len(r.get('attempts') or []) > 1)]
    _end_job(pid)
    _update_job_detail(pid, phase='done', message='Create completed', progress=100)
    verify_summary = {
        'missing_snapshot': sum(1 for i in verify_issues if i.get('missing_snapshot')),
        'nets_mismatch': sum(1 for i in verify_issues if not i.get('nets_ok', True)),
        'ageing_missing': sum(1 for i in verify_issues if i.get('ageing_missing')),
    }
    return jsonify({ 'created': results, 'skipped': skipped, 'errors': errors, 'notices': notices, 'ambiguous': ambiguous_out, 'network_applied_nodes': network_applied_nodes, 'network_apply_errors': network_apply_errors, 'vmid_retry_info': vmid_retry_info_filtered, 'verify': { 'issues': verify_issues, 'summary': verify_summary } })


@api_bp.route("/projects/<pid>/instances/actions/create-preflight", methods=["POST"])
def instances_create_preflight(pid: str):
    """Pre-check for ambiguous template names without starting any clone.
    Returns { ambiguous: [ { name: base_name, candidates: [ { vmid, node }, ... ] } ] }
    """
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400

    # Build helpers similar to instances_create but without mutating anything
    global_linked = bool(getattr(proj, 'proxmox_use_linked_clones', True))
    tag = str(proj.tag or '')
    tag_clean = tag.strip()
    vms_cfg = proj.vms or []
    cfg_map = { getattr(v, 'name', ''): v for v in vms_cfg }
    cfg_map_lc = { str(getattr(v, 'name', '')).lower(): v for v in vms_cfg }

    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    # Enumerate cluster VMs grouped by name (case-insensitive)
    try:
        nodes = client.list_nodes()
    except Exception as e:
        return jsonify({"error": f"Proxmox: {e}"}), 502
    name_bucket = {}
    for n in nodes:
        node = n.get('node') or n.get('id') or ''
        if not node:
            continue
        try:
            for q in client.list_qemu_vms(node):
                nm = str(q.get('name') or '')
                vmid = int(q.get('vmid')) if q.get('vmid') is not None else None
                key = nm.lower() if nm else ''
                if key and vmid is not None:
                    name_bucket.setdefault(key, []).append({ 'node': node, 'name': nm, 'vmid': vmid })
        except Exception:
            continue

    # For incoming targets, figure out the base template name as create would, and find ambiguous ones
    group = {}
    for t in targets:
        try:
            idx = int(t.get('index'))
            incoming = str(t.get('name') or '')
        except Exception:
            continue
        base_name = incoming
        try:
            suf = f"{tag_clean}{idx}"
            if base_name.endswith(suf):
                base_name = base_name[:len(base_name)-len(suf)]
        except Exception:
            pass
        cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
        if not cfg:
            # Try mapping generated name back to config
            for v in vms_cfg:
                b = getattr(v, 'name', '') or ''
                if b and (b + f"{tag_clean}{idx}") == incoming:
                    cfg = v
                    base_name = b
                    break
        if not cfg:
            continue
        # If vmid is explicitly set in config, skip (no ambiguity to resolve)
        if getattr(cfg, 'vmid', None) is not None:
            continue
        cands = name_bucket.get(base_name.lower(), [])
        if len(cands) > 1:
            seen = group.setdefault(base_name, {})
            for c in cands:
                try:
                    key = f"{int(c['vmid'])}@@{c.get('node') or ''}"
                    seen[key] = { 'vmid': int(c['vmid']), 'node': c.get('node') or '' }
                except Exception:
                    continue
    # Detect non-template linked clone cases (single candidate, not a template, but linked requested)
    # Heuristic refinement: treat a source as template if Proxmox marks it OR if it has at least one snapshot OR config explicitly sets template-like flag.
    # Also, if any disk path looks like a base-image reference (raw/qcow2 under a base/ or has 'base-' prefix), assume linked OK and do NOT warn.
    non_template_linked = []
    try:
        for t in targets:
            try:
                idx = int(t.get('index'))
                incoming = str(t.get('name') or '')
            except Exception:
                continue
            base_name = incoming
            try:
                suf = f"{tag_clean}{idx}"
                if base_name.endswith(suf):
                    base_name = base_name[:len(base_name)-len(suf)]
            except Exception:
                pass
            cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
            if not cfg:
                for v in vms_cfg:
                    b = getattr(v, 'name', '') or ''
                    if b and (b + f"{tag_clean}{idx}") == incoming:
                        cfg = v; base_name = b; break
            if not cfg:
                continue
            # Skip if explicit vmid (no ambiguity and user explicitly chose source)
            if getattr(cfg, 'vmid', None) is not None:
                # Still need to know if linked requested but that specific VM is not a template
                try:
                    vmid_explicit = int(getattr(cfg, 'vmid'))
                    src_list = []
                    for lst in name_bucket.values():
                        for c in lst:
                            if int(c.get('vmid')) == vmid_explicit:
                                src_list.append(c)
                    if src_list:
                        src = src_list[0]
                        use_linked_eff = getattr(cfg, 'use_linked_clone', None)
                        if use_linked_eff is None:
                            use_linked_eff = global_linked
                        else:
                            use_linked_eff = bool(use_linked_eff)
                        if use_linked_eff and src:
                            is_tmpl = bool(src.get('template') in (1, '1', True, 'true'))
                            # Fetch extra metadata to improve accuracy
                            try:
                                cfg_full = client.get_qemu_config(node=src.get('node'), vmid=vmid_explicit)
                            except Exception:
                                cfg_full = {}
                            # Snapshot heuristic
                            has_snapshots = False
                            try:
                                snaps = client.list_qemu_snapshots(node=src.get('node'), vmid=vmid_explicit) or []
                                has_snapshots = len(snaps) > 0
                            except Exception:
                                pass
                            # Disk heuristic: base image pattern
                            linked_like = False
                            try:
                                for k,v in (cfg_full or {}).items():
                                    if str(k).startswith('scsi') or str(k).startswith('ide') or str(k).startswith('sata') or str(k).startswith('virtio'):
                                        val = str(v)
                                        if 'base-' in val or re.search(r"\bvm-\d+-disk-\d+\.qcow2", val):
                                            linked_like = True; break
                            except Exception:
                                pass
                            if not (is_tmpl or has_snapshots or linked_like):
                                non_template_linked.append({ 'name': base_name, 'vmid': vmid_explicit, 'node': src.get('node') if src else None })
                except Exception:
                    pass
                continue
            # Without explicit vmid, gather candidates
            cands = name_bucket.get(base_name.lower(), [])
            if len(cands) == 1:
                src = cands[0]
                use_linked_eff = getattr(cfg, 'use_linked_clone', None)
                if use_linked_eff is None:
                    use_linked_eff = global_linked
                else:
                    use_linked_eff = bool(use_linked_eff)
                if use_linked_eff and src:
                    is_tmpl = bool(src.get('template') in (1, '1', True, 'true'))
                    vmid_src = src.get('vmid')
                    node_src = src.get('node')
                    # Extended heuristics for template detection
                    try:
                        cfg_full = client.get_qemu_config(node=node_src, vmid=vmid_src)
                    except Exception:
                        cfg_full = {}
                    has_snapshots = False
                    try:
                        snaps = client.list_qemu_snapshots(node=node_src, vmid=vmid_src) or []
                        has_snapshots = len(snaps) > 0
                    except Exception:
                        pass
                    linked_like = False
                    try:
                        for k,v in (cfg_full or {}).items():
                            if str(k).startswith('scsi') or str(k).startswith('ide') or str(k).startswith('sata') or str(k).startswith('virtio'):
                                val = str(v)
                                if 'base-' in val or re.search(r"\bvm-\d+-disk-\d+\.qcow2", val):
                                    linked_like = True; break
                    except Exception:
                        pass
                    if not (is_tmpl or has_snapshots or linked_like):
                        non_template_linked.append({ 'name': base_name, 'vmid': vmid_src, 'node': node_src })
    except Exception:
        pass
    ambiguous = [ { 'name': name, 'candidates': list(seen.values()) } for name, seen in group.items() ]
    return jsonify({ 'ambiguous': ambiguous, 'non_template_linked': non_template_linked })

@api_bp.route("/projects/<pid>/instances/actions/fix_ageing", methods=["POST"])
def instances_fix_ageing(pid: str):
    _start_job(pid, 'fix_ageing')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    # Helper to resolve node name to SSH host
    def _resolve_host_for_node(node_name: str) -> str:
        try:
            override = getattr(proj, 'proxmox_ssh_host', '') or ''
            if override:
                return str(override)
        except Exception:
            pass
        try:
            mapping = dict(getattr(proj, 'proxmox_node_host_map', {}) or {})
            if node_name and node_name in mapping and mapping[node_name]:
                return str(mapping[node_name])
        except Exception:
            pass
        try:
            if node_name:
                socket.getaddrinfo(node_name, None)
                return node_name
        except Exception:
            pass
        try:
            host = urlparse(base_url).hostname or ''
            if host:
                try:
                    socket.getaddrinfo(host, None)
                    return host
                except Exception:
                    return host
        except Exception:
            pass
        return node_name
    fixed = []
    # Iterate each mapped VM, gather expected bridge names, batch insert per node
    for m in mapped:
        if _is_cancelled(pid):
            break
        idx = m.get('index')
        name = m.get('name')
        node = m.get('node')
        vmid = m.get('vmid')
        # Derive expected bridges from config (same derivation as create verify step)
        expected = []
        try:
            cfg = None
            base_name = name
            try:
                tag = str(proj.tag or '').strip()
                suf = f"{tag}{idx}"
                if base_name.endswith(suf):
                    base_name = base_name[:len(base_name)-len(suf)]
            except Exception:
                pass
            for v in proj.vms or []:
                if getattr(v, 'name', '') == base_name:
                    cfg = v; break
            adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or []) if cfg else []
            for a in adaptors:
                try:
                    base = re.sub(r"[^A-Za-z]", "", str(a or ""))[:8]
                    bname = f"{base}{idx}" if base else f"br{idx}"
                    if len(bname) > 15:
                        bname = bname[:15]
                except Exception:
                    bname = f"br{idx}"
                expected.append(bname)
        except Exception:
            expected = []
        if not expected:
            fixed.append({ 'index': idx, 'name': name, 'node': node, 'vmid': vmid, 'reason': 'no expected bridges from config' })
            continue
        # SSH batch insertion
        ssh_user = (username or '').split('@')[0] if (username or '') else ''
        ssh_pass = password or ''
        ssh_port = int(getattr(proj, 'proxmox_ssh_port', 22) or 22)
        host = _resolve_host_for_node(node)
        if not (ssh_user and ssh_pass and host):
            errors.append({ 'index': idx, 'name': name, 'reason': f'ssh unavailable to node (user={ssh_user or ""} pass_present={bool(ssh_pass)} host={host or ""})' })
            continue
        try:
            import paramiko  # type: ignore
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(hostname=host, port=ssh_port, username=ssh_user, password=ssh_pass, timeout=10, allow_agent=False, look_for_keys=False)
            try:
                valid_ifaces = []
                for b in expected:
                    try:
                        valid_ifaces.append(_validate_iface(b))
                    except ValueError as ve:
                        errors.append({ 'index': idx, 'name': name, 'reason': f'invalid iface skipped: {ve}' })
                if not valid_ifaces:
                    fixed.append({ 'index': idx, 'name': name, 'node': node, 'vmid': vmid, 'reason': 'no valid bridges after validation' })
                    continue
                iface_list = ' '.join(valid_ifaces)
                script = [
                    'set -e',
                    'MAIN=/etc/network/interfaces',
                    'NEW=/etc/network/interfaces.new',
                    'TARGET=/etc/network/interfaces; [ -f /etc/network/interfaces.new ] && TARGET=/etc/network/interfaces.new',
                    'LOG_BASE=/var/tmp/ageing_debug.log; test -w /var/tmp || LOG_BASE=/tmp/ageing_debug.log',
                    f'echo "[FIX-AGEING][BEGIN] node={node} ifaces: {iface_list}" >> "$LOG_BASE" 2>&1 || true',
                    'for IFACE in ' + iface_list + '; do',
                    '  for F in "$MAIN" "$NEW"; do [ -f "$F" ] || continue; grep -Eq "^iface ${IFACE} " "$F" || echo "iface ${IFACE} inet manual" >> "$F"; done;',
                    "  for F in $MAIN $NEW; do [ -f \"$F\" ] || continue; if ! awk -v IFACE=\\\"$IFACE\\\" 'BEGIN{in=0;have=0} $1==\\\"iface\\\" { if(in && $2!=IFACE) in=0; if($2==IFACE){in=1; next} } in && ($1==\\\"bridge-ageing\\\" || $1==\\\"bridge_ageing\\\") && $2==\\\"0\\\" {have=1} END{exit(have?0:1)}' \"$F\" >/dev/null 2>&1; then if grep -Eq \"bridge-ageing\" \"$F\"; then sed -i \"/^iface $IFACE /a\\\\    bridge-ageing 0\" \"$F\"; else sed -i \"/^iface $IFACE /a\\\\    bridge_ageing 0\" \"$F\"; fi; fi; done",
                    "  for F in $MAIN $NEW; do [ -f \"$F\" ] || continue; if awk -v IFACE=\\\"$IFACE\\\" 'BEGIN{in=0;ok=0} $1==\\\"iface\\\" { if(in && $2!=IFACE) in=0; if($2==IFACE){in=1; next} } in && ($1==\\\"bridge-ageing\\\" || $1==\\\"bridge_ageing\\\") && $2==\\\"0\\\" {ok=1} END{exit(ok?0:1)}' \"$F\"; then echo \"[FIX-AGEING] ensured ${IFACE} in $F\" >> \"$LOG_BASE\"; else echo \"[FIX-AGEING] FAILED ${IFACE} in $F\" >> \"$LOG_BASE\"; fi; done",
                    'done',
                    'echo "[FIX-AGEING][DUMP-MAIN]" >> "$LOG_BASE"; grep -n "bridge[_-]ageing" "$MAIN" >> "$LOG_BASE" 2>&1 || true',
                    'echo "[FIX-AGEING][DUMP-NEW]" >> "$LOG_BASE"; [ -f "$NEW" ] && grep -n "bridge[_-]ageing" "$NEW" >> "$LOG_BASE" 2>&1 || true',
                    'echo "[FIX-AGEING][END]" >> "$LOG_BASE" 2>&1 || true'
                ]
                full_cmd = '\n'.join(script)
                import shlex
                cmd_wrapped = f"sh -lc {shlex.quote(full_cmd)}"
                use_sudo = (str(ssh_user).strip().lower() != 'root')
                attempts = 0
                while attempts < 3:
                    attempts += 1
                    try:
                        _ssh_run_cmd(c, cmd_wrapped, sudo=use_sudo, sudo_password=ssh_pass)
                        break
                    except Exception as e:
                        retryable = False
                        try:
                            from paramiko.ssh_exception import ChannelException  # type: ignore
                            if isinstance(e, ChannelException):
                                retryable = True
                        except Exception:
                            pass
                        if retryable and attempts < 3:
                            _safe_sleep(0.5 * attempts)
                            continue
                        errors.append({ 'index': idx, 'name': name, 'reason': f'ageing batch insertion failed: {e}' })
                        break
                else:
                    # Loop exhausted without break
                    pass
                fixed.append({ 'index': idx, 'name': name, 'node': node, 'vmid': vmid, 'bridges': valid_ifaces })
            finally:
                try:
                    c.close()
                except Exception:
                    pass
        except Exception as e:
            errors.append({ 'index': idx, 'name': name, 'reason': f'ssh setup failed: {e}' })
    _end_job(pid)
    return jsonify({ 'fixed': fixed, 'skipped': skipped, 'errors': errors })

@api_bp.route("/projects/<pid>/instances/actions/delete", methods=["POST"])
def instances_delete(pid: str):
    _start_job(pid, 'delete')
    # Clear VM cache since we're deleting VMs
    _clear_vm_cache(pid)
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []  # [{ index:int, name:str }] where name may be base or generated
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400

    tag = str(proj.tag or '').strip()
    vms_cfg = proj.vms or []
    # Map configured base names to VMConfig and lower-case helper
    cfg_map = { getattr(v, 'name', ''): v for v in vms_cfg }
    cfg_map_lc = { str(getattr(v, 'name', '')).lower(): v for v in vms_cfg }

    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)

    # Enumerate cluster current VMs with node and vmid, map by name (case-insensitive)
    try:
        nodes = client.list_nodes()
    except Exception as e:
        return jsonify({"error": f"Proxmox: {e}"}), 502
    name_to_info = {}
    for n in nodes:
        node = n.get('node') or n.get('id') or ''
        if not node:
            continue
        try:
            for q in client.list_qemu_vms(node):
                nm = str(q.get('name') or '')
                if nm:
                    name_to_info[nm.lower()] = { 'node': node, 'vmid': int(q.get('vmid')) if q.get('vmid') is not None else None, 'name': nm }
        except Exception:
            continue

    deleted = []
    skipped = []
    errors = []
    notices = []
    bridges_to_reload = set()
    network_applied_nodes = []
    network_apply_errors = []

    # Prepare tasks for parallel deletion
    def prepare_target(t):
        try:
            idx = int(t.get('index'))
            incoming = str(t.get('name') or '')
        except Exception:
            return ('error', { 'reason': 'Invalid target entry' })
        base_name = incoming
        try:
            suf = f"{tag}{idx}"
            if base_name.endswith(suf):
                base_name = base_name[:len(base_name)-len(suf)]
        except Exception:
            pass
        cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
        if not cfg:
            for v in vms_cfg:
                b = getattr(v, 'name', '') or ''
                if b and (b + f"{tag}{idx}") == incoming:
                    cfg = v
                    base_name = b
                    break
        if not cfg:
            return ('skip', { 'index': idx, 'name': base_name, 'reason': 'unknown base name' })
        gen_name = f"{base_name}{tag}{idx}"
        info = name_to_info.get(gen_name.lower())
        if not info or info.get('vmid') is None:
            return ('skip', { 'index': idx, 'name': gen_name, 'reason': 'not found' })
        node = info['node']
        vmid = info['vmid']
        adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or [])
        return ('ok', { 'index': idx, 'gen_name': gen_name, 'node': node, 'vmid': vmid, 'adaptors': adaptors })

    prepared = [prepare_target(t) for t in targets]
    # Accumulate pre-known skips/errors
    tasks = []
    for kind, payload in prepared:
        if kind == 'skip':
            skipped.append(payload)
        elif kind == 'error':
            errors.append(payload)
        else:
            tasks.append(payload)

    # Collect bridge deletion intents per node for bulk processing after all VM deletions
    bulk_bridge_deletions = {}

    def _record_bridge_for_cleanup(node: str, idx: int, adaptor_name: str, gen_name: str):
        try:
            base = re.sub(r"[^A-Za-z]", "", str(adaptor_name or ""))[:8]
            bname = f"{base}{idx}" if base else f"br{idx}"
            if len(bname) > 15:
                bname = bname[:15]
        except Exception:
            bname = f"br{idx}"
        bulk_bridge_deletions.setdefault(node, []).append({ 'bridge': bname, 'index': idx, 'name': gen_name, 'legacy': False })
        # Legacy hashed bridge variant
        try:
            base_old = f"{adaptor_name}|{tag}|{idx}"
            h = int(hashlib.sha1(base_old.encode('utf-8')).hexdigest()[:6], 16)
            num = 100 + (h % 8899)
            old_bname = f"vmbr{num}"
            bulk_bridge_deletions.setdefault(node, []).append({ 'bridge': old_bname, 'index': idx, 'name': gen_name, 'legacy': True })
        except Exception:
            pass

    def do_delete(task):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        idx = task['index']
        gen_name = task['gen_name']
        node = task['node']
        vmid = task['vmid']
        adaptors = task['adaptors']
        upid = client.delete_qemu(node=node, vmid=vmid, purge=True, destroy_unreferenced_disks=True)
        client._wait_task(node, upid, timeout=1200)
        # Record bridges for later deletion (post all deletions) to avoid race conditions and repeated node reloads
        for a in adaptors:
            _record_bridge_for_cleanup(node, idx, a, gen_name)
        return ({ 'index': idx, 'name': gen_name, 'vmid': vmid, 'node': node })

    with ThreadPoolExecutor(max_workers=min(len(tasks), 16) or 1) as pool:
        future_map = { pool.submit(do_delete, t): t for t in tasks }
        for fut in as_completed(future_map):
            t = future_map[fut]
            try:
                result = fut.result()
                deleted.append(result)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': t['index'], 'name': t['gen_name'], 'reason': f'delete failed: {e}' })

    # After all deletions, enumerate remaining bridges in use to avoid removing active ones, then process bulk deletions per node
    for node, items in bulk_bridge_deletions.items():
        try:
            # Determine bridges still referenced by any remaining VM on this node
            bridges_in_use = set()
            try:
                vms_remaining = client.list_qemu_vms(node) or []
                for ent in vms_remaining:
                    try:
                        r_vmid = ent.get('vmid')
                        if r_vmid is None:
                            continue
                        cfg_other = client.get_qemu_config(node=node, vmid=int(r_vmid)) or {}
                        for k,v in (cfg_other or {}).items():
                            ks = str(k)
                            if not ks.startswith('net'):
                                continue
                            if isinstance(v, str):
                                parts = [p.strip() for p in v.split(',') if p]
                                b = next((p.split('=',1)[1] for p in parts if p.startswith('bridge=')), '')
                                if b:
                                    bridges_in_use.add(b)
                    except Exception:
                        continue
            except Exception:
                bridges_in_use = set()
            # Deduplicate bridge intents per node
            seen_bridge = set()
            for entry in items:
                bname = entry['bridge']
                if bname in seen_bridge:
                    continue
                seen_bridge.add(bname)
                if bname in bridges_in_use:
                    note = { 'index': entry['index'], 'name': entry['name'], 'reason': f'bridge retained (in use) {bname}' }
                    if not any(str(n.get('reason','')) == str(note['reason']) for n in notices):
                        notices.append(note)
                    continue
                try:
                    client.delete_bridge(node=node, iface=bname)
                    bridges_to_reload.add(node)
                except Exception as e:
                    msg = str(e).lower()
                    warn = ('not exist' in msg) or ('no such' in msg) or ('not found' in msg) or (' 404' in msg)
                    item = { 'index': entry['index'], 'name': entry['name'], 'reason': f'bridge delete skipped for {bname}: does not exist' if warn else f'bridge delete failed for {bname}: {e}' }
                    if warn:
                        if not any(str(n.get('reason','')) == str(item['reason']) for n in notices):
                            notices.append(item)
                    else:
                        errors.append(item)
        except Exception as e:
            errors.append({ 'node': node, 'reason': f'bulk bridge cleanup failed: {e}' })

    # Reload networking on nodes where we changed bridges (bulk)
    for node in bridges_to_reload:
        try:
            client.reload_network(node)
            network_applied_nodes.append(node)
        except Exception as e:
            network_apply_errors.append({ 'node': node, 'reason': f'network reload failed: {e}' })

    # Post-delete verification: ensure NICs, unreferenced disks, and snapshots are removed
    verify = { 'issues': [], 'summary': { 'nets_left': 0, 'disks_left': 0, 'snaps_left': 0 } }
    try:
        # Build a quick map of remaining VMs on nodes to check lingering NIC config by name
        remaining = {}
        for n in nodes:
            try:
                node = n.get('node') or n.get('id') or ''
                if not node: continue
                for q in client.list_qemu_vms(node):
                    nm = str(q.get('name') or '')
                    if nm:
                        remaining[nm.lower()] = { 'node': node, 'vmid': int(q.get('vmid')) if q.get('vmid') is not None else None }
            except Exception:
                continue
        for d in deleted:
            idx = d.get('index'); name = str(d.get('name') or '')
            node = d.get('node'); vmid = d.get('vmid')
            # 1) NICs: VM is gone, but we also removed bridges earlier; nothing in VM config remains. We still check bridges missing from node list to be safe.
            try:
                # Verify bridges no longer exist for this index based on configured adaptors
                adaptors = []
                try:
                    cfg = cfg_map.get(name[:-len(f"{tag}{idx}")]) if name.endswith(f"{tag}{idx}") else None
                    if not cfg:
                        cfg = cfg_map_lc.get((name[:-len(f"{tag}{idx}")]).lower()) if name.endswith(f"{tag}{idx}") else None
                    adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or []) if cfg else []
                except Exception:
                    adaptors = []
                bridges_expected = []
                for a in adaptors:
                    try:
                        base = re.sub(r"[^A-Za-z]", "", str(a or ""))[:8]
                        bname = f"{base}{idx}" if base else f"br{idx}"
                        if len(bname) > 15:
                            bname = bname[:15]
                    except Exception:
                        bname = f"br{idx}"
                    bridges_expected.append(bname)
                lingering_nets = []
                try:
                    nets = client.list_network(node)
                    have = set([str(n.get('iface') or '') for n in nets])
                    for b in bridges_expected:
                        if b and b in have:
                            lingering_nets.append(b)
                except Exception:
                    pass
                if lingering_nets:
                    verify['issues'].append({ 'index': idx, 'name': name, 'node': node, 'vmid': vmid, 'nets_left': lingering_nets })
                    verify['summary']['nets_left'] += 1
            except Exception:
                pass
            # 2) Orphan disks and snapshots: query storages for this node filtered by this vmid
            try:
                disks = []
                snaps = []
                try:
                    stores = client.list_node_storages(node)
                except Exception:
                    stores = []
                for st in stores:
                    sn = str(st.get('storage') or st.get('name') or '')
                    if not sn:
                        continue
                    try:
                        cont = client.list_storage_content(node, sn, vmid=vmid)
                    except Exception:
                        cont = []
                    for it in cont:
                        try:
                            ctype = str(it.get('content') or '')
                            volid = it.get('volid')
                        except Exception:
                            continue
                        # Treat base images and disk volumes
                        if ctype in ('images', 'rootdir', 'iso', 'snippets'):
                            if str(it.get('vmid') or it.get('vmid_str') or vmid) == str(vmid):
                                if ctype == 'images':
                                    disks.append(volid or it)
                        if ctype == 'backup':
                            if str(it.get('vmid') or '') == str(vmid):
                                snaps.append(volid or it)
                if disks or snaps:
                    verify['issues'].append({ 'index': idx, 'name': name, 'node': node, 'vmid': vmid, 'disks_left': disks, 'snaps_left': snaps })
                    verify['summary']['disks_left'] += 1 if disks else 0
                    verify['summary']['snaps_left'] += 1 if snaps else 0
            except Exception:
                pass
    except Exception:
        pass

    _end_job(pid)
    return jsonify({ 'deleted': deleted, 'skipped': skipped, 'errors': errors, 'notices': notices, 'network_applied_nodes': network_applied_nodes, 'network_apply_errors': network_apply_errors, 'verify': verify })


@api_bp.route("/projects/<pid>/instances/actions/purge_leftovers", methods=["POST"])
def instances_purge_leftovers(pid: str):
    """Purge verify-reported leftovers after delete: lingering bridges and storage content (disks/backups).
    Expects body: { username,password,baseUrl,verifySSL,apiPort?, items: [{ index,name,node,vmid,nets_left?:[],disks_left?:[],snaps_left?:[] }] }
    """
    _start_job(pid, 'purge_leftovers')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    items = body.get('items') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(items, list) or not items:
        return jsonify({"error": "No items provided"}), 400

    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)

    removed_bridges = []
    removed_volumes = []
    skip = []
    errs = []
    bridges_to_reload = set()

    for it in items:
        try:
            node = str(it.get('node') or '')
            vmid = it.get('vmid')
            name = str(it.get('name') or '')
            # Remove lingering bridges
            nets_left = list(it.get('nets_left') or [])
            for b in nets_left:
                try:
                    client.delete_bridge(node=node, iface=str(b))
                    removed_bridges.append({ 'node': node, 'iface': str(b), 'name': name })
                    bridges_to_reload.add(node)
                except Exception as e:
                    errs.append({ 'node': node, 'name': name, 'reason': f'bridge delete failed for {b}: {e}' })
            # Remove storage items (disks and backups) by volid; we must discover storage from volid prefix (storage:...)
            for kind in ('disks_left','snaps_left'):
                vols = list(it.get(kind) or [])
                for volid in vols:
                    try:
                        volid_s = str(volid)
                        # volid format: <storage>:<type>/<ident> or <storage>:backup/<file>
                        storage = volid_s.split(':',1)[0]
                        client.delete_storage_content(node=node, storage=storage, volume=volid_s)
                        removed_volumes.append({ 'node': node, 'storage': storage, 'volid': volid_s, 'name': name })
                    except Exception as e:
                        errs.append({ 'node': node, 'name': name, 'reason': f'storage delete failed for {volid}: {e}' })
        except Exception as e:
            errs.append({ 'name': it.get('name'), 'reason': f'invalid purge item: {e}' })

    # Reload networking once per affected node
    network_applied_nodes = []
    network_apply_errors = []
    for node in bridges_to_reload:
        try:
            client.reload_network(node)
            network_applied_nodes.append(node)
        except Exception as e:
            network_apply_errors.append({ 'node': node, 'reason': f'network reload failed: {e}' })

    _end_job(pid)
    return jsonify({ 'removed_bridges': removed_bridges, 'removed_volumes': removed_volumes, 'errors': errs, 'skipped': skip, 'network_applied_nodes': network_applied_nodes, 'network_apply_errors': network_apply_errors })


def _resolve_targets_to_vm_info(proj: Project, client: ProxmoxClient, targets: list):
    """Map incoming targets (index, name base or generated) to actual VM info (node, vmid, gen_name).
    Returns (mapped_list, skipped_list, errors_list)
    """
    tag = str(proj.tag or '').strip()
    vms_cfg = proj.vms or []
    cfg_map = { getattr(v, 'name', ''): v for v in vms_cfg }
    cfg_map_lc = { str(getattr(v, 'name', '')).lower(): v for v in vms_cfg }
    # Build map of current VMs
    name_to_info = {}
    try:
        nodes = client.list_nodes()
        for n in nodes:
            node = n.get('node') or n.get('id') or ''
            if not node:
                continue
            try:
                for q in client.list_qemu_vms(node):
                    nm = str(q.get('name') or '')
                    if nm:
                        name_to_info[nm.lower()] = {
                            'node': node,
                            'vmid': int(q.get('vmid')) if q.get('vmid') is not None else None,
                            'name': nm,
                            'status': (q.get('status') or q.get('qmpstatus') or '').lower(),
                        }
            except Exception:
                continue
    except Exception:
        return [], [], [{ 'reason': 'failed to list nodes' }]
    mapped = []
    skipped = []
    errors = []
    for t in targets:
        try:
            idx = int(t.get('index'))
            incoming = str(t.get('name') or '')
        except Exception:
            errors.append({ 'name': t, 'reason': 'invalid target' })
            continue
        base_name = incoming
        try:
            suf = f"{tag}{idx}"
            if base_name.endswith(suf):
                base_name = base_name[:len(base_name)-len(suf)]
        except Exception:
            pass
        cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
        if not cfg:
            for v in vms_cfg:
                b = getattr(v, 'name', '') or ''
                if b and (b + f"{tag}{idx}") == incoming:
                    cfg = v
                    base_name = b
                    break
        if not cfg:
            errors.append({ 'index': idx, 'name': base_name, 'reason': 'unknown base name' })
            continue
        gen_name = f"{base_name}{tag}{idx}"
        info = name_to_info.get(gen_name.lower())
        if not info or info.get('vmid') is None:
            skipped.append({ 'index': idx, 'name': gen_name, 'reason': 'not found' })
            continue
        # Append each resolved VM info to the mapped list (fix: ensure inside loop)
        mapped.append({ 'index': idx, 'name': gen_name, 'node': info['node'], 'vmid': info['vmid'], 'status': info.get('status','') })
    return mapped, skipped, errors


@api_bp.route("/projects/<pid>/instances/actions/start", methods=["POST"])
def instances_start(pid: str):
    _start_job(pid, 'start')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    started = []
    resumed = []
    try:
        max_jobs = int(getattr(proj, 'proxmox_max_create_jobs', 20) or 1)
    except Exception:
        max_jobs = 1
    if max_jobs < 1:
        max_jobs = 1
    pool_workers = max(1, min(len(mapped), max_jobs, 16)) if mapped else 1
    # Run in parallel with a reasonable pool size
    def do_start(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        st = (m.get('status') or '').lower()
        if st == 'suspended':
            upid = client.resume_qemu(node=m['node'], vmid=m['vmid'])
            client._wait_task(m['node'], upid, timeout=600)
            return ('resumed', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] })
        upid = client.start_qemu(node=m['node'], vmid=m['vmid'])
        client._wait_task(m['node'], upid, timeout=600)
        return ('started', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] })

    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
        future_map = { pool.submit(do_start, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                if kind == 'resumed':
                    resumed.append(payload)
                else:
                    started.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'start failed: {e}' })
    _end_job(pid)
    return jsonify({ 'started': started, 'resumed': resumed, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/suspend", methods=["POST"])
def instances_suspend(pid: str):
    _start_job(pid, 'suspend')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    suspended = []
    def do_suspend(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        upid = client.suspend_qemu(node=m['node'], vmid=m['vmid'])
        client._wait_task(m['node'], upid, timeout=600)
        return { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] }

    with ThreadPoolExecutor(max_workers=min(len(mapped), 16) or 1) as pool:
        future_map = { pool.submit(do_suspend, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                suspended.append(fut.result())
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'suspend failed: {e}' })
    _end_job(pid)
    return jsonify({ 'suspended': suspended, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/poweroff", methods=["POST"])
def instances_poweroff(pid: str):
    _start_job(pid, 'poweroff')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    powered_off = []
    def do_poweroff(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        upid = client.stop_qemu(node=m['node'], vmid=m['vmid'])
        client._wait_task(m['node'], upid, timeout=600)
        return { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] }

    with ThreadPoolExecutor(max_workers=min(len(mapped), 16) or 1) as pool:
        future_map = { pool.submit(do_poweroff, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                powered_off.append(fut.result())
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'power off failed: {e}' })
    _end_job(pid)
    return jsonify({ 'powered_off': powered_off, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/snapshot", methods=["POST"])
def instances_snapshot(pid: str):
    _start_job(pid, 'snapshot')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    snapname = (body.get('snapname') or '').strip()
    if not snapname:
        import datetime as _dt
        snapname = 'manual-' + _dt.datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    snapshotted = []
    delay = float(getattr(proj, 'proxmox_snapshot_delay_seconds', 5.0))
    # Execute snapshots sequentially with delay throttle to avoid overloading storage
    for i, m in enumerate(mapped):
        if _is_cancelled(pid):
            errors.append({ 'reason': 'cancelled' })
            break
        try:
            upid = client.snapshot_qemu(node=m['node'], vmid=m['vmid'], snapname=snapname, description=f'User snapshot for {m["name"]}')
            client._wait_task(m['node'], upid, timeout=900)
            snapshotted.append({ 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'], 'snapname': snapname })
        except Exception as e:
            errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'snapshot failed: {e}' })
        # Sleep between snapshots if more remain
        if i < len(mapped)-1 and delay and delay > 0:
            try:
                _safe_sleep(delay)
            except Exception:
                pass
    _end_job(pid)
    return jsonify({ 'snapshotted': snapshotted, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/restore", methods=["POST"])
def instances_restore(pid: str):
    _start_job(pid, 'restore')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    # Ignore provided snapname/startAfter; we'll choose latest snapshot per-VM and not auto-start
    start_after = False
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    restored = []
    notice = 'Restoring the latest snapshot on each VM (most recent by timestamp).'
    def do_restore(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        snaps = client.list_snapshots_qemu(node=m['node'], vmid=m['vmid'])
        snaps = [s for s in snaps if s.get('name') and s.get('name') != 'current']
        if not snaps:
            return ('skipped', { 'index': m['index'], 'name': m['name'], 'reason': 'no snapshots found' })
        snaps_sorted = sorted(snaps, key=lambda s: (s.get('snaptime') or 0), reverse=True)
        snapname = snaps_sorted[0].get('name')
        upid = client.restore_snapshot_qemu(node=m['node'], vmid=m['vmid'], snapname=snapname, start_after=start_after)
        client._wait_task(m['node'], upid, timeout=900)
        return ('restored', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'], 'snapname': snapname, 'started': start_after, 'latest': True })

    with ThreadPoolExecutor(max_workers=min(len(mapped), 16) or 1) as pool:
        future_map = { pool.submit(do_restore, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                if kind == 'restored':
                    restored.append(payload)
                else:
                    skipped.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'restore failed: {e}' })
    _end_job(pid)
    return jsonify({ 'restored': restored, 'skipped': skipped, 'errors': errors, 'notice': notice })


@api_bp.route("/projects/<pid>/instances/actions/nets_assign", methods=["POST"])
def instances_nets_assign(pid: str):
    """Retry network adaptor assignment (set_qemu_nets) for existing VMs.
    Body: { username?, password?, baseUrl?, apiPort?, verifySSL?, targets: [ { index, name } ] }
    Returns: { updated: [ { index, name, vmid, node } ], skipped: [], errors: [] }
    """
    _start_job(pid, 'nets_assign')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400

    tag = str(proj.tag or '').strip()
    vms_cfg = proj.vms or []
    cfg_map = { getattr(v, 'name', ''): v for v in vms_cfg }
    cfg_map_lc = { str(getattr(v, 'name', '')).lower(): v for v in vms_cfg }

    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)

    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    updated = []

    def _base_from_generated(gen_name: str, idx: int) -> str:
        try:
            suf = f"{tag}{idx}"
            if gen_name.endswith(suf):
                return gen_name[:len(gen_name)-len(suf)]
        except Exception:
            pass
        return gen_name

    def do_apply(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        idx = int(m['index'])
        gen_name = str(m['name'] or '')
        node = m['node']
        vmid = m['vmid']
        base_name = _base_from_generated(gen_name, idx)
        cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
        if not cfg:
            return ('error', { 'index': idx, 'name': gen_name, 'reason': 'unknown base name for nets retry' })
        # Build netspecs from configured adaptors
        adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or [])
        if not adaptors:
            return ('error', { 'index': idx, 'name': gen_name, 'reason': 'no adaptors configured' })
        netspecs = []
        for a in adaptors:
            try:
                base = re.sub(r"[^A-Za-z]", "", str(a or ""))[:8]
                bname = f"{base}{idx}" if base else f"br{idx}"
                if len(bname) > 15:
                    bname = bname[:15]
            except Exception:
                bname = f"br{idx}"
            netspecs.append(f"e1000,bridge={bname}")
        try:
            existing_cfg = {}
            try:
                existing_cfg = client.get_qemu_config(node=node, vmid=vmid)
            except Exception:
                existing_cfg = {}
            delete_keys = [k for k in (existing_cfg or {}).keys() if str(k).startswith('net')]
            if delete_keys:
                try:
                    client.set_qemu_nets(node=node, vmid=vmid, nets=[], delete_keys=delete_keys)
                except Exception:
                    pass
            client.set_qemu_nets(node=node, vmid=vmid, nets=netspecs, delete_keys=None)
            return ('ok', { 'index': idx, 'name': gen_name, 'vmid': vmid, 'node': node })
        except Exception as e:
            return ('error', { 'index': idx, 'name': gen_name, 'reason': f'set nets failed: {e}' })

    with ThreadPoolExecutor(max_workers=min(len(mapped), 16) or 1) as pool:
        future_map = { pool.submit(do_apply, m): m for m in mapped }
        for fut in as_completed(future_map):
            try:
                kind, payload = fut.result()
                if kind == 'ok':
                    updated.append(payload)
                else:
                    errors.append(payload)
            except Exception as e:
                errors.append({ 'reason': f'network assign failed: {e}' })

    _end_job(pid)
    return jsonify({ 'updated': updated, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/nets_clear", methods=["POST"])
def instances_nets_clear(pid: str):
    """Remove all configured network adaptors (netX entries) from selected VMs."""
    _start_job(pid, 'nets_clear')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400

    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)

    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    cleared = []

    def do_clear(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        idx = int(m['index'])
        gen_name = str(m['name'] or '')
        node = m['node']
        vmid = m['vmid']
        existing_cfg = {}
        try:
            existing_cfg = client.get_qemu_config(node=node, vmid=vmid) or {}
        except Exception:
            existing_cfg = {}
        delete_keys = [k for k in (existing_cfg or {}).keys() if str(k).startswith('net')]
        if not delete_keys:
            return ('skipped', { 'index': idx, 'name': gen_name, 'reason': 'no network interfaces found' })
        try:
            client.set_qemu_nets(node=node, vmid=vmid, nets=[], delete_keys=delete_keys)
            return ('cleared', { 'index': idx, 'name': gen_name, 'vmid': vmid, 'node': node, 'removed': delete_keys })
        except Exception as e:
            return ('error', { 'index': idx, 'name': gen_name, 'reason': f'clear nets failed: {e}' })

    with ThreadPoolExecutor(max_workers=min(len(mapped), 16) or 1) as pool:
        future_map = { pool.submit(do_clear, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                if kind == 'cleared':
                    cleared.append(payload)
                elif kind == 'skipped':
                    skipped.append(payload)
                else:
                    errors.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'network clear failed: {e}' })

    _end_job(pid)
    return jsonify({ 'cleared': cleared, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/users_create", methods=["POST"])
def instances_users_create(pid: str):
    """Create Proxmox user(s) and pools for selected instance credential usernames and add selected VMs to the pools."""
    _start_job(pid, 'users_create')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    # Group mapped VMs by instance index
    by_index = {}
    for m in mapped:
        by_index.setdefault(int(m['index']), []).append(m)
    # Always operate per selected instance index, even if no VMs are mapped
    indices = sorted({ int((t or {}).get('index', 0)) for t in (targets or []) if (t or {}).get('index') })
    # Enumerate existing cluster VMs (name-> list of entries) so we can apply ACLs to user-accessible
    # VMs even if they were not explicitly targeted in this action.
    existing_vms_by_name = {}
    try:
        for n in client.list_nodes() or []:
            try:
                node_name = n.get('node') or n.get('id') or n.get('name') or ''
                if not node_name:
                    continue
                for q in client.list_qemu_vms(node_name) or []:
                    try:
                        nm = str(q.get('name') or '')
                        if not nm:
                            continue
                        existing_vms_by_name.setdefault(nm.lower(), []).append({ 'node': node_name, 'vmid': q.get('vmid'), 'name': nm })
                    except Exception:
                        continue
            except Exception:
                continue
    except Exception:
        pass
    created_users = []
    created_pools = []
    added_members = []
    notices = []
    # De-dupe notices across batch by reason string
    notice_keys = set()
    def _add_notice_once(item):
        try:
            key = str((item or {}).get('reason', '') or item)
            if key not in notice_keys:
                notices.append(item)
                notice_keys.add(key)
        except Exception:
            notices.append(item)
    # Track items created in this batch to avoid duplicate creates
    created_users_set = set()
    created_pools_set = set()
    # Helpers: base-name and user-accessible check
    tag_local = str(proj.tag or '').strip()
    def _base_from_generated(gen_name: str, idx: int) -> str:
        try:
            suf = f"{tag_local}{idx}"
            if gen_name and gen_name.endswith(suf):
                return gen_name[:len(gen_name)-len(suf)]
        except Exception:
            pass
        return gen_name
    def _is_user_accessible(base_name: str) -> bool:
        try:
            for v in (proj.vms or []):
                if isinstance(v, dict):
                    if str(v.get('name') or '') == str(base_name or ''):
                        return bool(v.get('viewable_to_user'))
                else:
                    if str(getattr(v, 'name', '') or '') == str(base_name or ''):
                        return bool(getattr(v, 'viewable_to_user', False))
        except Exception:
            return False
        return False
    for idx in indices:
        mlist = by_index.get(idx, [])
        if _is_cancelled(pid):
            errors.append({ 'reason': 'cancelled' })
            break
        # Credential for this instance index (1-based)
        try:
            cred = (proj.credentials or [])[idx-1] if idx-1 < len(proj.credentials or []) else None
            uname = (cred or {}).get('username') or ''
            upass = (cred or {}).get('password') or ''
            if not uname:
                errors.append({ 'index': idx, 'reason': 'no credential username for instance' })
                continue
            # Default realm 'pve'
            userid = f"{uname}@pve"
            poolid = re.sub(r"[^A-Za-z0-9_-]+", "", str(uname))
            # Create user if missing, else warn-once and continue
            try:
                existing_user = client.get_user(userid)
                if existing_user is not None or userid in created_users_set:
                    _add_notice_once({ 'index': idx, 'reason': f'user {userid} already exists; not creating' })
                else:
                    client.create_user(userid, password=upass or None, enable=True, comment=f"Auto-created for instance {idx}")
                    created_users.append({ 'index': idx, 'userid': userid })
                    created_users_set.add(userid)
            except Exception as e:
                errors.append({ 'index': idx, 'reason': f'user create failed: {e}' })
            # Create pool if missing, else warn-once and continue
            try:
                if not poolid:
                    errors.append({ 'index': idx, 'reason': 'no pool id (credential username empty or invalid)' })
                else:
                    existing_pool = client.get_pool(poolid)
                    if existing_pool is not None or poolid in created_pools_set:
                        _add_notice_once({ 'index': idx, 'reason': f'pool {poolid} already exists; not creating' })
                    else:
                        client.create_pool(poolid, comment=f"Auto-created for {userid}")
                        created_pools.append({ 'index': idx, 'pool': poolid })
                        created_pools_set.add(poolid)
            except Exception as e:
                errors.append({ 'index': idx, 'reason': f'pool create failed: {e}' })
            # Add members for selected VMs under this index (if any mapped)
            if not poolid:
                errors.append({ 'index': idx, 'reason': 'no pool id (credential username empty or invalid)' })
            else:
                for m in (mlist or []):
                    # Add ALL mapped VMs to pool (reverted behavior)
                    dbg = []
                    try:
                        try:
                            current_app.logger.debug(f"add_pool_member: attempting pool={poolid} vmid={int(m['vmid'])}")
                        except Exception:
                            pass
                        try:
                            dbg.append(f"add_pool_member: attempting pool={poolid} vmid={int(m['vmid'])}")
                        except Exception:
                            pass
                        client.add_pool_member(poolid, int(m['vmid']))
                        added_members.append({ 'index': idx, 'pool': poolid, 'vmid': int(m['vmid']), 'name': m['name'], 'debug': dbg + [f"add_pool_member: success pool={poolid} vmid={int(m['vmid'])}"] })
                        try:
                            current_app.logger.debug(f"add_pool_member: success pool={poolid} vmid={int(m['vmid'])}")
                        except Exception:
                            pass
                    except Exception as e:
                        # Treat legacy 501 (not implemented) as a notice, and try VM-config fallback to set pool
                        msg = str(e)
                        if ' 501' in msg or 'not implemented' in msg.lower():
                            # Determine node for this VM to set pool option
                            vm_node = None
                            try:
                                # Best-effort: scan nodes to find matching VMID
                                nodes = client.list_nodes()
                                for n in nodes:
                                    try:
                                        nn = n.get('node') or n.get('name') or ''
                                        lst = client.list_qemu_vms(nn)
                                        for ent in lst:
                                            if int(ent.get('vmid')) == int(m['vmid']):
                                                vm_node = nn
                                                raise StopIteration
                                    except StopIteration:
                                        break
                                    except Exception:
                                        continue
                            except Exception:
                                vm_node = None
                            if vm_node:
                                try:
                                    client.set_qemu_options(node=vm_node, vmid=int(m['vmid']), options={ 'pool': poolid })
                                    added_members.append({ 'index': idx, 'pool': poolid, 'vmid': int(m['vmid']), 'name': m['name'], 'via': 'vm-config', 'debug': dbg + [f"fallback:set_qemu_options pool={poolid} vmid={int(m['vmid'])} -> success"] })
                                    notices.append({ 'index': idx, 'reason': f'pool members endpoint unsupported; set VM {m.get("vmid")} pool via config' })
                                    try:
                                        current_app.logger.debug(f"fallback:set_qemu_options pool={poolid} vmid={int(m['vmid'])} -> success")
                                    except Exception:
                                        pass
                                except Exception as e2:
                                    notices.append({ 'index': idx, 'reason': f'pool members endpoint unsupported; VM-config fallback failed for VM {m.get("vmid")}: {e2}' })
                                    try:
                                        current_app.logger.debug(f"fallback:set_qemu_options pool={poolid} vmid={int(m['vmid'])} -> failed: {e2}")
                                    except Exception:
                                        pass
                            else:
                                notices.append({ 'index': idx, 'reason': 'pool members endpoint unsupported; unable to locate VM node for VM-config fallback' })
                        else:
                            errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'add member failed: {e}' })
                # ACLs: per-VM only for user-accessible VMs; no pool-level ACL grant
                try:
                    try:
                        if current_app.config.get('ACL_DEBUG'):
                            current_app.logger.info(f"[users_create][ACL] index={idx} checking user={userid}")
                    except Exception:
                        pass
                    user_rec = client.get_user(userid)
                    if user_rec is not None:
                        applied = 0
                        unsupported = False
                        # Build full ACL target list: mapped + any other existing user-accessible VMs for this index
                        acl_targets = list(mlist or [])
                        try:
                            existing_names_set = { str(m.get('name') or '') for m in acl_targets }
                            for v in (proj.vms or []):
                                try:
                                    # Determine user-accessible flag
                                    if isinstance(v, dict):
                                        viewable = bool(v.get('viewable_to_user'))
                                        base_v = str(v.get('name') or '')
                                    else:
                                        viewable = bool(getattr(v, 'viewable_to_user', False))
                                        base_v = str(getattr(v, 'name', '') or '')
                                    if not viewable or not base_v:
                                        continue
                                    gen_name_full = f"{base_v}{tag_local}{idx}"
                                    if gen_name_full in existing_names_set:
                                        continue
                                    ent_list = existing_vms_by_name.get(gen_name_full.lower()) or []
                                    if not ent_list:
                                        continue
                                    ent = ent_list[0]
                                    if ent.get('vmid') is None or ent.get('node') is None:
                                        continue
                                    acl_targets.append({ 'index': idx, 'name': gen_name_full, 'vmid': ent.get('vmid'), 'node': ent.get('node') })
                                    existing_names_set.add(gen_name_full)
                                except Exception:
                                    continue
                        except Exception:
                            pass
                        for m in acl_targets:
                            try:
                                gen_name = str(m.get('name') or '')
                                base_name = _base_from_generated(gen_name, idx)
                                if not _is_user_accessible(base_name):
                                    continue
                                try:
                                    if current_app.config.get('ACL_DEBUG'):
                                        current_app.logger.info(f"[users_create][ACL] applying user={userid} vmid={m.get('vmid')} name={gen_name}")
                                except Exception:
                                    pass
                                client.set_acl_user_vm(userid, int(m['vmid']), roles='PVEVMUser', propagate=True)
                                applied += 1
                            except Exception as e2:
                                if '501' in str(e2) and 'not implemented' not in str(e2).lower():
                                    errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'ACL permission issue (501) applying user {userid}: {e2}' })
                                elif 'not implemented' in str(e2).lower():
                                    unsupported = True
                                else:
                                    try:
                                        # Always log actual failure
                                        current_app.logger.error(f"[users_create][ACL] failed user={userid} vmid={m.get('vmid')} name={m.get('name')}: {e2}")
                                    except Exception:
                                        pass
                                    errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'per-VM ACL failed: {e2}' })
                        if applied:
                            try:
                                if current_app.config.get('ACL_DEBUG'):
                                    current_app.logger.info(f"[users_create][ACL] applied {applied} ACL(s) for user={userid} index={idx}")
                            except Exception:
                                pass
                            _add_notice_once({ 'index': idx, 'reason': f'applied per-VM ACL to {applied} user-accessible VM(s)' })
                        if unsupported and applied == 0:
                            _add_notice_once({ 'index': idx, 'reason': 'ACL endpoints unsupported; skipped ACLs' })
                    else:
                        try:
                            if current_app.config.get('ACL_DEBUG'):
                                current_app.logger.warning(f"[users_create][ACL] user not found user={userid} index={idx}")
                        except Exception:
                            pass
                        _add_notice_once({ 'index': idx, 'reason': f'user {userid} not found; skipped ACL set' })
                except Exception as e:
                    try:
                        current_app.logger.error(f"[users_create][ACL] setup failed user={userid} index={idx}: {e}")
                    except Exception:
                        pass
                    errors.append({ 'index': idx, 'reason': f'ACL setup failed: {e}' })
        except Exception as e:
            errors.append({ 'index': idx, 'reason': f'users_create failed: {e}' })
    _end_job(pid)
    return jsonify({ 'created_users': created_users, 'created_pools': created_pools, 'added_members': added_members, 'skipped': skipped, 'errors': errors, 'notices': notices })


@api_bp.route("/projects/<pid>/instances/actions/users_delete", methods=["POST"])
def instances_users_delete(pid: str):
    """Delete Proxmox user(s) and pools for selected instance credential usernames."""
    _start_job(pid, 'users_delete')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    # We only need instance indices from targets to find corresponding usernames
    indices = sorted({ int((t or {}).get('index', 0)) for t in targets if (t or {}).get('index') })
    deleted_users = []
    deleted_pools = []
    errors = []
    notices = []
    notice_keys = set()
    def _add_notice_once(item):
        try:
            key = str((item or {}).get('reason', '') or item)
            if key not in notice_keys:
                notices.append(item)
                notice_keys.add(key)
        except Exception:
            notices.append(item)
    for idx in indices:
        if _is_cancelled(pid):
            errors.append({ 'reason': 'cancelled' })
            break
        try:
            cred = (proj.credentials or [])[idx-1] if idx-1 < len(proj.credentials or []) else None
            uname = (cred or {}).get('username') or ''
            if not uname:
                errors.append({ 'index': idx, 'reason': 'no credential username for instance' })
                continue
            userid = f"{uname}@pve"
            poolid = re.sub(r"[^A-Za-z0-9_-]+", "", str(uname))
            try:
                if poolid:
                    # Check if pool exists up-front; if not, return a clear error and skip pool operations
                    pool_exists = False
                    try:
                        pool_exists = bool(client.get_pool(poolid) is not None)
                    except Exception as ge:
                        # If API errored but message indicates not found, treat as not exists
                        msg = str(ge).lower()
                        if 'not found' in msg or 'no such' in msg or 'does not exist' in msg or ' 404' in msg:
                            pool_exists = False
                        else:
                            # Unknown error when checking; proceed with caution
                            pool_exists = False
                    if not pool_exists:
                        _add_notice_once({ 'index': idx, 'reason': f'pool delete skipped: pool "{poolid}" does not exist' })
                        # continue to attempt user deletion below
                    else:
                        # Best-effort: clear pool ACL for the user, remove members, then delete pool
                        # First try bulk remove of all ACLs on the pool path (users and groups)
                        try:
                            client.delete_all_acls_for_path(f"/pool/{poolid}")
                        except Exception:
                            pass
                        # Then try specific user ACL removal (best-effort)
                        try:
                            client.delete_acl_user_pool(userid, poolid, roles='PVEVMUser', propagate=True)
                        except Exception as e:
                            if ' 501' in str(e) or 'not implemented' in str(e).lower():
                                notices.append({ 'index': idx, 'reason': 'ACL delete unsupported; continuing' })
                            else:
                                notices.append({ 'index': idx, 'reason': f'ACL delete failed: {e}' })
                        # Attempt to remove all QEMU members via API; collect remaining vmids
                        vm_refs = []
                        member_api_unsupported = False
                        try:
                            current_members = list(client.list_pool_members(poolid) or [])
                            for m in current_members:
                                if str(m.get('type') or '').lower() != 'qemu' or m.get('vmid') is None:
                                    continue
                                vmid_int = int(m.get('vmid'))
                                try:
                                    client.remove_pool_member(poolid, vmid_int)
                                except Exception as me:
                                    # If not supported, mark for VM-side cleanup
                                    if ' 501' in str(me) or 'not implemented' in str(me).lower():
                                        member_api_unsupported = True
                                        vm_refs.append(vmid_int)
                                    else:
                                        # If other failure, keep it in refs to attempt VM-side cleanup
                                        vm_refs.append(vmid_int)
                            # Re-list members; any still present go to VM-side cleanup
                            try:
                                remain = list(client.list_pool_members(poolid) or [])
                                for m in remain:
                                    if str(m.get('type') or '').lower() == 'qemu' and m.get('vmid') is not None:
                                        vmid_int = int(m.get('vmid'))
                                        if vmid_int not in vm_refs:
                                            vm_refs.append(vmid_int)
                            except Exception:
                                pass
                        except Exception:
                            # If listing members failed, proceed to try pool delete and handle error
                            pass
                        # If any members remain or API unsupported, try VM-side pool option removal
                        if vm_refs:
                            try:
                                # Map vmid -> node by scanning cluster
                                vmid_to_node = {}
                                try:
                                    for n in client.list_nodes():
                                        node_name = n.get('node') or n.get('id') or ''
                                        if not node_name:
                                            continue
                                        try:
                                            for q in client.list_qemu_vms(node_name):
                                                try:
                                                    qid = q.get('vmid')
                                                    if qid is not None:
                                                        vmid_to_node[int(qid)] = node_name
                                                except Exception:
                                                    continue
                                        except Exception:
                                            continue
                                except Exception:
                                    pass
                                for vmid in vm_refs:
                                    node = vmid_to_node.get(int(vmid))
                                    if not node:
                                        continue
                                    try:
                                        client.delete_qemu_options(node, int(vmid), ['pool'])
                                    except Exception:
                                        continue
                            except Exception:
                                pass
                        # Attempt pool delete (retry once if first attempt fails with 500)
                        try:
                            client.delete_pool(poolid)
                        except Exception as e1:
                            msg1 = str(e1).lower()
                            if 'does not exist' in msg1 or 'no such' in msg1 or 'not found' in msg1 or ' 404' in msg1:
                                errors.append({ 'index': idx, 'reason': f'pool delete skipped: pool "{poolid}" does not exist' })
                            elif ' 500' in str(e1):
                                try:
                                    client.delete_pool(poolid)
                                except Exception as e2:
                                    raise e2
                            else:
                                raise e1
                        else:
                            deleted_pools.append({ 'index': idx, 'pool': poolid })
            except Exception as e:
                errors.append({ 'index': idx, 'reason': f'pool delete failed: {e}' })
            try:
                # If user is already gone, warn-once
                try:
                    rec = client.get_user(userid)
                except Exception:
                    rec = None
                if rec is None:
                    _add_notice_once({ 'index': idx, 'reason': f'user delete skipped: user "{userid}" does not exist' })
                else:
                    client.delete_user(userid)
                    deleted_users.append({ 'index': idx, 'userid': userid })
            except Exception as e:
                msg = str(e).lower()
                if 'not found' in msg or 'no such' in msg or 'does not exist' in msg or ' 404' in msg:
                    _add_notice_once({ 'index': idx, 'reason': f'user delete skipped: user "{userid}" does not exist' })
                else:
                    errors.append({ 'index': idx, 'reason': f'user delete failed: {e}' })
        except Exception as e:
            errors.append({ 'index': idx, 'reason': f'users_delete failed: {e}' })
    _end_job(pid)
    return jsonify({ 'deleted_users': deleted_users, 'deleted_pools': deleted_pools, 'errors': errors, 'notices': notices })


@api_bp.route("/projects/<pid>/instances/actions/run_startup_cmds", methods=["POST"])
def instances_run_startup_cmds(pid: str):
    _start_job(pid, 'run_startup_cmds')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    ran = []
    for m in mapped:
        if _is_cancelled(pid):
            errors.append({ 'reason': 'cancelled' })
            break
        # Find startup commands from config for this base
        base = m['name']
        try:
            # derive base name by stripping tag+index
            idx = m['index']
            tag = str(proj.tag or '').strip()
            suf = f"{tag}{idx}"
            if base.endswith(suf):
                base = base[:len(base)-len(suf)]
        except Exception:
            pass
        vcfg = next((v for v in (proj.vms or []) if getattr(v, 'name', '') == base), None)
        cmds = list(getattr(vcfg, 'start_commands', []) or [])
        if not cmds:
            skipped.append({ 'index': m['index'], 'name': m['name'], 'reason': 'no startup commands configured' })
            continue
        # Run commands via guest agent and capture output tails
        cmd_results = []
        for cmd in cmds:
            try:
                res = client.agent_exec(node=m['node'], vmid=m['vmid'], command=str(cmd))
                exitcode = res.get('exitcode', 1)
                out = res.get('stdout', '') or ''
                err = res.get('stderr', '') or ''
                tail_n = 300
                cmd_results.append({
                    'cmd': str(cmd),
                    'exitcode': exitcode,
                    'out_tail': out[-tail_n:],
                    'err_tail': err[-tail_n:]
                })
                if exitcode != 0:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f"cmd failed ({cmd}): {res.get('stderr','')}" })
            except Exception as e:
                errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'cmd error ({cmd}): {e}' })
                cmd_results.append({ 'cmd': str(cmd), 'exitcode': None, 'out_tail': '', 'err_tail': str(e)[:300] })
        ran.append({ 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'], 'count': len(cmds), 'cmds': cmd_results })
    _end_job(pid)
    return jsonify({ 'ran': ran, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/run_stored_cmds", methods=["POST"])
def instances_run_stored_cmds(pid: str):
    _start_job(pid, 'run_stored_cmds')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    username = body.get('username') or None
    password = body.get('password') or None
    base_url = body.get('baseUrl') or proj.proxmox_url
    verify = bool(body.get('verifySSL')) if ('verifySSL' in body) else (getattr(proj, 'proxmox_verify_ssl', True) is not False)
    body_port = body.get('apiPort')
    try:
        if body_port is not None:
            port_int = int(body_port)
            if port_int > 0:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    targets = body.get('targets') or []
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    ran = []
    for m in mapped:
        if _is_cancelled(pid):
            errors.append({ 'reason': 'cancelled' })
            break
        # Find stored commands from config for this base
        base = m['name']
        try:
            idx = m['index']
            tag = str(proj.tag or '').strip()
            suf = f"{tag}{idx}"
            if base.endswith(suf):
                base = base[:len(base)-len(suf)]
        except Exception:
            pass
        vcfg = next((v for v in (proj.vms or []) if getattr(v, 'name', '') == base), None)
        cmds = list(getattr(vcfg, 'stored_commands', []) or [])
        if not cmds:
            skipped.append({ 'index': m['index'], 'name': m['name'], 'reason': 'no stored commands configured' })
            continue
        cmd_results = []
        for cmd in cmds:
            try:
                res = client.agent_exec(node=m['node'], vmid=m['vmid'], command=str(cmd))
                exitcode = res.get('exitcode', 1)
                out = res.get('stdout', '') or ''
                err = res.get('stderr', '') or ''
                tail_n = 300
                cmd_results.append({
                    'cmd': str(cmd),
                    'exitcode': exitcode,
                    'out_tail': out[-tail_n:],
                    'err_tail': err[-tail_n:]
                })
                if exitcode != 0:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f"cmd failed ({cmd}): {res.get('stderr','')}" })
            except Exception as e:
                errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'cmd error ({cmd}): {e}' })
                cmd_results.append({ 'cmd': str(cmd), 'exitcode': None, 'out_tail': '', 'err_tail': str(e)[:300] })
        ran.append({ 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'], 'count': len(cmds), 'cmds': cmd_results })
    _end_job(pid)
    return jsonify({ 'ran': ran, 'skipped': skipped, 'errors': errors })


@api_bp.route('/projects/<pid>/instances/actions/cancel', methods=['POST'])
def instances_cancel(pid: str):
    _cancel_job(pid)
    return jsonify({ 'cancelled': True })


@api_bp.route('/projects/<pid>/instances/actions/status', methods=['GET'])
def instances_actions_status(pid: str):
    """Generic status poller for long-running instance actions (create, delete, start, etc.).
    Response: { id, action, status, progress, phase, step, total_steps, current, message, eta }
    Returns 404 if no active job for the project."""
    rec = _ACTIVE_JOBS.get(_job_key(pid))
    if not rec or rec.get('status') in ('completed','cancelled','error') and rec.get('progress',0) >= 100:
        return jsonify({ 'error': 'No active job' }), 404
    return jsonify({
        'id': rec.get('id'),
        'action': rec.get('action'),
        'status': rec.get('status'),
        'progress': rec.get('progress', 0),
        'phase': rec.get('phase'),
        'step': rec.get('step'),
        'total_steps': rec.get('total_steps'),
        'current': rec.get('current'),
        'message': rec.get('message'),
        'eta': rec.get('eta'),
        'log': rec.get('log', [])[-30:],  # cap to last 30 lines
    })


@api_bp.route("/projects/<pid>/instances/actions/reset_ageing_cache", methods=["POST"])
def instances_reset_ageing_cache(pid: str):
    """Reset (clear) the in-memory global ageing insertion cache.
    Returns counts of cached entries removed. Safe to call any time; does not modify Proxmox.
    Body optional; primarily used to allow re-attempt of ageing insertion if lines were added manually outside the app.
    Response: { ok: bool, cleared_nodes: int, cleared_bridges_total: int, details: { node: count, ... } }
    """
    # We don't require Proxmox credentials; this is purely in-process state.
    global AGEING_APPLIED
    details = {}
    total = 0
    with AGEING_LOCK:
        try:
            for node, bridges in AGEING_APPLIED.items():
                try:
                    c = len(bridges)
                except Exception:
                    c = 0
                details[node] = c
                total += c
            AGEING_APPLIED.clear()
        except Exception:
            AGEING_APPLIED = {}
    return jsonify({ 'ok': True, 'cleared_nodes': len(details), 'cleared_bridges_total': total, 'details': details })


@api_bp.route("/health", methods=["GET"])
def health():
    return {"status": "ok"}


def _store() -> ProjectStore:
    return ProjectStore(current_app.config["DATA_DIR"])

def _ctfd_client_from_req(proj: Project) -> CTFdClient:
    body = request.get_json(silent=True) or {}
    base_url = (body.get('baseUrl') or getattr(proj, 'challenge_url', '') or '').strip()
    port = body.get('port') if ('port' in body) else getattr(proj, 'challenge_port', 443)
    token = body.get('token') or ''
    username = body.get('username') or None
    password = body.get('password') or None
    verify = bool(body.get('verifySSL', True))
    # Normalize base_url and apply port if provided
    try:
        if base_url and not (base_url.startswith('http://') or base_url.startswith('https://')):
            base_url = f"https://{base_url}"
        p = urlparse(base_url or 'https://localhost')
        scheme = p.scheme or 'https'
        host = p.hostname or ''
        # Keep username/password from body, do not override with URL creds
        netloc = host
        try:
            port_i = int(port or 0)
        except Exception:
            port_i = 0
        if port_i and port_i not in (80, 443):
            if host:
                netloc = f"{host}:{port_i}"
        base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    client = CTFdClient(base_url=base_url, token=token, verify_ssl=verify)
    # If token not provided but username/password provided, attempt session login (cookie-based)
    if (not token) and username and password:
        ok, msg = client.login_with_credentials(username, password)
        if not ok:
            raise RuntimeError(f'CTFd login failed: {msg}')
    return client

@api_bp.post('/projects/<pid>/ctfd/settings')
@_secure_route()
def ctfd_settings_get(pid: str):
    """Return current CTFd visibility and paused settings.
    Response: { ok, settings: { challenges_visible, scoreboard_visible, ctfd_paused }, logs }
    """
    s = _store(); proj = s.get(pid)
    if not proj:
        return jsonify({'ok': False, 'error': 'Project not found'}), 404
    try:
        client = _ctfd_client_from_req(proj)
        configs = client.list_configs() if hasattr(client, 'list_configs') else {}
        # Normalize values
        def _lv(v):
            try:
                return str(v or '').strip().lower()
            except Exception:
                return ''
        challenge_visibility = _lv(configs.get('challenge_visibility'))
        scoreboard_visibility = _lv(configs.get('scoreboard_visibility') or configs.get('score_visibility'))
        paused = configs.get('paused')
        # Visible if not hidden/admins-only; treat both 'public' and 'private' as visible for challenges
        challenges_visible = challenge_visibility in ('public', 'private', 'users', 'visible', 'everyone')
        # Scoreboard visible when public or users-visible in some versions
        scoreboard_visible = scoreboard_visibility in ('public', 'users', 'visible', 'everyone')
        try:
            ctfd_paused = bool(paused) and str(paused).lower() not in ('false', '0', 'none', '')
        except Exception:
            ctfd_paused = False
        return jsonify({
            'ok': True,
            'settings': {
                'challenges_visible': challenges_visible,
                'scoreboard_visible': scoreboard_visible,
                'ctfd_paused': ctfd_paused,
            },
            'configs': configs,
            'using_token': bool(client.token),
            'logs': getattr(client, 'logs', []),
        })
    except CTFdError as e:
        status = int(getattr(e, 'status_code', 400) or 400)
        msg = str(e)
        if status in (401, 403):
            return jsonify({'ok': False, 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', [])}), status
        return jsonify({'ok': False, 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', [])}), 502
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', [])}), 500

@api_bp.post('/projects/<pid>/ctfd/settings/update')
@_secure_route()
def ctfd_settings_update(pid: str):
    """Update CTFd visibility and paused settings.
    Body may include any of: { challenges_visible: bool, scoreboard_visible: bool, ctfd_paused: bool }
    """
    s = _store(); proj = s.get(pid)
    if not proj:
        return jsonify({'ok': False, 'error': 'Project not found'}), 404
    try:
        client = _ctfd_client_from_req(proj)
        # Require elevated role for updates
        role = client.get_role()
        if role not in ('admin', 'teacher'):
            return jsonify({'ok': False, 'error': 'forbidden', 'message': f'Admin/Teacher role required (got {role})'}), 403
        body = request.get_json(silent=True) or {}
        updates = {}
        attempts = []
        desired_chal = body.get('challenges_visible') if 'challenges_visible' in body else None
        desired_score = body.get('scoreboard_visible') if 'scoreboard_visible' in body else None
        # Initial mapping
        if desired_chal is not None:
            # Toggle ON: private (visible to users), Toggle OFF: admins (admin-only)
            updates['challenge_visibility'] = 'private' if desired_chal else 'admins'
        if desired_score is not None:
            # Toggle ON: public (everyone), Toggle OFF: admins (admin-only)
            val = 'public' if desired_score else 'admins'
            updates['scoreboard_visibility'] = val
            updates['score_visibility'] = val
        if 'ctfd_paused' in body:
            updates['paused'] = bool(body.get('ctfd_paused'))
        # Apply initial updates
        result = client.set_configs(updates) if hasattr(client, 'set_configs') else {}
        attempts.append({ 'pass': 1, 'updates': dict(updates), 'server': result })
        # Read back effective settings
        def _lv(v):
            try:
                return str(v or '').strip().lower()
            except Exception:
                return ''
        configs = client.list_configs() if hasattr(client, 'list_configs') else {}
        challenge_visibility = _lv(configs.get('challenge_visibility'))
        scoreboard_visibility = _lv(configs.get('scoreboard_visibility') or configs.get('score_visibility'))
        paused = configs.get('paused')
        challenges_visible = challenge_visibility in ('public', 'private', 'users', 'visible', 'everyone')
        scoreboard_visible = scoreboard_visibility in ('public', 'users', 'visible', 'everyone')
        # If mismatch, try one compatibility retry with alternative values
        retry_updates = {}
        if desired_chal is not None and challenges_visible != bool(desired_chal):
            # Toggle ON: try 'public' as fallback, Toggle OFF: try 'admins' or 'hidden'
            retry_updates['challenge_visibility'] = 'admins' if (not desired_chal) else 'public'
        if desired_score is not None and scoreboard_visible != bool(desired_score):
            # If the server didn't reflect the intended visibility, retry with an alternative value
            # Toggle ON: 'public', Toggle OFF: 'admins' (admin-only)
            alt = 'admins' if (not desired_score) else 'public'
            retry_updates['scoreboard_visibility'] = alt
            retry_updates['score_visibility'] = alt
        if retry_updates:
            res2 = client.set_configs(retry_updates) if hasattr(client, 'set_configs') else {}
            attempts.append({ 'pass': 2, 'updates': dict(retry_updates), 'server': res2 })
            # Read back again
            configs = client.list_configs() if hasattr(client, 'list_configs') else {}
            challenge_visibility = _lv(configs.get('challenge_visibility'))
            scoreboard_visibility = _lv(configs.get('scoreboard_visibility') or configs.get('score_visibility'))
            paused = configs.get('paused')
            challenges_visible = challenge_visibility in ('public', 'private', 'users', 'visible', 'everyone')
            scoreboard_visible = scoreboard_visibility in ('public', 'users', 'visible', 'everyone')
        try:
            ctfd_paused = bool(paused) and str(paused).lower() not in ('false', '0', 'none', '')
        except Exception:
            ctfd_paused = False
        return jsonify({
            'ok': True,
            'applied': updates,
            'attempts': attempts,
            'settings': {
                'challenges_visible': challenges_visible,
                'scoreboard_visible': scoreboard_visible,
                'ctfd_paused': ctfd_paused,
            },
            'configs': configs,
            'using_token': bool(client.token),
            'logs': getattr(client, 'logs', []),
        })
    except CTFdError as e:
        status = int(getattr(e, 'status_code', 400) or 400)
        msg = str(e)
        if status in (401, 403):
            return jsonify({'ok': False, 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', [])}), status
        return jsonify({'ok': False, 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', [])}), 502
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', [])}), 500

@api_bp.post('/projects/<pid>/ctfd/login')
@_secure_route()
def ctfd_login(pid: str):
    s = _store(); proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(silent=True) or {}
    try:
        client = _ctfd_client_from_req(proj)
        # If token was provided, validate it via /api/v1/users/me; for session login, presence of session implies success
        me_json = None
        ok_flag = False
        role = None
        if client.token:
            try:
                me = client.get_current_user() or {}
                me_json = me
                try:
                    role = client.get_role()
                except Exception:
                    role = None
                # Consider token valid only if /me returns a usable user shape
                uid = None
                try:
                    cand = me.get('id') if isinstance(me, dict) else None
                    if cand is not None:
                        uid = int(cand)
                except Exception:
                    uid = None
                ok_flag = bool(uid is not None or (isinstance(me, dict) and (me.get('name') or me.get('email'))))
            except Exception as e:
                me_json = { 'error': str(e) }
                ok_flag = False
        else:
            # Session flow: if we got here without exception, login_with_credentials worked
            ok_flag = bool(client.session is not None)
            try:
                role = client.get_role()
            except Exception:
                role = None
        res = {
            'ok': ok_flag,
            'using_token': bool(client.token),
            'session': bool(client.session is not None),
            'me': me_json,
            'role': role,
            'logs': getattr(client, 'logs', []),
        }
        return jsonify(res)
    except Exception as e:
        return jsonify({ 'ok': False, 'error': str(e) }), 400

@api_bp.post('/projects/<pid>/ctfd/users_create')
@_secure_route()
def ctfd_users_create(pid: str):
    store = _store(); proj = store.get(pid)
    if not proj: return jsonify({"error":"Project not found"}), 404
    body = request.get_json(silent=True) or {}
    only = body.get('only')  # optional subset of usernames
    creds = [c for c in (proj.credentials or []) if (not only or c.get('username') in only)]
    if not creds: return jsonify({"created":0, "updated":0, "skipped":0})
    client = _ctfd_client_from_req(proj)

    # Preflight: ensure current identity has permission to manage users
    try:
        # Admin or teacher roles typically required; some setups use 'admin'
        role = client.get_role()
        if role not in ('admin','teacher'):  # be permissive but safe
            return jsonify({
                "error": f"CTFd account lacks permission to manage users (need admin/teacher); got: {role}",
                "ok": False
            }), 403
    except Exception as e:
        return jsonify({"error": f"CTFd self-check failed: {e}", "ok": False}), 400
    created = 0; updated = 0; skipped = 0; results = []
    for c in creds:
        uname = c.get('username') or ''
        email = f"{uname}@example.com"
        pw = c.get('password') or ''
        try:
            uid = client.find_user_id_by_name(uname)
            if uid:
                # Update password to match project
                client.update_user_password(uid, pw)
                updated += 1; results.append({"username": uname, "id": uid, "action": "updated"})
            else:
                u = client.create_user(uname, email, pw)
                created += 1; results.append({"username": uname, "id": u.get('id'), "action": "created"})
        except Exception as e:
            results.append({"username": uname, "error": str(e)})
    return jsonify({
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "results": results,
        "using_token": bool(client.token),
        "logs": getattr(client, 'logs', []),
    })

@api_bp.post('/projects/<pid>/ctfd/users_delete')
@_secure_route()
def ctfd_users_delete(pid: str):
    store = _store(); proj = store.get(pid)
    if not proj: return jsonify({"error":"Project not found"}), 404
    body = request.get_json(silent=True) or {}
    only = body.get('only')  # optional subset
    creds = [c for c in (proj.credentials or []) if (not only or c.get('username') in only)]
    client = _ctfd_client_from_req(proj)
    # Preflight: ensure permission to delete users
    try:
        role = client.get_role()
        if role not in ('admin','teacher'):
            return jsonify({
                "error": f"CTFd account lacks permission to delete users (need admin/teacher); got: {role}",
                "ok": False
            }), 403
    except Exception as e:
        return jsonify({"error": f"CTFd self-check failed: {e}", "ok": False}), 400
    deleted = 0; results = []
    for c in creds:
        uname = c.get('username') or ''
        try:
            uid = client.find_user_id_by_name(uname)
            if uid:
                client.delete_user(uid)
                deleted += 1; results.append({"username": uname, "id": uid, "action": "deleted"})
            else:
                results.append({"username": uname, "action": "missing"})
        except Exception as e:
            results.append({"username": uname, "error": str(e)})
    return jsonify({
        "deleted": deleted,
        "results": results,
        "using_token": bool(client.token),
        "logs": getattr(client, 'logs', []),
    })

@api_bp.post('/projects/<pid>/ctfd/users_check')
@_secure_route()
def ctfd_users_check(pid: str):
    """Return existence of project credential usernames on the CTFd server.
    Request JSON: { baseUrl, port, token?, username?, password?, verifySSL?, only?: [usernames] }
    Response JSON: { users: [{ username, exists }] }
    """
    store = _store(); proj = store.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(silent=True) or {}
    only = body.get('only')
    # Determine which usernames to check
    creds = list(getattr(proj, 'credentials', []) or [])
    targets = []
    for c in creds:
        try:
            u = (c.get('username') or '').strip()
            if not u:
                continue
            if only and u not in only:
                continue
            targets.append(u)
        except Exception:
            continue
    # Build client (supports token or session login)
    client = _ctfd_client_from_req(proj)

    def _pick_id(source, keys):
        if not isinstance(source, dict):
            return None
        for key in keys:
            if key in source and source[key] is not None:
                val = source[key]
                try:
                    return int(val)
                except Exception:
                    try:
                        return int(str(val))
                    except Exception:
                        continue
        return None

    def _pick_str(source, keys):
        if isinstance(source, dict):
            for key in keys:
                val = source.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
        elif isinstance(source, str) and source.strip():
            return source.strip()
        return ''

    def _normalize_category(label):
        txt = str(label or '').strip()
        return txt if txt else 'Uncategorized'

    def _extract_ts(record):
        ts_iso = None
        ts_epoch = None
        for key in ('date', 'solved_date', 'created', 'submitted', 'timestamp', 'time'):
            value = record.get(key)
            if value in (None, ''):
                continue
            if isinstance(value, (int, float)):
                ts_epoch = float(value)
                try:
                    ts_iso = datetime.utcfromtimestamp(ts_epoch).isoformat() + 'Z'
                except Exception:
                    ts_iso = str(value)
                break
            if isinstance(value, str) and value.strip():
                ts_iso = value.strip()
                dt = _parse_iso_datetime(ts_iso)
                if dt:
                    try:
                        ts_epoch = dt.timestamp()
                    except Exception:
                        ts_epoch = None
                else:
                    try:
                        ts_epoch = float(value)
                    except Exception:
                        ts_epoch = None
                break
        return ts_epoch, ts_iso

    def _is_earlier(candidate, existing):
        if not existing:
            return True
        new_ts = candidate.get('timestamp_epoch')
        old_ts = existing.get('timestamp_epoch')
        if new_ts is not None and old_ts is not None:
            if new_ts < old_ts:
                return True
            if new_ts > old_ts:
                return False
        elif new_ts is not None:
            return True
        elif old_ts is not None:
            return False
        new_label = candidate.get('timestamp') or ''
        old_label = existing.get('timestamp') or ''
        if new_label and old_label and new_label != old_label:
            return new_label < old_label
        new_name = candidate.get('user') or candidate.get('team') or ''
        old_name = existing.get('user') or existing.get('team') or ''
        if new_name and old_name and new_name != old_name:
            return new_name < old_name
        return False

    def _resolve_identity(record):
        account = record.get('account') if isinstance(record.get('account'), dict) else {}
        team_obj = record.get('team') if isinstance(record.get('team'), dict) else {}
        try:
            account_type = (account.get('type') or account.get('account_type') or record.get('account_type') or record.get('type') or '').lower()
        except Exception:
            account_type = ''
        user_id = _pick_id(record, ('user_id', 'userId'))
        if user_id is None:
            user_id = _pick_id(account, ('id', 'user_id', 'userId'))
        if user_id is None and isinstance(record.get('user'), dict):
            user_id = _pick_id(record.get('user'), ('id', 'user_id', 'userId'))
        team_id = _pick_id(record, ('team_id', 'teamId'))
        if team_id is None and isinstance(team_obj, dict):
            team_id = _pick_id(team_obj, ('id', 'team_id', 'teamId'))
        if team_id is None and account_type == 'team':
            team_id = _pick_id(account, ('id', 'team_id', 'teamId', 'account_id', 'accountId'))
        if team_id is None and isinstance(account, dict):
            team_id = _pick_id(account, ('team_id', 'teamId'))
        user_name = _pick_str(record, ('user', 'username', 'user_name', 'account_name'))
        if not user_name:
            user_name = _pick_str(account, ('name', 'username', 'display_name'))
        if not user_name and isinstance(record.get('user'), dict):
            user_name = _pick_str(record.get('user'), ('name', 'username', 'display_name'))
        team_name = _pick_str(record, ('team_name', 'team', 'group'))
        if not team_name and isinstance(team_obj, dict):
            team_name = _pick_str(team_obj, ('name', 'team', 'display_name'))
        if not team_name and account_type == 'team':
            team_name = _pick_str(account, ('name', 'team', 'display_name'))
        if not team_name and isinstance(record.get('team'), str):
            team_name = record.get('team').strip()
        kind = 'team' if (account_type == 'team' or (team_id is not None and user_id is None)) else 'user'
        return {
            'kind': kind,
            'user_id': user_id,
            'user_name': user_name,
            'team_id': team_id,
            'team_name': team_name,
        }

    def _build_category_firsts():
        result = {
            'user': [],
            'team': [],
            'errors': [],
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
        best_user = {}
        best_team = {}
        try:
            challenges = client.list_challenges_all()
        except Exception as exc:
            result['errors'].append(f'challenges: {exc}')
            challenges = []
        if not isinstance(challenges, list):
            challenges = []
        for chall in challenges:
            if not isinstance(chall, dict):
                continue
            try:
                cid = int(chall.get('id'))
            except Exception:
                cid = None
            if cid is None:
                continue
            category_label = _normalize_category(chall.get('category') or chall.get('topic'))
            challenge_name = _pick_str(chall, ('name', 'title')) or f'Challenge {cid}'
            try:
                solves = client.list_challenge_solves(cid)
            except Exception as exc:
                result['errors'].append(f'solves[{cid}]: {exc}')
                solves = []
            if not isinstance(solves, list):
                continue
            for solve in solves:
                if not isinstance(solve, dict):
                    continue
                ts_epoch, ts_iso = _extract_ts(solve)
                identity = _resolve_identity(solve)
                if identity['kind'] != 'team' and identity['user_id'] and not identity['user_name']:
                    try:
                        fetched_user = client.get_user_name(identity['user_id'])
                        if fetched_user:
                            identity['user_name'] = fetched_user
                    except Exception:
                        pass
                if identity['team_id'] and not identity['team_name']:
                    try:
                        fetched_team = client.get_team_name(identity['team_id'])
                        if fetched_team:
                            identity['team_name'] = fetched_team
                    except Exception:
                        pass
                category_key = category_label.lower()
                common_entry = {
                    'category': category_label,
                    'category_key': category_key,
                    'challenge': challenge_name,
                    'challenge_id': cid,
                    'timestamp': ts_iso,
                    'timestamp_epoch': ts_epoch,
                    'team': identity['team_name'] or None,
                    'team_id': identity['team_id'],
                }
                if identity['kind'] != 'team' and identity['user_name']:
                    user_entry = {**common_entry, 'user': identity['user_name'], 'user_id': identity['user_id']}
                    prev_user = best_user.get(category_key)
                    if _is_earlier(user_entry, prev_user):
                        best_user[category_key] = user_entry
                if identity['team_name']:
                    team_entry = {**common_entry, 'team': identity['team_name'], 'team_id': identity['team_id']}
                    prev_team = best_team.get(category_key)
                    if _is_earlier(team_entry, prev_team):
                        best_team[category_key] = team_entry

        def _finalize(source_map, target_key):
            items = []
            for entry in source_map.values():
                copy = dict(entry)
                copy.pop('category_key', None)
                items.append(copy)
            items.sort(key=lambda e: (
                e.get('timestamp_epoch') if e.get('timestamp_epoch') is not None else float('inf'),
                str(e.get('category') or '')
            ))
            result[target_key] = items

        _finalize(best_user, 'user')
        _finalize(best_team, 'team')
        return result

    out = []
    for uname in targets:
        exists = False
        user_rank = None
        team_name = None
        team_rank = None
        user_points = None
        team_points = None
        user_last_solve_time = None
        user_last_solve_challenge = None
        team_captain = None
        team_size = None
        team_last_solve_time = None
        team_last_solve_challenge = None
        try:
            uid = client.find_user_id_by_name(uname)
            exists = bool(uid)
            if uid:
                # Try to enrich with rank/team info
                try:
                    uobj = client.get_user(int(uid))
                except Exception:
                    uobj = {}
                # User rank usually available as 'place' or 'score' rank depending on CTFd config; try common keys
                try:
                    for k in ('place', 'rank', 'score_rank', 'overall_place'):
                        val = uobj.get(k)
                        if isinstance(val, (int, float, str)) and str(val).strip():
                            user_rank = int(val) if str(val).isdigit() else str(val)
                            break
                except Exception:
                    pass
                # User points/score
                try:
                    for pk in ('score', 'points', 'value', 'overall_score', 'sum'):
                        pv = uobj.get(pk)
                        if pv is None:
                            continue
                        # Accept numeric or numeric-like strings
                        try:
                            fv = float(pv)
                            user_points = fv
                            break
                        except Exception:
                            try:
                                iv = int(str(pv))
                                user_points = float(iv)
                                break
                            except Exception:
                                pass
                except Exception:
                    pass
                # User last solve info
                try:
                    solves = client.list_user_solves(int(uid))
                    # Pick most recent by date field
                    if isinstance(solves, list) and solves:
                        def _ts(s):
                            try:
                                # common fields: date, solved_date, created, submitted
                                for dk in ('date','solved_date','created','submitted'):
                                    v = s.get(dk)
                                    if isinstance(v, str) and v:
                                        return v
                            except Exception:
                                return None
                            return None
                        # Already in reverse chronological order? ensure by sort
                        try:
                            solves_sorted = sorted(solves, key=lambda s: (_ts(s) or ''), reverse=True)
                        except Exception:
                            solves_sorted = solves
                        last = solves_sorted[0]
                        # Challenge info can be id or embedded
                        chall_id = None
                        try:
                            for ck in ('challenge_id','challengeId','challenge','chal'):
                                if last.get(ck) is not None:
                                    chall_id = int(last.get(ck))
                                    break
                        except Exception:
                            chall_id = None
                        if chall_id is not None:
                            try:
                                cname = client.get_challenge_name(chall_id) or None
                            except Exception:
                                cname = None
                        else:
                            cname = None
                        user_last_solve_time = _ts(last)
                        user_last_solve_challenge = cname
                except Exception:
                    pass
                # Team info
                try:
                    tid = None
                    for k in ('team_id','teamid','team','teamId'):
                        if uobj.get(k) is not None:
                            try:
                                tid = int(uobj.get(k))
                            except Exception:
                                pass
                            if tid is not None:
                                break
                    if tid is not None:
                        tobj = {}
                        try:
                            tobj = client.get_team(int(tid))
                        except Exception:
                            tobj = {}
                        # Determine a team display name and rank from common keys
                        try:
                            for nk in ('name','team','display_name','title'):
                                tv = tobj.get(nk)
                                if isinstance(tv, str) and tv.strip():
                                    team_name = tv.strip()
                                    break
                        except Exception:
                            pass
                        try:
                            for rk in ('place','rank','score_rank','overall_place'):
                                rv = tobj.get(rk)
                                if isinstance(rv, (int, float, str)) and str(rv).strip():
                                    team_rank = int(rv) if str(rv).isdigit() else str(rv)
                                    break
                        except Exception:
                            pass
                        # Team points/score
                        try:
                            for pk in ('score', 'points', 'value', 'overall_score', 'sum'):
                                pv = tobj.get(pk)
                                if pv is None:
                                    continue
                                try:
                                    fv = float(pv)
                                    team_points = fv
                                    break
                                except Exception:
                                    try:
                                        iv = int(str(pv))
                                        team_points = float(iv)
                                        break
                                    except Exception:
                                        pass
                        except Exception:
                            pass
                        # Team captain and size
                        try:
                            # Captain often under 'captain_id' or 'captain'
                            cap_id = None
                            for ck in ('captain_id','captain','owner_id','owner'):
                                if tobj.get(ck) is not None:
                                    try:
                                        cap_id = int(tobj.get(ck))
                                    except Exception:
                                        pass
                                    if cap_id is not None:
                                        break
                            # Resolve captain name from members or user endpoint
                            members = client.list_team_members(int(tid))
                            team_size = len(members) if isinstance(members, list) else None
                            if cap_id is not None:
                                # First try from members array
                                try:
                                    for m in members or []:
                                        mid = None
                                        try:
                                            for mk in ('id','user_id','userid','userId'):
                                                if m.get(mk) is not None:
                                                    mid = int(m.get(mk))
                                                    break
                                        except Exception:
                                            mid = None
                                        if mid == cap_id:
                                            for nk in ('name','username','user','display_name'):
                                                nv = m.get(nk)
                                                if isinstance(nv, str) and nv.strip():
                                                    team_captain = nv.strip()
                                                    break
                                            if team_captain:
                                                break
                                except Exception:
                                    pass
                                if not team_captain:
                                    try:
                                        ucap = client.get_user(int(cap_id))
                                        for nk in ('name','username','display_name'):
                                            nv = ucap.get(nk)
                                            if isinstance(nv, str) and nv.strip():
                                                team_captain = nv.strip()
                                                break
                                    except Exception:
                                        pass
                        except Exception:
                            pass
                        # Team last solve
                        try:
                            tsolves = client.list_team_solves(int(tid))
                            if isinstance(tsolves, list) and tsolves:
                                def _tts(s):
                                    try:
                                        for dk in ('date','solved_date','created','submitted'):
                                            v = s.get(dk)
                                            if isinstance(v, str) and v:
                                                return v
                                    except Exception:
                                        return None
                                    return None
                                try:
                                    tsolves_sorted = sorted(tsolves, key=lambda s: (_tts(s) or ''), reverse=True)
                                except Exception:
                                    tsolves_sorted = tsolves
                                lastt = tsolves_sorted[0]
                                tch = None
                                try:
                                    for ck in ('challenge_id','challengeId','challenge','chal'):
                                        if lastt.get(ck) is not None:
                                            tch = int(lastt.get(ck))
                                            break
                                except Exception:
                                    tch = None
                                tname = None
                                if tch is not None:
                                    try:
                                        tname = client.get_challenge_name(tch) or None
                                    except Exception:
                                        tname = None
                                team_last_solve_time = _tts(lastt)
                                team_last_solve_challenge = tname
                        except Exception:
                            pass
                except Exception:
                    pass
        except Exception:
            exists = False
        out.append({
            'username': uname,
            'exists': bool(exists),
            'user_rank': user_rank,
            'user_points': user_points,
            'team_name': team_name,
            'team_rank': team_rank,
            'team_points': team_points,
            'user_id': int(uid) if exists and uid is not None else None,
            'team_id': int(tid) if 'tid' in locals() and tid is not None else None,
            'user_last_solve_time': user_last_solve_time,
            'user_last_solve_challenge': user_last_solve_challenge,
            'team_captain': team_captain,
            'team_size': team_size,
            'team_last_solve_time': team_last_solve_time,
            'team_last_solve_challenge': team_last_solve_challenge,
        })
    category_payload = None
    if not only:
        try:
            category_payload = _build_category_firsts()
        except Exception as exc:
            category_payload = {
                'user': [],
                'team': [],
                'errors': [f'category_firsts: {exc}'],
                'generated_at': datetime.utcnow().isoformat() + 'Z'
            }
    response_payload = {
        'users': out,
        'using_token': bool(client.token),
        'logs': getattr(client, 'logs', []),
    }
    if category_payload is not None:
        response_payload['category_firsts'] = category_payload
    return jsonify(response_payload)


@api_bp.post('/projects/<pid>/ctfd/upload')
@_secure_route()
def ctfd_upload(pid: str):
    """Receive a previously exported CTFd archive (zip) and persist it.
    For now, we only store the file and return basic metadata; parsing/import can be added later.
    """
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({'ok': False, 'error': 'Project not found'}), 404
    try:
        if 'file' not in request.files:
            return jsonify({'ok': False, 'error': 'No file uploaded'}), 400
        f = request.files['file']
        if not f or not getattr(f, 'filename', ''):
            return jsonify({'ok': False, 'error': 'Empty filename'}), 400
        # Store under DATA_DIR/exports/uploads with timestamp to avoid collisions
        uploads_dir = os.path.join(current_app.config['DATA_DIR'], 'exports', 'uploads')
        os.makedirs(uploads_dir, exist_ok=True)
        ts = time.strftime('%Y%m%d-%H%M%S')
        safe_name = secure_filename(f.filename) or 'ctfd_export.zip'
        dest = os.path.join(uploads_dir, f"{ts}-{safe_name}")
        f.save(dest)
        size = 0
        try:
            size = os.path.getsize(dest)
        except Exception:
            size = 0
        logs = [{
            'event': 'ctfd_upload_saved',
            'filename': safe_name,
            'stored_as': dest,
            'size': int(size),
        }]
        return jsonify({'ok': True, 'stored': dest, 'size': int(size), 'logs': logs})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


def _is_valid_url(url: str) -> bool:
    return isinstance(url, str) and (url.startswith("http://") or url.startswith("https://"))


def _is_valid_adaptor_name(name: str) -> bool:
    # Letters only, 1-8 chars
    try:
        return bool(re.fullmatch(r"[A-Za-z]{1,8}", str(name or "")))
    except Exception:
        return False

def _is_valid_tag(tag: str) -> bool:
    try:
        return bool(re.fullmatch(r"[A-Za-z-]*", str(tag or "")))
    except Exception:
        return False

def _sanitize_tag(tag: str) -> str:
    try:
        t = re.sub(r"[^A-Za-z-]+", "-", str(tag or "").strip())
        t = re.sub(r"-+", "-", t).strip('-')
        return t[:24]
    except Exception:
        return ''

def _is_valid_vm_name(name: str) -> bool:
    # Letters, numbers, internal dashes; no leading/trailing dash; length 1-32
    try:
        return bool(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?", str(name or "")))
    except Exception:
        return False

def _sanitize_vm_name(name: str) -> str:
    try:
        n = re.sub(r"[^A-Za-z0-9-]+", "-", str(name or "").strip())
        n = re.sub(r"-+", "-", n).strip('-')
        if not n:
            return 'vm'
        if len(n) > 32:
            n = n[:32].rstrip('-')
        return n or 'vm'
    except Exception:
        return 'vm'


def _validate_project_fields(data: dict) -> list:
    errors = []
    def port_ok(v):
        try:
            iv = int(v)
            return 1 <= iv <= 65535
        except Exception:
            return False

    if "name" in data and not str(data["name"]).strip():
        errors.append("name must be a non-empty string")

    # Tag: letters and dashes only (may be empty)
    if "tag" in data and not _is_valid_tag(data.get("tag", "")):
        errors.append("tag must contain only letters and dashes")

    for k in ["proxmox_url", "guacamole_url", "keycloak_url", "challenge_url"]:
        if k in data and not _is_valid_url(data[k]):
            errors.append(f"{k} must start with http:// or https://")

    for k in [
        "proxmox_api_port", "proxmox_ssh_port",
        "guacamole_port", "keycloak_port", "challenge_port",
        "vnc_start_port"
    ]:
        if k in data and not port_ok(data[k]):
            errors.append(f"{k} must be a valid TCP port (1-65535)")
    if "credentials" in data:
        creds = data["credentials"]
        if not isinstance(creds, list):
            errors.append("credentials must be a list")
        else:
            for c in creds:
                if not isinstance(c, dict):
                    errors.append("credential items must be objects with username/password")
                    break
                username = str(c.get("username", "")).strip()
                password = str(c.get("password", "")).strip()
                if not username:
                    errors.append("credential username must be non-empty")
                    break
                if password and len(password) < 8:
                    errors.append("credential password must be at least 8 characters")
                    break
    return errors


def _project_to_json(p: Project) -> dict:
    d = p.__dict__.copy()
    d["vms"] = [vm.__dict__ for vm in (p.vms or [])]
    # Ensure associated_projects is present and a list of strings
    try:
        assoc = list(getattr(p, 'associated_projects', []) or [])
        d['associated_projects'] = [str(x) for x in assoc if str(x).strip()]
    except Exception:
        d['associated_projects'] = []
    return d


def _project_to_json_filtered(p: Project, include_creds: bool = True, include_vms: bool = True) -> dict:
    """Project to JSON with optional exclusion of credentials or VMs for export.
    When include_vms is False, we still include the VM names (schema: [{name}]) so imports can restore names without images.
    """
    d = _project_to_json(p)
    # Always strip multi-project association metadata from export payloads
    try:
        d.pop('associated_projects', None)
    except Exception:
        pass
    if not include_creds:
        # Remove credentials if present
        d.pop("credentials", None)
    if not include_vms:
        # Keep only VM names (no vmid or other fields)
        try:
            vms_list = d.get('vms') or []
            names_only = []
            for v in vms_list:
                try:
                    nm = (v.get('name') if isinstance(v, dict) else str(v)) or ''
                except Exception:
                    nm = ''
                if nm:
                    names_only.append({'name': nm})
            d['vms'] = names_only
        except Exception:
            d['vms'] = []
    return d


# Projects CRUD
@api_bp.route("/projects", methods=["GET"])
def list_projects():
    # Convert dataclasses to JSON-serializable dicts (including VMConfig)
    projects = [_project_to_json(p) for p in _store().list()]
    return jsonify({"projects": projects})

@api_bp.route("/projects", methods=["POST"])
@_secure_route()
def create_project():
    data = request.get_json(force=True) or {}
    name = data.get("name", "Untitled")
    pid = data.get("id") or str(uuid.uuid4())
    errs = _validate_project_fields(data)
    if errs:
        return jsonify({"errors": errs}), 400
    project = Project(id=pid, name=name)
    for key in [
    "proxmox_url", "proxmox_api_port", "proxmox_ssh_port", "proxmox_api_token", "proxmox_verify_ssl",
        "guacamole_url", "guacamole_port",
        "keycloak_url", "keycloak_port", "keycloak_nodename",
        "challenge_url", "challenge_port",
        "instances", "tag", "vnc_start_port", "credentials",
        # Advanced Proxmox
        "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
        "proxmox_qmrestore_path", "proxmox_storage_volume",
    "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
    "proxmox_use_linked_clones",
    "instance_statuses",
    ]:
        if key in data:
            setattr(project, key, data[key])
    # Optional: associated_projects on create
    try:
        ap = data.get('associated_projects')
        if isinstance(ap, list):
            project.associated_projects = [str(x).strip() for x in ap if str(x).strip()]
    except Exception:
        pass
    # Auto-generate usernames (credentials) with passwords if none provided
    try:
        if not project.credentials:
            total = int(project.instances or 0) or 0
            gen = []
            # Per requirement: only include capital letters in auto-generated passwords
            alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
            def _gen_pw(length=10):  # length set to 10 per new requirement
                return ''.join(secrets.choice(alphabet) for _ in range(length))
            for i in range(total):
                uname = f"user{i+1:02d}"
                gen.append({"username": uname, "password": _gen_pw()})
            project.credentials = gen
    except Exception:
        pass
    _store().upsert(project)
    d = _project_to_json(project)
    return jsonify(d), 201


@api_bp.route("/projects/<pid>", methods=["PATCH"])
@_secure_route()
def update_project(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(force=True) or {}
    errs = _validate_project_fields(data)
    if errs:
        return jsonify({"errors": errs}), 400
    # Updatable fields
    for key in [
        "name",
    "proxmox_url", "proxmox_api_port", "proxmox_ssh_port", "proxmox_api_token", "proxmox_verify_ssl",
        "guacamole_url", "guacamole_port",
        "keycloak_url", "keycloak_port", "keycloak_nodename",
        "challenge_url", "challenge_port",
        "instances", "tag", "vnc_start_port", "credentials",
        # Advanced Proxmox
        "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
        "proxmox_qmrestore_path", "proxmox_storage_volume",
    "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
    "proxmox_use_linked_clones",
    "instance_statuses",
    ]:
        if key in data:
            setattr(proj, key, data[key])
    # Handle associated_projects update with sanitization against known IDs
    if 'associated_projects' in data:
        ap = data.get('associated_projects')
        if not isinstance(ap, list):
            proj.associated_projects = []
        else:
            # Coerce to list[str]
            try:
                ids = [str(x).strip() for x in ap if str(x).strip()]
            except Exception:
                ids = []
            # Remove self and duplicates
            seen = set()
            filtered = []
            for x in ids:
                if x == pid or x in seen:
                    continue
                seen.add(x)
                filtered.append(x)
            # Remove unknown IDs (best-effort against current store)
            try:
                known = {p.id for p in s.list()}
            except Exception:
                known = set()
            filtered = [x for x in filtered if (not known) or (x in known)]
            proj.associated_projects = filtered
    s.upsert(proj)
    d = _project_to_json(proj)
    return jsonify(d)


def _validate_audio_payload(payload):
    errors = []
    if payload is None:
        return errors
    if not isinstance(payload, dict):
        return ["audio payload must be an object"]
    for raw_key, entry in payload.items():
        try:
            key_label = str(raw_key or '').strip()
        except Exception:
            key_label = ''
        key_label = key_label or '(unnamed event)'
        if not isinstance(entry, dict):
            errors.append(f"{key_label}: entry must be an object")
            continue
        sounds = entry.get('sounds')
        if sounds is None:
            sounds = []
        if not isinstance(sounds, list):
            errors.append(f"{key_label}: sounds must be a list")
            continue
        if not sounds and entry.get('dataUrl'):
            sounds = [
                {
                    'dataUrl': entry.get('dataUrl'),
                    'name': entry.get('name'),
                    'size': entry.get('size'),
                    'type': entry.get('type'),
                    'updated': entry.get('updated'),
                }
            ]
        for idx, sound in enumerate(sounds):
            if not isinstance(sound, dict):
                errors.append(f"{key_label} clip {idx + 1}: sound must be an object")
                continue
            data_url = sound.get('dataUrl')
            if not isinstance(data_url, str) or not data_url.startswith('data:'):
                errors.append(f"{key_label} clip {idx + 1}: dataUrl must be a base64 data URI")
                continue
            mime, raw_bytes = ProjectStore._decode_data_url(data_url)
            if raw_bytes is None or raw_bytes == b"":
                errors.append(f"{key_label} clip {idx + 1}: invalid audio data")
                continue
            if len(raw_bytes) > ProjectStore._MAX_AUDIO_BYTES:
                errors.append(f"{key_label} clip {idx + 1}: exceeds {ProjectStore._MAX_AUDIO_BYTES // 1024} KB limit")
                continue
            # Optional: ensure MIME looks like audio but allow arbitrary if provided
    return errors


@api_bp.route("/projects/<pid>/audio", methods=["GET"])
def get_project_audio(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    audio = getattr(proj, 'audio', {}) or {}
    if not isinstance(audio, dict):
        audio = {}
    return jsonify({"audio": audio})


@api_bp.route("/projects/<pid>/audio", methods=["PUT", "PATCH"])
@_secure_route()
def update_project_audio(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    payload = body.get('audio') if isinstance(body, dict) else {}
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return jsonify({"error": "audio must be an object"}), 400
    validation_errors = _validate_audio_payload(payload)
    if validation_errors:
        return jsonify({"errors": validation_errors}), 400
    sanitized = ProjectStore._sanitize_audio_map(payload)
    proj = s.update_audio(pid, sanitized)
    audio = getattr(proj, 'audio', {}) or {}
    return jsonify({"audio": audio})


@api_bp.route("/projects/<pid>/duplicate", methods=["POST"])
@_secure_route()
def duplicate_project(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Not found"}), 404
    try:
        base_name = (proj.name or '').strip() or 'Untitled'
    except Exception:
        base_name = 'Untitled'
    try:
        existing_names = {str((p.name or '').strip()) for p in s.list()}
    except Exception:
        existing_names = set()
    existing_names.discard('')

    def _next_name(base: str, used: set) -> str:
        candidate = f"{base} (Copy)"
        idx = 2
        while candidate in used:
            candidate = f"{base} (Copy {idx})"
            idx += 1
        return candidate

    new_name = _next_name(base_name, existing_names)
    new_proj = copy.deepcopy(proj)
    new_proj.id = str(uuid.uuid4())
    new_proj.name = new_name
    try:
        new_proj.exports = []
    except Exception:
        pass
    try:
        new_proj.instance_statuses = []
    except Exception:
        pass
    try:
        new_proj.associated_projects = []
    except Exception:
        pass
    s.upsert(new_proj)
    d = _project_to_json(new_proj)
    return jsonify(d), 201


# Export project (zip with manifest and materials)
@api_bp.route("/projects/<pid>/export", methods=["GET"])
@_secure_route()
def export_project(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Not found"}), 404
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")

    include_creds = request.args.get("includeCreds", "true").lower() != "false"
    include_vms = request.args.get("includeVms", "true").lower() != "false"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "schemaVersion": 1,
            "project": _project_to_json_filtered(proj, include_creds=include_creds, include_vms=include_vms),
        }
        zf.writestr("project.json", json.dumps(manifest, indent=2))
        _write_project_audio_to_zip(zf, proj)
        for fname in proj.materials:
            fpath = os.path.join(mats_dir, fname)
            if os.path.isfile(fpath):
                # Also include under materials/<pid>/ for future compatibility
                zf.write(fpath, arcname=f"materials/{fname}")
                zf.write(fpath, arcname=f"materials/{pid}/{os.path.basename(fname)}")
    buf.seek(0)
    # Build friendly filename: <projectName>_YYYYMMDD_HHMMSS.zip
    try:
        import datetime as _dt
        proj_name = getattr(proj, 'name', '') or pid
        stem = _safe_file_stem(proj_name)
        stamp = _format_ymdhms(_dt.datetime.utcnow())
        fname = f"{stem}_{stamp}.zip"
    except Exception:
        fname = f"project_{pid}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


# Import project (zip) — synchronous legacy endpoint (kept for backward compatibility)
@api_bp.route("/projects/import", methods=["POST"])
def import_project():
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files['file']
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
    # Import selection flags (default true when not specified)
    try:
        include_creds = (request.form.get('includeCreds', 'true').lower() != 'false')
        include_vms = (request.form.get('includeVms', 'true').lower() != 'false')
    except Exception:
        include_creds, include_vms = True, True
    s = _store()
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")
    os.makedirs(mats_dir, exist_ok=True)

    # Save upload to a temporary file to avoid loading large archives into memory
    import tempfile
    uploads_dir = os.path.join(current_app.config["DATA_DIR"], "uploads")
    try:
        os.makedirs(uploads_dir, exist_ok=True)
    except Exception:
        uploads_dir = None  # fallback to system temp
    tmp_fd = None
    tmp_path = None
    try:
        if uploads_dir:
            tmp_fd, tmp_path = tempfile.mkstemp(prefix="import_", suffix=".zip", dir=uploads_dir)
            try: os.close(tmp_fd)
            except Exception: pass
        else:
            tmp_fd, tmp_path = tempfile.mkstemp(prefix="import_", suffix=".zip")
            try: os.close(tmp_fd)
            except Exception: pass
        file.save(tmp_path)
        with zipfile.ZipFile(tmp_path) as zf:
            # Load manifest
            with zf.open('project.json') as mf:
                manifest = json.load(mf)

            results = []
            if 'projects' in manifest:  # multi-project import
                orig_list = manifest['projects']
                # map original id -> new id (build first so associations can be remapped)
                id_map = {}
                try:
                    for pdata in (orig_list or []):
                        if isinstance(pdata, dict) and pdata.get('id'):
                            id_map[str(pdata.get('id'))] = str(uuid.uuid4())
                except Exception:
                    pass
                errors = []
                for pdata in orig_list:
                    # sanitize copy: tag and any VM names
                    pdata2 = dict(pdata)
                    if 'tag' in pdata2:
                        pdata2['tag'] = _sanitize_tag(pdata2.get('tag', ''))
                    # Apply import selection: remove credentials/VMs as requested
                    if not include_creds:
                        pdata2.pop('credentials', None)
                    if not include_vms:
                        # Keep VM names only (no vmid or extra fields)
                        try:
                            vlist = pdata2.get('vms') or []
                            names_only = []
                            if isinstance(vlist, list):
                                for vm in vlist:
                                    nm = ''
                                    if isinstance(vm, dict):
                                        nm = str(vm.get('name', '')).strip()
                                    elif isinstance(vm, str):
                                        nm = vm.strip()
                                    if nm:
                                        names_only.append({ 'name': _sanitize_vm_name(nm) })
                            pdata2['vms'] = names_only
                        except Exception:
                            pdata2['vms'] = []
                    try:
                        vlist = pdata2.get('vms') or []
                        if isinstance(vlist, list):
                            for vm in vlist:
                                if isinstance(vm, dict) and 'name' in vm:
                                    vm['name'] = _sanitize_vm_name(vm.get('name', ''))
                    except Exception:
                        pass
                    errs = _validate_project_fields(pdata2)
                    if errs:
                        errors.append({
                            'sourceId': pdata2.get('id'),
                            'name': pdata2.get('name', ''),
                            'errors': errs,
                        })
                        continue
                    # Use precomputed id_map
                    src_id = str(pdata2.get('id', '') or '')
                    new_id = id_map.get(src_id) or str(uuid.uuid4())
                    proj = Project(id=new_id, name=pdata2.get('name', 'Imported'))
                    for key in [
                        "proxmox_url", "proxmox_api_port", "proxmox_ssh_port",
                        "guacamole_url", "guacamole_port",
                        "keycloak_url", "keycloak_port", "keycloak_nodename",
                        "challenge_url", "challenge_port",
                        "instances", "tag", "vnc_start_port", "credentials",
                        "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
                        "proxmox_qmrestore_path", "proxmox_storage_volume",
                        "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
                    ]:
                        if key in pdata2:
                            setattr(proj, key, pdata2[key])
                    s.upsert(proj)
                    id_map[pdata2.get('id','')] = new_id
                    results.append(proj.__dict__)

                # Import materials grouped by original id (materials/<orig_id>/filename)
                for zname in zf.namelist():
                    if not zname.startswith('materials/') or zname.endswith('/'):
                        continue
                    parts = zname.split('/')
                    if len(parts) >= 3:
                        orig_id = parts[1]
                        base = os.path.basename(zname)
                        safe = secure_filename(base) or base
                        target = id_map.get(orig_id)
                        if not target:
                            continue
                        new_name = f"{target}_{uuid.uuid4().hex}_{safe}"
                        with zf.open(zname) as src, open(os.path.join(mats_dir, new_name), 'wb') as dst:
                            dst.write(src.read())
                        # append to project
                        proj = s.get(target)
                        if proj:
                            proj.materials.append(new_name)
                            s.upsert(proj)

                if results and errors:
                    return jsonify({"imported": results, "errors": errors}), 201
                if not results and errors:
                    return jsonify({"errors": errors}), 400
                return jsonify({"imported": results}), 201

            else:  # single project import
                pdata = manifest.get('project', {})
                pdata2 = dict(pdata)
                if 'tag' in pdata2:
                    pdata2['tag'] = _sanitize_tag(pdata2.get('tag', ''))
                # Apply import selection: remove credentials/VMs as requested
                if not include_creds:
                    pdata2.pop('credentials', None)
                if not include_vms:
                    # Keep VM names only (no vmid or extra fields)
                    try:
                        vlist = pdata2.get('vms') or []
                        names_only = []
                        if isinstance(vlist, list):
                            for vm in vlist:
                                nm = ''
                                if isinstance(vm, dict):
                                    nm = str(vm.get('name', '')).strip()
                                elif isinstance(vm, str):
                                    nm = vm.strip()
                                if nm:
                                    names_only.append({ 'name': _sanitize_vm_name(nm) })
                        pdata2['vms'] = names_only
                    except Exception:
                        pdata2['vms'] = []
                try:
                    vlist = pdata2.get('vms') or []
                    if isinstance(vlist, list):
                        for vm in vlist:
                            if isinstance(vm, dict) and 'name' in vm:
                                vm['name'] = _sanitize_vm_name(vm.get('name', ''))
                except Exception:
                    pass
                errs = _validate_project_fields(pdata2)
                if errs:
                    return jsonify({"errors": errs}), 400
                new_id = str(uuid.uuid4())
                project = Project(id=new_id, name=pdata2.get('name', 'Imported'))
                for key in [
                    "proxmox_url", "proxmox_api_port", "proxmox_ssh_port",
                    "guacamole_url", "guacamole_port",
                    "keycloak_url", "keycloak_port", "keycloak_nodename",
                    "challenge_url", "challenge_port",
                    "instances", "tag", "vnc_start_port", "credentials",
                    "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
                    "proxmox_qmrestore_path", "proxmox_storage_volume",
                    "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
                ]:
                    if key in pdata2:
                        setattr(project, key, pdata2[key])
                # For single-project import, drop associations (targets unknown)
                try:
                    project.associated_projects = []
                except Exception:
                    pass
                try:
                    if 'audio' in pdata2:
                        project.audio = ProjectStore._sanitize_audio_map(pdata2.get('audio'))
                except Exception:
                    project.audio = getattr(project, 'audio', {}) or {}

                # Import materials at materials/* or materials/<orig_id>/*
                imported = []
                for zname in zf.namelist():
                    if not zname.startswith('materials/') or zname.endswith('/'):
                        continue
                    base = os.path.basename(zname)
                    safe = secure_filename(base) or base
                    new_name = f"{new_id}_{uuid.uuid4().hex}_{safe}"
                    with zf.open(zname) as src, open(os.path.join(mats_dir, new_name), 'wb') as dst:
                        dst.write(src.read())
                    imported.append(new_name)
                project.materials = imported

                s.upsert(project)
                return jsonify(project.__dict__), 201
    except KeyError:
        return jsonify({"error": "Invalid archive: missing project.json"}), 400
    except zipfile.BadZipFile:
        return jsonify({"error": "Invalid zip file"}), 400
    except Exception as e:
        return jsonify({"error": f"Import failed: {e}"}), 400
    finally:
        try:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


# -------- Asynchronous Import with status/logs (like export) --------

def _import_job_key(job_id: str) -> str:
    return f"import:{job_id}"

def _import_job_record(job_id: str):
    rec = {
        'id': job_id,
        'action': 'import',
        'status': 'queued',
        'progress': 0,
        'log': [],
        'errors': [],
        'imported': [],
    'cancel': False,
    # best-effort cleanup bookkeeping
    'remote_base': '',
    'local_tmp': '',
    'ssh_host': '',
    'ssh_port': 22,
    'ssh_user': '',
    'ssh_pass': '',
    }
    _ACTIVE_JOBS[_import_job_key(job_id)] = rec
    return rec

def _emit_import(job_id: str, msg: str):
    try:
        _ACTIVE_JOBS[_import_job_key(job_id)]['log'].append(msg)
    except Exception:
        pass
    try:
        current_app.logger.debug(f"import[{job_id}] {msg}")
    except Exception:
        pass


@api_bp.route("/projects/import/start", methods=["POST"])
@_secure_route()
def import_project_start():
    """Upload a ZIP and start an async import job. Returns { job }.
    UI should track upload progress via XHR, then poll /projects/import/status?id=JOB.
    """
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files['file']
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
    # Import selection flags (default true when not specified)
    try:
        include_creds = (request.form.get('includeCreds', 'true').lower() != 'false')
        include_vms = (request.form.get('includeVms', 'true').lower() != 'false')
    except Exception:
        include_creds, include_vms = True, True
    # Optional Proxmox connection parameters for VM restore
    prox = {
        'baseUrl': (request.form.get('baseUrl') or '').strip(),
        'apiPort': request.form.get('apiPort'),
        'sshPort': request.form.get('sshPort'),
        'username': (request.form.get('username') or '').strip(),
        'password': request.form.get('password') or '',
        'verifySSL': (request.form.get('verifySSL', 'true').lower() != 'false'),
    }

    # Persist upload to temp file first (this request handles the upload body)
    import tempfile
    uploads_dir = os.path.join(current_app.config["DATA_DIR"], "uploads")
    os.makedirs(uploads_dir, exist_ok=True)
    tmp_fd = None
    tmp_path = None
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(prefix="import_", suffix=".zip", dir=uploads_dir)
        os.close(tmp_fd)
        file.save(tmp_path)
    except Exception as e:
        try:
            if tmp_fd:
                os.close(tmp_fd)
        except Exception:
            pass
        return jsonify({"error": f"Failed to save upload: {e}"}), 400

    # Create job record and spawn worker
    job_id = uuid.uuid4().hex
    _import_job_record(job_id)
    app_obj = current_app._get_current_object()

    def worker(job: str, path: str, include_creds: bool, include_vms: bool):
        # Ensure app context in thread
        with app_obj.app_context():
            key = _import_job_key(job)
            try:
                if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                    _ACTIVE_JOBS[key]['status'] = 'cancelled'
                    return
                _ACTIVE_JOBS[key]['status'] = 'processing'
                _ACTIVE_JOBS[key]['progress'] = 0
                _emit_import(job, f"[FILE] {os.path.basename(path)}")
                # Open ZIP and inspect manifest
                with zipfile.ZipFile(path) as zf:
                    try:
                        with zf.open('project.json') as mf:
                            manifest = json.load(mf)
                        _emit_import(job, "[PARSE] project.json loaded")
                    except KeyError:
                        raise RuntimeError("Invalid archive: missing project.json")

                    s = _store()
                    mats_dir = os.path.join(app_obj.config["DATA_DIR"], "materials")
                    os.makedirs(mats_dir, exist_ok=True)

                    # Determine total steps for progress
                    def list_materials():
                        items = []
                        try:
                            for zname in zf.namelist():
                                if zname.startswith('materials/') and not zname.endswith('/'):
                                    items.append(zname)
                        except Exception:
                            pass
                        return items
                    mat_list = list_materials()
                    total_steps = 0
                    if 'projects' in manifest:
                        total_steps = len(manifest.get('projects') or []) + len(mat_list)
                    else:
                        total_steps = 1 + len(mat_list)
                    done_steps = 0

                    def _tick(status_msg: str = None):
                        nonlocal done_steps, total_steps
                        if status_msg:
                            _ACTIVE_JOBS[key]['status'] = status_msg
                        try:
                            pct = int((done_steps * 100) / max(total_steps or 1, 1))
                            pct = max(0, min(99, pct))
                            _ACTIVE_JOBS[key]['progress'] = pct
                        except Exception:
                            pass

                    results = []
                    errors = []

                    if 'projects' in manifest:  # multi-project
                        orig_list = manifest.get('projects') or []
                        id_map = {}
                        for pdata in orig_list:
                            if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                                _ACTIVE_JOBS[key]['status'] = 'cancelled'
                                return
                            pdata2 = dict(pdata or {})
                            if 'tag' in pdata2:
                                pdata2['tag'] = _sanitize_tag(pdata2.get('tag', ''))
                            if not include_creds:
                                pdata2.pop('credentials', None)
                            if not include_vms:
                                # Preserve VM configuration (names/adaptors, commands), but clear vmid to avoid stale IDs
                                try:
                                    vlist = pdata2.get('vms') or []
                                    kept = []
                                    if isinstance(vlist, list):
                                        for vm in vlist:
                                            rec = {}
                                            if isinstance(vm, dict):
                                                rec = dict(vm)
                                            elif isinstance(vm, str):
                                                rec = { 'name': vm }
                                            # sanitize name and drop vmid
                                            nm = _sanitize_vm_name(str(rec.get('name','')).strip())
                                            if not nm:
                                                continue
                                            rec['name'] = nm
                                            if 'vmid' in rec:
                                                try: del rec['vmid']
                                                except Exception: rec['vmid'] = None
                                            kept.append(rec)
                                    pdata2['vms'] = kept
                                except Exception:
                                    pdata2['vms'] = []
                            try:
                                vlist = pdata2.get('vms') or []
                                if isinstance(vlist, list):
                                    for vm in vlist:
                                        if isinstance(vm, dict) and 'name' in vm:
                                            vm['name'] = _sanitize_vm_name(vm.get('name', ''))
                            except Exception:
                                pass
                            errs = _validate_project_fields(pdata2)
                            if errs:
                                errors.append({'sourceId': pdata2.get('id'), 'name': pdata2.get('name',''), 'errors': errs})
                                _emit_import(job, f"[SKIP] {pdata2.get('name','')} — invalid: {errs}")
                                done_steps += 1; _tick('processing')
                                continue
                            new_id = str(uuid.uuid4())
                            proj = Project(id=new_id, name=pdata2.get('name', 'Imported'))
                            for key_field in [
                                "proxmox_url", "proxmox_api_port", "proxmox_ssh_port",
                                "guacamole_url", "guacamole_port",
                                "keycloak_url", "keycloak_port", "keycloak_nodename",
                                "challenge_url", "challenge_port",
                                "instances", "tag", "vnc_start_port", "credentials",
                                "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
                                "proxmox_qmrestore_path", "proxmox_storage_volume",
                                "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
                            ]:
                                if key_field in pdata2:
                                    setattr(proj, key_field, pdata2[key_field])
                            # Preserve VM entries from manifest (names, adaptors, commands, etc.)
                            try:
                                vlist = pdata2.get('vms') or []
                                kept = []
                                if isinstance(vlist, list):
                                    for vm in vlist:
                                        rec = dict(vm) if isinstance(vm, dict) else ({'name': str(vm)} if isinstance(vm, str) else {})
                                        nm = _sanitize_vm_name(str(rec.get('name','')).strip())
                                        if not nm:
                                            continue
                                        rec['name'] = nm
                                        if not include_vms and 'vmid' in rec:
                                            try: del rec['vmid']
                                            except Exception: rec['vmid'] = None
                                        kept.append(rec)
                                proj.vms = kept
                            except Exception:
                                proj.vms = []
                            try:
                                if 'audio' in pdata2:
                                    proj.audio = ProjectStore._sanitize_audio_map(pdata2.get('audio'))
                            except Exception:
                                proj.audio = getattr(proj, 'audio', {}) or {}
                            # If user provided Proxmox connection in the dialog, store it on the project
                            try:
                                if prox.get('baseUrl'):
                                    proj.proxmox_url = prox.get('baseUrl')
                                if prox.get('apiPort') not in (None, ''):
                                    try: proj.proxmox_api_port = int(prox.get('apiPort'))
                                    except Exception: proj.proxmox_api_port = prox.get('apiPort')
                                if prox.get('sshPort') not in (None, ''):
                                    try: proj.proxmox_ssh_port = int(prox.get('sshPort'))
                                    except Exception: proj.proxmox_ssh_port = prox.get('sshPort')
                                if 'verifySSL' in prox:
                                    proj.proxmox_verify_ssl = bool(prox.get('verifySSL'))
                            except Exception:
                                pass
                            s.upsert(proj)
                            id_map[pdata2.get('id','')] = new_id
                            results.append(proj.__dict__)
                            _emit_import(job, f"[CREATE] project: {proj.name} ({new_id})")
                            done_steps += 1; _tick('processing')

                        # Materials grouped by original id path
                        for zname in mat_list:
                            if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                                _ACTIVE_JOBS[key]['status'] = 'cancelled'
                                return
                            parts = zname.split('/')
                            if len(parts) >= 3:
                                orig_id = parts[1]
                                base = os.path.basename(zname)
                                safe = secure_filename(base) or base
                                target = id_map.get(orig_id)
                                if not target:
                                    continue
                                new_name = f"{target}_{uuid.uuid4().hex}_{safe}"
                                with zf.open(zname) as src, open(os.path.join(mats_dir, new_name), 'wb') as dst:
                                    dst.write(src.read())
                                proj = s.get(target)
                                if proj:
                                    proj.materials.append(new_name)
                                    s.upsert(proj)
                                _emit_import(job, f"[WRITE] materials/{orig_id}/{base} -> {new_name}")
                            done_steps += 1; _tick('materials')

                        # Associations are intentionally ignored on import

                    else:  # single project
                        if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                            _ACTIVE_JOBS[key]['status'] = 'cancelled'
                            return
                        pdata = dict((manifest.get('project') or {}))
                        pdata2 = dict(pdata)
                        if 'tag' in pdata2:
                            pdata2['tag'] = _sanitize_tag(pdata2.get('tag', ''))
                        if not include_creds:
                            pdata2.pop('credentials', None)
                        if not include_vms:
                            # Preserve VM configuration but clear vmid to avoid stale IDs
                            try:
                                vlist = pdata2.get('vms') or []
                                kept = []
                                if isinstance(vlist, list):
                                    for vm in vlist:
                                        rec = {}
                                        if isinstance(vm, dict):
                                            rec = dict(vm)
                                        elif isinstance(vm, str):
                                            rec = { 'name': vm }
                                        nm = _sanitize_vm_name(str(rec.get('name','')).strip())
                                        if not nm:
                                            continue
                                        rec['name'] = nm
                                        if 'vmid' in rec:
                                            try: del rec['vmid']
                                            except Exception: rec['vmid'] = None
                                        kept.append(rec)
                                pdata2['vms'] = kept
                            except Exception:
                                pdata2['vms'] = []
                        try:
                            vlist = pdata2.get('vms') or []
                            if isinstance(vlist, list):
                                for vm in vlist:
                                    if isinstance(vm, dict) and 'name' in vm:
                                        vm['name'] = _sanitize_vm_name(vm.get('name', ''))
                        except Exception:
                            pass
                        errs = _validate_project_fields(pdata2)
                        if errs:
                            errors.extend(errs)
                            raise RuntimeError(f"Invalid project manifest: {errs}")
                        new_id = str(uuid.uuid4())
                        project = Project(id=new_id, name=pdata2.get('name', 'Imported'))
                        for key_field in [
                            "proxmox_url", "proxmox_api_port", "proxmox_ssh_port",
                            "guacamole_url", "guacamole_port",
                            "keycloak_url", "keycloak_port", "keycloak_nodename",
                            "challenge_url", "challenge_port",
                            "instances", "tag", "vnc_start_port", "credentials",
                            "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
                            "proxmox_qmrestore_path", "proxmox_storage_volume",
                            "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
                        ]:
                            if key_field in pdata2:
                                setattr(project, key_field, pdata2[key_field])
                        # Preserve VM entries from manifest
                        try:
                            vlist = pdata2.get('vms') or []
                            kept = []
                            if isinstance(vlist, list):
                                for vm in vlist:
                                    rec = dict(vm) if isinstance(vm, dict) else ({'name': str(vm)} if isinstance(vm, str) else {})
                                    nm = _sanitize_vm_name(str(rec.get('name','')).strip())
                                    if not nm:
                                        continue
                                    rec['name'] = nm
                                    if not include_vms and 'vmid' in rec:
                                        try: del rec['vmid']
                                        except Exception: rec['vmid'] = None
                                    kept.append(rec)
                            project.vms = kept
                        except Exception:
                            project.vms = []
                        try:
                            if 'audio' in pdata2:
                                project.audio = ProjectStore._sanitize_audio_map(pdata2.get('audio'))
                        except Exception:
                            project.audio = getattr(project, 'audio', {}) or {}
                        # If user provided Proxmox connection in the dialog, store it on the project
                        try:
                            if prox.get('baseUrl'):
                                project.proxmox_url = prox.get('baseUrl')
                            if prox.get('apiPort') not in (None, ''):
                                try: project.proxmox_api_port = int(prox.get('apiPort'))
                                except Exception: project.proxmox_api_port = prox.get('apiPort')
                            if prox.get('sshPort') not in (None, ''):
                                try: project.proxmox_ssh_port = int(prox.get('sshPort'))
                                except Exception: project.proxmox_ssh_port = prox.get('sshPort')
                            if 'verifySSL' in prox:
                                project.proxmox_verify_ssl = bool(prox.get('verifySSL'))
                        except Exception:
                            pass
                        # Materials (both materials/* and materials/<orig_id>/*)
                        imported = []
                        for zname in mat_list:
                            if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                                _ACTIVE_JOBS[key]['status'] = 'cancelled'
                                return
                            base = os.path.basename(zname)
                            safe = secure_filename(base) or base
                            new_name = f"{new_id}_{uuid.uuid4().hex}_{safe}"
                            with zf.open(zname) as src, open(os.path.join(mats_dir, new_name), 'wb') as dst:
                                dst.write(src.read())
                            imported.append(new_name)
                            _emit_import(job, f"[WRITE] {zname} -> {new_name}")
                            done_steps += 1; _tick('materials')
                        project.materials = imported
                        s.upsert(project)
                        results.append(project.__dict__)
                        _emit_import(job, f"[CREATE] project: {project.name} ({new_id})")
                        done_steps += 1; _tick('processing')

                        # Optional VM restore: look for backups/* in archive and restore to Proxmox when requested
                        if include_vms:
                            try:
                                # Prepare Proxmox connection details
                                base_url = prox.get('baseUrl') or ''
                                api_port = prox.get('apiPort')
                                ssh_port = int(prox.get('sshPort') or 22)
                                vssl = bool(prox.get('verifySSL'))
                                username = prox.get('username') or ''
                                password = prox.get('password') or ''
                                if not (base_url and username and password):
                                    _emit_import(job, "[SKIP] VM restore: missing Proxmox connection details")
                                else:
                                    # Normalize base_url with api_port
                                    try:
                                        if api_port is not None and str(api_port).strip() != '':
                                            p = urlparse(base_url)
                                            host = p.hostname or ''
                                            scheme = p.scheme or 'https'
                                            netloc = host
                                            if p.username:
                                                auth = p.username
                                                if p.password:
                                                    auth += f":{p.password}"
                                                netloc = f"{auth}@{netloc}"
                                            netloc = f"{netloc}:{int(api_port)}"
                                            base_url = urlunparse((scheme, netloc, '', '', '', ''))
                                    except Exception:
                                        pass
                                    host = _parse_host_from_url(base_url)
                                    ssh_user = username.split('@')[0] if '@' in username else username
                                    use_sudo = (str(ssh_user).strip().lower() != 'root')
                                    # Connect SSH
                                    _emit_import(job, f"[SSH] connect {host}:{ssh_port} as {ssh_user}")
                                    c = _ssh_connect(host, ssh_port, ssh_user, password)
                                    try:
                                        # Create a per-run temp dir owned by the SSH user to allow SFTP writes
                                        epoch = int(time.time())
                                        remote_base = f"/tmp/an3s_import_{new_id}_{epoch}"
                                        _emit_import(job, f"[SSH] mkdir -p {remote_base}")
                                        # Important: do NOT use sudo here so the directory is owned by ssh_user
                                        _ssh_run_cmd(c, f"mkdir -p {remote_base}", sudo=False, sudo_password="")
                                        # Track for cleanup on cancel
                                        try:
                                            _ACTIVE_JOBS[key]['remote_base'] = remote_base
                                            _ACTIVE_JOBS[key]['ssh_host'] = host
                                            _ACTIVE_JOBS[key]['ssh_port'] = int(ssh_port)
                                            _ACTIVE_JOBS[key]['ssh_user'] = ssh_user
                                            _ACTIVE_JOBS[key]['ssh_pass'] = password
                                        except Exception:
                                            pass
                                        sftp = c.open_sftp()
                                        # Discover vzdump backup archives in zip (ignore .log and other non-archives)
                                        backups = [
                                            n for n in zf.namelist()
                                            if n.startswith('backups/')
                                            and not n.endswith('/')
                                            and n.lower().endswith(('.vma.zst', '.vma.lzo', '.vma.gz'))
                                        ]
                                        _emit_import(job, f"[INFO] found {len(backups)} backup archive(s) (.vma.zst/.lzo/.gz); skipping .log files")
                                        if not backups:
                                            _emit_import(job, "[INFO] No backups/ found in archive; skipping VM restore")
                                        else:
                                            # Proxmox API client for nextid and optional settings
                                            client = ProxmoxClient(base_url=base_url, token=None, verify=vssl, username=username, password=password)
                                            storage = getattr(project, 'proxmox_storage_volume', None) or getattr(project, 'proxmox_storage_volume', None) or 'local-lvm'
                                            restored = []  # list of (vm_name, vmid)
                                            # Group backups by vm_name
                                            by_vm = {}
                                            for n in backups:
                                                parts = n.split('/')
                                                if len(parts) >= 3:
                                                    by_vm.setdefault(parts[1], []).append(n)
                                            for vm_name, files in by_vm.items():
                                                # Choose first file for restore
                                                zname = sorted(files)[0]
                                                base = os.path.basename(zname)
                                                remote_path = f"{remote_base}/{base}"
                                                _emit_import(job, f"[SFTP] upload {zname} -> {remote_path}")
                                                # Upload with SFTP putfo + callback for reliable percentage
                                                try:
                                                    zi = zf.getinfo(zname)
                                                except Exception:
                                                    zi = None
                                                total = 0
                                                try:
                                                    total = int(getattr(zi, 'file_size', 0) or 0)
                                                    if total == 0:
                                                        total = int(getattr(zi, 'compress_size', 0) or 0)
                                                except Exception:
                                                    total = 0
                                                last_pct = -1
                                                last_emit_t = time.time()
                                                def _cb(bytes_sent, _total=total, _vm=vm_name, _fname=base):
                                                    nonlocal last_pct, last_emit_t
                                                    try:
                                                        pct = int((int(bytes_sent) * 100) / int(_total)) if _total else 0
                                                    except Exception:
                                                        pct = 0
                                                    now = time.time()
                                                    if pct != last_pct or (now - last_emit_t) >= 0.5:
                                                        last_emit_t = now
                                                        last_pct = pct
                                                        try:
                                                            _ACTIVE_JOBS[key]['status'] = f"Uploading {_vm} {pct}%"
                                                        except Exception:
                                                            pass
                                                        _emit_import(job, f"[SFTP][UP] {_vm}/{_fname}: {int(bytes_sent)}/{_total} ({pct}%)")
                                                with zf.open(zname, 'r') as src:
                                                    # Provide file_size when available so callbacks can compute %
                                                    try:
                                                        sftp.putfo(src, remote_path, file_size=(total or None), callback=_cb)
                                                    except TypeError:
                                                        # Older paramiko signature may differ; try without file_size
                                                        sftp.putfo(src, remote_path, callback=_cb)
                                                # Determine new VMID
                                                try:
                                                    vmid = int(client.cluster_nextid())
                                                except Exception as e:
                                                    _emit_import(job, f"[ERR] nextid failed: {e}; using fallback")
                                                    vmid = None
                                                if vmid is None:
                                                    # crude fallback
                                                    vmid = int(time.time()) % 100000
                                                # Restore with streaming logs from remote command (helper)
                                                cmd = f"{getattr(project, 'proxmox_qmrestore_path', 'qmrestore')} {remote_path} {vmid} --unique 1"
                                                if storage: cmd += f" --storage {storage}"
                                                def _on_qmrestore_line(txt, vm=vm_name):
                                                    try:
                                                        m = re.search(r"(\d{1,3})%", txt)
                                                        if m:
                                                            pct = max(0, min(100, int(m.group(1))))
                                                            _ACTIVE_JOBS[key]['status'] = f"Restoring {vm} {pct}%"
                                                    except Exception:
                                                        pass
                                                _ssh_run_stream(
                                                    c,
                                                    cmd,
                                                    sudo=use_sudo,
                                                    sudo_password=password,
                                                    emit=lambda m: _emit_import(job, m),
                                                    on_stdout_line=_on_qmrestore_line,
                                                )
                                                # Optionally set name after restore, with basic logging
                                                try:
                                                    setname = f"qm set {vmid} --name {vm_name}"
                                                    _ssh_run_stream(
                                                        c,
                                                        setname,
                                                        sudo=use_sudo,
                                                        sudo_password=password,
                                                        emit=lambda m: _emit_import(job, m),
                                                    )
                                                except Exception:
                                                    pass
                                                restored.append((vm_name, vmid))
                                            # Merge restored VMIDs onto existing VM entries, preserving other fields
                                            try:
                                                vlist = []
                                                for vm in (getattr(project, 'vms', []) or []):
                                                    if isinstance(vm, dict):
                                                        rec = dict(vm)
                                                    else:
                                                        rec = { 'name': str(vm) }
                                                    nm = str(rec.get('name','')).strip()
                                                    if nm:
                                                        rid = next((vid for (n, vid) in restored if n == nm), None)
                                                        if rid is not None:
                                                            rec['vmid'] = int(rid)
                                                    vlist.append(rec)
                                                project.vms = vlist
                                                s.upsert(project)
                                            except Exception:
                                                pass
                                    finally:
                                        try:
                                            c.close()
                                        except Exception:
                                            pass
                            except Exception as e:
                                _emit_import(job, f"[WARN] VM restore step failed: {e}")

                    _ACTIVE_JOBS[key]['imported'] = results
                    _ACTIVE_JOBS[key]['errors'] = errors
                    if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                        _ACTIVE_JOBS[key]['status'] = 'cancelled'
                        _emit_import(job, "[CANCELLED] import cancelled")
                    else:
                        _ACTIVE_JOBS[key]['progress'] = 100
                        _ACTIVE_JOBS[key]['status'] = 'completed'
                        _emit_import(job, "[OK] import completed")
            except Exception as e:
                try:
                    _ACTIVE_JOBS[key]['status'] = 'error'
                    _ACTIVE_JOBS[key]['errors'] = _ACTIVE_JOBS.get(key, {}).get('errors', []) + [str(e)]
                    _emit_import(job, f"[ERR] {e}")
                except Exception:
                    pass
            finally:
                # Cleanup temp file
                try:
                    if path and os.path.exists(path):
                        os.remove(path)
                except Exception:
                    pass
                # If job was cancelled, attempt best-effort remote cleanup here too
                try:
                    jb = _ACTIVE_JOBS.get(key) or {}
                    if jb.get('cancel'):
                        rb = jb.get('remote_base')
                        if rb:
                            try:
                                h = jb.get('ssh_host') or ''
                                prt = int(jb.get('ssh_port') or 22)
                                usr = jb.get('ssh_user') or ''
                                pwd = jb.get('ssh_pass') or ''
                                if h and usr:
                                    c2 = _ssh_connect(h, prt, usr, pwd)
                                    try:
                                        # Use sudo only if user isn't root
                                        use_sudo2 = (str(usr).strip().lower() != 'root')
                                        _ssh_run_cmd(c2, f"rm -rf {rb}", sudo=use_sudo2, sudo_password=pwd)
                                        _emit_import(job, f"[CLEANUP] removed remote {rb}")
                                    finally:
                                        try: c2.close()
                                        except Exception: pass
                            except Exception:
                                pass
                        # Local upload file is already removed above
                except Exception:
                    pass

    t = threading.Thread(target=worker, args=(job_id, tmp_path, include_creds, include_vms), daemon=True)
    t.start()
    return jsonify({"job": job_id})


@api_bp.route("/projects/import/status", methods=["GET"])
def import_project_status():
    job = request.args.get('id') or request.args.get('job')
    if not job:
        return jsonify({"error": "Missing job id"}), 400
    rec = _ACTIVE_JOBS.get(_import_job_key(job))
    if not rec or rec.get('action') != 'import':
        return jsonify({"error": "No such job"}), 404
    # Shallow copy without temp paths
    return jsonify({
        'id': rec.get('id'),
        'status': rec.get('status'),
        'progress': rec.get('progress', 0),
        'phase': rec.get('phase'),
        'step': rec.get('step'),
        'total_steps': rec.get('total_steps'),
        'current': rec.get('current'),
        'message': rec.get('message'),
        'eta': rec.get('eta'),
        'log': rec.get('log', []),
        'errors': rec.get('errors', []),
        'imported': rec.get('imported', []),
    })


@api_bp.route("/projects/import/cancel", methods=["POST"])
def import_project_cancel():
    job = request.args.get('id') or request.args.get('job')
    if not job:
        return jsonify({"error": "Missing job id"}), 400
    key = _import_job_key(job)
    rec = _ACTIVE_JOBS.get(key)
    if not rec or rec.get('action') != 'import':
        return jsonify({"error": "No such job"}), 404
    rec['cancel'] = True
    _ACTIVE_JOBS[key] = rec
    # Best-effort immediate cleanup of any tracked remote temp dir
    try:
        rb = rec.get('remote_base')
        if rb:
            h = rec.get('ssh_host') or ''
            prt = int(rec.get('ssh_port') or 22)
            usr = rec.get('ssh_user') or ''
            pwd = rec.get('ssh_pass') or ''
            if h and usr:
                c = _ssh_connect(h, prt, usr, pwd)
                try:
                    use_sudo = (str(usr).strip().lower() != 'root')
                    _ssh_run_cmd(c, f"rm -rf {rb}", sudo=use_sudo, sudo_password=pwd)
                    try:
                        rec['log'] = rec.get('log', []) + [f"[CLEANUP] removed remote {rb}"]
                    except Exception:
                        pass
                finally:
                    try: c.close()
                    except Exception: pass
    except Exception as e:
        try:
            rec['log'] = rec.get('log', []) + [f"[CLEANUP][WARN] remote cleanup failed: {e}"]
        except Exception:
            pass
    return ('', 204)


# Export multiple projects
@api_bp.route("/projects/export", methods=["GET"])
def export_projects():
    s = _store()
    ids = request.args.get("ids")
    include_materials = request.args.get("includeMaterials", "true").lower() != "false"
    include_creds = request.args.get("includeCreds", "true").lower() != "false"
    include_vms = request.args.get("includeVms", "true").lower() != "false"
    # Enforce explicit, single-project selection
    if not ids:
        return jsonify({"error": "ids query parameter is required (single project id)"}), 400
    wanted_list = [i.strip() for i in ids.split(",") if i.strip()]
    if len(wanted_list) != 1:
        return jsonify({"error": "Only a single project can be exported at a time"}), 400
    wanted_id = wanted_list[0]
    proj = s.get(wanted_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "schemaVersion": 1,
            # Backward-compat: keep top-level key as 'projects' but only include the single selected project
            "projects": [_project_to_json_filtered(proj, include_creds=include_creds, include_vms=include_vms)],
        }
        zf.writestr("project.json", json.dumps(manifest, indent=2))
        if include_materials:
            _write_project_audio_to_zip(zf, proj)
            for fname in proj.materials:
                fpath = os.path.join(mats_dir, fname)
                if os.path.isfile(fpath):
                    # Place under materials/<pid>/<basename>
                    zf.write(fpath, arcname=f"materials/{proj.id}/{os.path.basename(fname)}")
    buf.seek(0)
    # Friendly filename using the project display name
    try:
        import datetime as _dt
        stem = _safe_file_stem(getattr(proj, 'name', '') or proj.id)
        fname = f"{stem}_{_format_ymdhms(_dt.datetime.utcnow())}.zip"
    except Exception:
        fname = f"project_{proj.id}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


# --- Export (long-running, remote vzdump) ---
import datetime as datetime_module

def _parse_host_from_url(url: str) -> str:
    try:
        u = urlsplit(url)
        return u.hostname or ""
    except Exception:
        return ""


def _ssh_connect(host: str, port: int, user: str, password: str):
    try:
        import paramiko  # type: ignore
    except Exception as e:
        raise RuntimeError(f"ssh unavailable (paramiko not installed): {e}")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=password, look_for_keys=False, allow_agent=False)
    return c


def _ssh_run(c, cmd: str):
    stdin, stdout, stderr = c.exec_command(cmd)
    return stdout, stderr

def _ssh_run_cmd(c, cmd: str, *, sudo: bool = False, sudo_password: str = ""):
    """Run a remote command, optionally via sudo using non-interactive password feed.
    Returns (stdout, stderr) file-like objects.
    """
    if not sudo:
        return _ssh_run(c, cmd)
    # Use sudo -S to read password from stdin; -p '' suppresses prompt text.
    stdin, stdout, stderr = c.exec_command(f"sudo -S -p '' {cmd}")
    try:
        if sudo_password:
            stdin.write(sudo_password + "\n")
            stdin.flush()
    except Exception:
        pass
    return stdout, stderr


def _ssh_run_stream(
    c,
    cmd: str,
    *,
    sudo: bool = False,
    sudo_password: str = "",
    emit=None,
    cmd_prefix: str = "[SSH][CMD]",
    out_prefix: str = "[SSH][OUT]",
    err_prefix: str = "[SSH][ERR]",
    on_stdout_line=None,
):
    """Run a remote command and stream output lines to an emitter.

    - emit: callable(str) to log lines.
    - on_stdout_line: optional callback(str) invoked for each decoded stdout line (before emitting).
    - Prefixes customize log labeling. Set to "" to omit.
    Returns a tuple of aggregated (stdout_text, stderr_text) best-effort.
    """
    try:
        if emit and cmd_prefix:
            emit(f"{cmd_prefix} {cmd}")
    except Exception:
        pass
    out, err = _ssh_run_cmd(c, cmd, sudo=sudo, sudo_password=sudo_password)

    def _decode(b):
        try:
            if isinstance(b, (bytes, bytearray)):
                return b.decode('utf-8', errors='ignore')
            return str(b)
        except Exception:
            try:
                return str(b)
            except Exception:
                return ""

    so_acc = []
    se_acc = []
    # Stream stdout
    try:
        while True:
            line = out.readline()
            if not line:
                break
            txt = _decode(line).rstrip()
            try:
                if on_stdout_line and txt:
                    on_stdout_line(txt)
            except Exception:
                pass
            try:
                if emit and txt:
                    emit(f"{out_prefix} {txt}" if out_prefix else txt)
            except Exception:
                pass
            if txt:
                so_acc.append(txt)
    except Exception:
        pass
    # Drain stderr
    try:
        err_txt = _decode(err.read())
        if isinstance(err_txt, str) and err_txt.strip():
            for ln in err_txt.splitlines():
                ln = ln.rstrip()
                if not ln:
                    continue
                try:
                    if emit:
                        emit(f"{err_prefix} {ln}" if err_prefix else ln)
                except Exception:
                    pass
                se_acc.append(ln)
    except Exception:
        pass
    return ("\n".join(so_acc), "\n".join(se_acc))


def _job_record(pid: str, job_id: str):
    key = _job_key(pid)
    rec = _ACTIVE_JOBS.get(key) or {}
    rec.update({
        'id': job_id,
        'action': 'export',
        'status': 'starting',
        'progress': 0,
        'total': 100,
        'per_vm': [],
        'log': [],
        'download_path': '',
    # cleanup bookkeeping
    'remote_base': '',
    'local_base': '',
    'ssh_host': '',
    'ssh_port': 22,
    'ssh_user': '',
    'ssh_pass': '',
    })
    _ACTIVE_JOBS[key] = rec
    return rec


@api_bp.route("/projects/<pid>/export/start", methods=["POST"])
@_secure_route()
def export_project_start(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(force=True) or {}
    include_creds = bool(data.get("includeCreds", True))
    include_vms = bool(data.get("includeVms", True))
    if not include_vms:
        return jsonify({"error": "VM export not requested"}), 400
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not username or not password:
        return jsonify({"error": "Missing Proxmox credentials"}), 400

    base_url = getattr(proj, 'proxmox_url', '') or ''
    prox_host = _parse_host_from_url(base_url) or ''
    verify_ssl = getattr(proj, 'proxmox_verify_ssl', True)

    if include_vms and base_url:
        client = None
        try:
            client = ProxmoxClient(base_url=base_url, username=username, password=password, verify=verify_ssl is not False)
            node_by_id = {}
            node_by_name = {}
            nodes = client.list_nodes()
            for node_entry in nodes or []:
                node_name = str(node_entry.get('node') or '').strip()
                if not node_name:
                    continue
                try:
                    vms = client.list_qemu_vms(node_name)
                except Exception:
                    continue
                for vm in vms or []:
                    info = {
                        'node': node_name,
                        'vmid': vm.get('vmid'),
                        'name': vm.get('name'),
                    }
                    vmid = vm.get('vmid')
                    if vmid is not None:
                        try:
                            node_by_id[int(vmid)] = info
                        except Exception:
                            pass
                    vm_name = str(vm.get('name') or '').strip().lower()
                    if vm_name:
                        node_by_name[vm_name] = info
        except Exception as e:
            return jsonify({"error": f"Proxmox validation failed: {e}"}), 502
        finally:
            try:
                if client and getattr(client, '_session', None):
                    client._session.close()
            except Exception:
                pass

        prox_host_lc = prox_host.strip().lower()
        host_candidates = set()
        if prox_host_lc:
            host_candidates.add(prox_host_lc)
            if '.' in prox_host_lc:
                host_candidates.add(prox_host_lc.split('.', 1)[0])

        mapping_raw = {}
        try:
            mapping_raw = dict(getattr(proj, 'proxmox_node_host_map', {}) or {})
        except Exception:
            mapping_raw = {}
        map_by_node = {}
        for nk, hv in mapping_raw.items():
            node_key = str(nk or '').strip().lower()
            if not node_key:
                continue
            host_val = str(hv or '').strip().lower()
            if host_val:
                map_by_node[node_key] = host_val

        def _node_matches_host(node_name: str) -> bool:
            if not host_candidates:
                return True
            n = str(node_name or '').strip().lower()
            if not n:
                return False
            if n in host_candidates:
                return True
            mapped = map_by_node.get(n)
            if mapped:
                mapped_candidates = {mapped}
                if '.' in mapped:
                    mapped_candidates.add(mapped.split('.', 1)[0])
                if mapped_candidates & host_candidates:
                    return True
            return False

        mismatched = []
        node_assignments = []
        seen_keys = set()
        for vm_cfg in getattr(proj, 'vms', []) or []:
            vm_name = getattr(vm_cfg, 'name', '') or ''
            vmid = getattr(vm_cfg, 'vmid', None)
            info = None
            if vmid is not None:
                try:
                    vmid_int = int(vmid)
                except Exception:
                    vmid_int = None
                if vmid_int is not None and vmid_int in node_by_id:
                    info = node_by_id[vmid_int]
            if info is None and vm_name and vm_name.strip().lower() in node_by_name:
                info = node_by_name[vm_name.strip().lower()]
            if not info:
                continue
            node_name = info.get('node') or ''
            node_assignments.append({'name': vm_name, 'node': node_name, 'vmid': info.get('vmid')})
            if node_name and not _node_matches_host(node_name):
                key = f"{vm_name}@@{node_name}"
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                mismatched.append({
                    'name': vm_name,
                    'node': node_name,
                    'vmid': info.get('vmid'),
                })

        unique_nodes = {str(entry.get('node') or '').strip().lower() for entry in node_assignments if entry.get('node')}
        if mismatched and len(unique_nodes) == 1 and not host_candidates:
            mismatched = []

        if mismatched:
            display_host = prox_host or 'the configured node'
            def _fmt(vm):
                n = str(vm.get('name') or '')
                node_label = str(vm.get('node') or '')
                return f"{n} (node {node_label})" if node_label else n
            problem = ', '.join(sorted({_fmt(m) for m in mismatched if (m.get('name') or m.get('node'))}))
            return jsonify({
                "error": f"Cannot export VMs because some templates are on a different node than {display_host}.",
                "details": mismatched,
                "message": f"Move these VM(s) to {display_host} or update the Proxmox URL: {problem}"
            }), 400

    job_id = uuid.uuid4().hex
    rec = _job_record(pid, job_id)
    rec['status'] = 'queued'

    app_obj = current_app._get_current_object()

    def worker():
        key = _job_key(pid)
        # Ensure we have an application context in this thread
        with app_obj.app_context():
            # helper to record job log and emit DEBUG logs
            def _emit(msg: str):
                try:
                    _ACTIVE_JOBS[key]['log'].append(msg)
                except Exception:
                    pass
                try:
                    app_obj.logger.debug(f"export[{pid}:{job_id}] {msg}")
                except Exception:
                    pass
            # Coerce bytes/str to text safely
            def _to_text(data) -> str:
                try:
                    if isinstance(data, (bytes, bytearray)):
                        return data.decode('utf-8', errors='ignore')
                    return str(data) if data is not None else ''
                except Exception:
                    return ''

            def _maybe_clear_readonly_volume(message: str) -> bool:
                try:
                    msg_lc = (message or '').lower()
                except Exception:
                    msg_lc = ''
                keywords = ('not a writable', 'not writable', 'read-only')
                if not any(k in msg_lc for k in keywords):
                    return False
                match = re.search(r'(base-\d+-disk-\d+)', message or '')
                if not match:
                    return False
                volume = match.group(1)
                if not volume:
                    return False
                lv_path = f"/dev/pve/{volume}"
                try:
                    _emit(f"[CMD] lvs {lv_path}")
                    _ssh_run_cmd(c, f"lvs {lv_path}", sudo=use_sudo, sudo_password=password)
                except Exception as lvs_err:
                    _emit(f"[WARN] lvs check failed for {lv_path}: {lvs_err}")
                try:
                    _emit(f"[CMD] lvchange -prw {lv_path}")
                    _ssh_run_cmd(c, f"lvchange -prw {lv_path}", sudo=use_sudo, sudo_password=password)
                except Exception as lvchange_err:
                    _emit(f"[WARN] Failed to clear read-only state on {lv_path}: {lvchange_err}")
                    return False
                try:
                    _emit(f"[CMD] lvs {lv_path}")
                    _ssh_run_cmd(c, f"lvs {lv_path}", sudo=use_sudo, sudo_password=password)
                except Exception:
                    pass
                _emit(f"[{volume}] Read-only protection cleared; will retry vzdump")
                return True
            try:
                _ACTIVE_JOBS[key]['status'] = 'connecting'
                host = _parse_host_from_url(getattr(proj, 'proxmox_url', '') or '')
                port = int(getattr(proj, 'proxmox_ssh_port', 22) or 22)
                ssh_user = username.split('@')[0] if '@' in username else username
                _emit(f"[CMD] ssh connect {host}:{port} user={ssh_user}")
                c = _ssh_connect(host, port, ssh_user, password)
                _emit("[OK] ssh connected")
                _ACTIVE_JOBS[key]['status'] = 'preparing'
                # Use a timestamped remote temp directory to isolate runs and aid debugging
                epoch = int(time.time())
                base_remote = f"/tmp/an3s_export_{pid}_{epoch}"
                _emit(f"[CMD] mkdir -p {base_remote}")
                use_sudo = (str(ssh_user).strip().lower() != 'root')
                _ssh_run_cmd(c, f"mkdir -p {base_remote}", sudo=use_sudo, sudo_password=password)
                # Track for cleanup
                try:
                    _ACTIVE_JOBS[key]['remote_base'] = base_remote
                    _ACTIVE_JOBS[key]['ssh_host'] = host
                    _ACTIVE_JOBS[key]['ssh_port'] = int(port)
                    _ACTIVE_JOBS[key]['ssh_user'] = ssh_user
                    _ACTIVE_JOBS[key]['ssh_pass'] = password
                except Exception:
                    pass

                # Map VM names -> VMIDs if missing using `qm list`
                vmlist = getattr(proj, 'vms', []) or []
                # Build name->vmid map from qm list
                name_to_id = {}
                try:
                    _emit("[CMD] qm list")
                    out, err = _ssh_run_cmd(c, "qm list", sudo=use_sudo, sudo_password=password)
                    lines = _to_text(out.read()).splitlines()
                    for ln in lines[1:]:
                        parts = [p for p in ln.split() if p]
                        if len(parts) >= 2:
                            try:
                                vmid = int(parts[0])
                                name = parts[1]
                                name_to_id[name] = vmid
                            except Exception:
                                pass
                    _emit(f"[OUT] qm list parsed {len(name_to_id)} entries")
                except Exception:
                    pass

                # Initialize per-vm records
                pvms = []
                for v in vmlist:
                    vm_name = getattr(v, 'name', '') or ''
                    vmid = getattr(v, 'vmid', None)
                    if vmid is None and vm_name in name_to_id:
                        vmid = name_to_id[vm_name]
                    pvms.append({'name': vm_name, 'vmid': vmid, 'progress': 0, 'status': 'pending'})
                _ACTIVE_JOBS[key]['per_vm'] = pvms
                _ACTIVE_JOBS[key]['status'] = 'running'
                total = len(pvms)

                # For each VM, create folder and run vzdump
                for idx, vmrec in enumerate(pvms):
                    if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                        _ACTIVE_JOBS[key]['status'] = 'cancelled'
                        return
                    vm_name = vmrec['name'] or f"vm_{idx}"
                    vmid = vmrec.get('vmid')
                    if not vmid:
                        vmrec['status'] = 'skipped'
                        _emit(f"Skipping {vm_name}: missing VMID")
                        # Update overall progress
                        _ACTIVE_JOBS[key]['progress'] = int(((idx + 1) / max(total, 1)) * 80)
                        continue
                    vmrec['status'] = 'dumping'
                    _emit(f"[CMD] mkdir -p {base_remote}/{vm_name}")
                    _ssh_run_cmd(c, f"mkdir -p {base_remote}/{vm_name}", sudo=use_sudo, sudo_password=password)
                    # Run vzdump with streaming; dumpdir is absolute
                    cmd = f"vzdump {int(vmid)} --compress zstd --mode snapshot --remove 0 --zstd 0 --tmpdir /root/ --dumpdir {base_remote}/{vm_name}"
                    def _run_vzdump_operation():
                        def on_line(_txt):
                            try:
                                vmrec['progress'] = min(95, vmrec.get('progress', 0) + 1)
                                _ACTIVE_JOBS[key]['per_vm'][idx] = vmrec
                                _ACTIVE_JOBS[key]['progress'] = int(((idx + vmrec['progress']/100.0) / max(total, 1)) * 80)
                            except Exception:
                                pass
                        _ssh_run_stream(
                            c,
                            cmd,
                            sudo=use_sudo,
                            sudo_password=password,
                            emit=lambda m: _emit(f"[{vm_name}] {m}"),
                            on_stdout_line=on_line,
                            cmd_prefix="[CMD]",
                        )

                    success = False
                    last_error = None
                    try:
                        _run_vzdump_operation()
                        success = True
                    except Exception as e:
                        last_error = str(e)
                        _emit(f"[{vm_name}] vzdump failed: {e}")
                        cleared = _maybe_clear_readonly_volume(last_error)
                        if cleared:
                            try:
                                _run_vzdump_operation()
                                success = True
                                last_error = None
                            except Exception as retry_err:
                                last_error = f"{last_error}; retry failed: {retry_err}"
                                _emit(f"[{vm_name}] Retry after clearing read-only failed: {retry_err}")
                    if success:
                        vmrec['progress'] = 100
                        vmrec['status'] = 'done'
                    else:
                        vmrec['status'] = 'error'
                        if last_error:
                            vmrec['error'] = last_error
                    _ACTIVE_JOBS[key]['per_vm'][idx] = vmrec
                    _ACTIVE_JOBS[key]['progress'] = int(((idx + 1) / max(total, 1)) * 80)

                # Download results via SFTP
                # Ensure exported files are readable by SSH user for SFTP download
                try:
                    _emit(f"[CMD] chown -R {ssh_user} {base_remote}")
                    _ssh_run_cmd(c, f"chown -R {ssh_user} {base_remote}", sudo=use_sudo, sudo_password=password)
                except Exception as e:
                    _emit(f"Chown failed (will attempt download anyway): {e}")

                _ACTIVE_JOBS[key]['status'] = 'downloading'
                local_base = os.path.join(app_obj.config['DATA_DIR'], 'exports', f"{pid}_{job_id}")
                os.makedirs(local_base, exist_ok=True)
                try:
                    _ACTIVE_JOBS[key]['local_base'] = local_base
                except Exception:
                    pass
                try:
                    sftp = c.open_sftp()
                    # First, discover files and sizes to compute total bytes for progress
                    to_download = []  # list of (vm_name, filename, remote_path, local_dir, size)
                    total_bytes = 0
                    for vmrec in _ACTIVE_JOBS[key]['per_vm']:
                        vm_name = vmrec['name'] or 'vm'
                        remote_dir = f"{base_remote}/{vm_name}"
                        local_dir = os.path.join(local_base, 'backups', vm_name)
                        os.makedirs(local_dir, exist_ok=True)
                        try:
                            _emit(f"[SFTP] list {remote_dir}")
                            names = sftp.listdir(remote_dir)
                        except IOError:
                            _emit(f"No files for {vm_name}")
                            names = []
                        for f in names:
                            rpath = f"{remote_dir}/{f}"
                            fsize = 0
                            try:
                                st = sftp.stat(rpath)
                                fsize = int(getattr(st, 'st_size', 0) or 0)
                            except Exception:
                                fsize = 0
                            to_download.append((vm_name, f, rpath, local_dir, fsize))
                            try:
                                total_bytes += max(0, int(fsize))
                            except Exception:
                                pass

                    _ACTIVE_JOBS[key]['download_total'] = int(total_bytes)
                    _ACTIVE_JOBS[key]['download_bytes'] = 0

                    # Download with callback progress, mapping overall to 80..90%
                    downloaded_so_far = 0
                    last_emit_pct = -1
                    last_emit_t = time.time()
                    for vm_name, fname, rpath, local_dir, fsize in to_download:
                        lpath = os.path.join(local_dir, fname)
                        file_prev = 0

                        def _cb(bytes_so_far, _size=fsize):
                            nonlocal file_prev, downloaded_so_far, last_emit_pct, last_emit_t
                            try:
                                delta = max(0, int(bytes_so_far) - int(file_prev))
                            except Exception:
                                delta = 0
                            file_prev = int(bytes_so_far)
                            downloaded_so_far += delta
                            _ACTIVE_JOBS[key]['download_bytes'] = int(downloaded_so_far)
                            # Update coarse-grained overall progress within 80..89 to leave room for packaging 90+
                            try:
                                if total_bytes > 0:
                                    pct = 80 + int((downloaded_so_far * 10) / total_bytes)
                                    pct = max(80, min(89, pct))
                                    if pct > int(_ACTIVE_JOBS[key].get('progress', 80)):
                                        _ACTIVE_JOBS[key]['progress'] = pct
                            except Exception:
                                pass
                            # Throttle log emissions
                            now = time.time()
                            if (now - last_emit_t) >= 0.5 or int(_ACTIVE_JOBS[key].get('progress', 80)) != last_emit_pct:
                                last_emit_t = now
                                last_emit_pct = int(_ACTIVE_JOBS[key].get('progress', 80))
                                try:
                                    file_pct = (int((bytes_so_far * 100) / _size) if _size else 0)
                                except Exception:
                                    file_pct = 0
                                try:
                                    if total_bytes > 0:
                                        tot_pct = (downloaded_so_far * 100.0) / total_bytes
                                        _emit(f"[SFTP] {vm_name}/{fname}: {bytes_so_far}/{_size} ({file_pct}%) — total {tot_pct:.1f}%")
                                    else:
                                        _emit(f"[SFTP] {vm_name}/{fname}: {bytes_so_far}/{_size} ({file_pct}%)")
                                except Exception:
                                    pass

                        try:
                            sftp.get(rpath, lpath, callback=_cb)
                            _emit(f"Downloaded {vm_name}/{fname}")
                        except Exception as e:
                            _emit(f"Failed to download {vm_name}/{fname}: {e}")
                    try:
                        sftp.close()
                    except Exception:
                        pass
                    # Cleanup remote temporary export directory
                    try:
                        _ACTIVE_JOBS[key]['status'] = 'cleanup'
                        _emit(f"[CMD] rm -rf {base_remote}")
                        _ssh_run_cmd(c, f"rm -rf {base_remote}", sudo=use_sudo, sudo_password=password)
                        _emit('Remote temporary folders removed')
                    except Exception as e:
                        _emit(f"Remote cleanup failed: {e}")
                finally:
                    try:
                        c.close()
                    except Exception:
                        pass
                # If cancelled, best-effort remove remote base as well
                try:
                    if _ACTIVE_JOBS.get(key, {}).get('cancel') and base_remote:
                        _emit(f"[CMD] rm -rf {base_remote}")
                        _ssh_run_cmd(_ssh_connect(host, port, ssh_user, password), f"rm -rf {base_remote}", sudo=use_sudo, sudo_password=password)
                        _emit('Remote temporary folders removed (cancel)')
                except Exception:
                    pass

                _ACTIVE_JOBS[key]['progress'] = 90
                _ACTIVE_JOBS[key]['status'] = 'packaging'
                # Build final ZIP locally and expose for download
                local_zip = os.path.join(app_obj.config['DATA_DIR'], 'exports', f"export_{pid}_{job_id}.zip")
                os.makedirs(os.path.dirname(local_zip), exist_ok=True)
                _emit(f"[CMD] package -> {local_zip}")

                # Collect files to package and compute total size for progress
                backups_root = os.path.join(local_base, 'backups')
                files_to_add = []  # list of (abs_path, arcname, size)
                total_pack_bytes = 0
                total_pack_files = 0
                for root, _dirs, files in os.walk(backups_root):
                    for name in files:
                        fpath = os.path.join(root, name)
                        arc = os.path.relpath(fpath, start=local_base)
                        try:
                            fsize = int(os.path.getsize(fpath))
                        except Exception:
                            fsize = 0
                        files_to_add.append((fpath, arc, fsize))
                        total_pack_files += 1
                        try:
                            total_pack_bytes += max(0, fsize)
                        except Exception:
                            pass
                _ACTIVE_JOBS[key]['pack_total'] = int(total_pack_bytes)
                _ACTIVE_JOBS[key]['pack_bytes'] = 0
                _emit(f"[PKG] discovered {total_pack_files} file(s), {total_pack_bytes} bytes to add")

                with zipfile.ZipFile(local_zip, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                    # Write manifest first
                    manifest = {
                        "schemaVersion": 1,
                        "project": _project_to_json_filtered(proj, include_creds=include_creds, include_vms=True),
                    }
                    manifest_bytes = json.dumps(manifest, indent=2).encode('utf-8')
                    zf.writestr("project.json", manifest_bytes)
                    _emit(f"[PKG] wrote project.json ({len(manifest_bytes)} bytes)")
                    audio_written = _write_project_audio_to_zip(zf, proj)
                    if audio_written:
                        _emit(f"[PKG] added {audio_written} audio clip(s)")

                    # Add backup files with progress updates mapped to 90..99%
                    packed = 0
                    last_pct = -1
                    last_log_t = time.time()
                    for fpath, arc, fsize in files_to_add:
                        try:
                            _emit(f"[PKG] add {arc} ({fsize} bytes)")
                        except Exception:
                            pass
                        try:
                            zf.write(fpath, arcname=arc)
                        except Exception as e:
                            _emit(f"[PKG] failed to add {arc}: {e}")
                            continue
                        try:
                            packed += max(0, int(fsize))
                            _ACTIVE_JOBS[key]['pack_bytes'] = int(packed)
                            if total_pack_bytes > 0:
                                pct = 90 + int((packed * 9) / total_pack_bytes)  # up to 99%
                                pct = max(90, min(99, pct))
                                if pct != last_pct:
                                    _ACTIVE_JOBS[key]['progress'] = pct
                                    last_pct = pct
                            # Throttle aggregate progress logs
                            now = time.time()
                            if (now - last_log_t) >= 0.7 or pct == 99:
                                last_log_t = now
                                try:
                                    tot_pct = (packed * 100.0 / total_pack_bytes) if total_pack_bytes else 0
                                    _emit(f"[PKG] progress: {packed}/{total_pack_bytes} bytes ({tot_pct:.1f}%)")
                                except Exception:
                                    pass
                        except Exception:
                            pass
                # Persist export record on project
                try:
                    s = _store()
                    proj2 = s.get(pid)
                    if proj2:
                        size = 0
                        try:
                            size = os.path.getsize(local_zip)
                        except Exception:
                            size = 0
                        rec = {
                            'id': job_id,
                            'timestamp': datetime_module.datetime.utcnow().isoformat() + 'Z',
                            'include_creds': bool(include_creds),
                            'include_vms': True,
                            'local_path': local_zip,
                            'filename': os.path.basename(local_zip),
                            'size': size,
                        }
                        exports = list(getattr(proj2, 'exports', []) or [])
                        exports.insert(0, rec)
                        proj2.exports = exports
                        s.upsert(proj2)
                except Exception as e:
                    _emit(f"Failed to persist export record: {e}")
                _ACTIVE_JOBS[key]['download_path'] = local_zip
                _ACTIVE_JOBS[key]['progress'] = 100
                _ACTIVE_JOBS[key]['status'] = 'completed'
            except Exception as e:
                _ACTIVE_JOBS[key]['status'] = 'error'
                _ACTIVE_JOBS[key]['log'] = _ACTIVE_JOBS.get(key, {}).get('log', []) + [f"Error: {e}"]
                try:
                    app_obj.logger.debug(f"export[{pid}:{job_id}] Error: {e}")
                except Exception:
                    pass

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return jsonify({"job": job_id})


@api_bp.route("/projects/<pid>/export/status", methods=["GET"])
def export_project_status(pid: str):
    rec = _ACTIVE_JOBS.get(_job_key(pid))
    if not rec or rec.get('action') != 'export':
        return jsonify({"error": "No active job"}), 404
    # redact nothing; contains only progress/log info
    return jsonify({
        'id': rec.get('id'),
        'status': rec.get('status'),
        'progress': rec.get('progress', 0),
        'phase': rec.get('phase'),
        'step': rec.get('step'),
        'total_steps': rec.get('total_steps'),
        'current': rec.get('current'),
        'message': rec.get('message'),
        'eta': rec.get('eta'),
        'per_vm': rec.get('per_vm', []),
        'log': rec.get('log', []),
        'downloadReady': bool(rec.get('download_path')),
        'downloadPath': rec.get('download_path', ''),
    })


@api_bp.route("/projects/<pid>/export/cancel", methods=["POST"])
@_secure_route()
def export_project_cancel(pid: str):
    rec = _ACTIVE_JOBS.get(_job_key(pid))
    if not rec or rec.get('action') != 'export':
        return jsonify({"error": "No active export"}), 404
    try:
        rec['cancel'] = True
        _ACTIVE_JOBS[_job_key(pid)] = rec
    except Exception:
        pass
    # Attempt best-effort cleanup of any tracked temp paths immediately
    try:
        base_remote = rec.get('remote_base')
        if base_remote:
            h = rec.get('ssh_host') or ''
            prt = int(rec.get('ssh_port') or 22)
            usr = rec.get('ssh_user') or ''
            pwd = rec.get('ssh_pass') or ''
            if h and usr:
                c = _ssh_connect(h, prt, usr, pwd)
                try:
                    use_sudo = (str(usr).strip().lower() != 'root')
                    _ssh_run_cmd(c, f"rm -rf {base_remote}", sudo=use_sudo, sudo_password=pwd)
                finally:
                    try: c.close()
                    except Exception: pass
    except Exception:
        pass
    try:
        local_base = rec.get('local_base')
        if local_base and os.path.isdir(local_base):
            import shutil
            shutil.rmtree(local_base, ignore_errors=True)
    except Exception:
        pass
    return ('', 204)


@api_bp.route("/projects/<pid>/export/download", methods=["GET"])
def export_project_download(pid: str):
    rec = _ACTIVE_JOBS.get(_job_key(pid))
    if not rec or rec.get('action') != 'export' or rec.get('status') != 'completed':
        return jsonify({"error": "Export not ready"}), 400
    zip_path = rec.get('download_path')
    if not zip_path or not os.path.isfile(zip_path):
        return jsonify({"error": "File missing"}), 404
    # Friendly filename based on project name and current time
    s = _store()
    proj = s.get(pid)
    proj_name = getattr(proj, 'name', '') if proj else ''
    stem = _safe_file_stem(proj_name or pid)
    import datetime as _dt
    fname = f"{stem}_{_format_ymdhms(_dt.datetime.utcnow())}.zip"
    return send_file(zip_path, mimetype="application/zip", as_attachment=True, download_name=fname)


@api_bp.route("/projects/<pid>", methods=["DELETE"])
@_secure_route()
def delete_project(pid: str):
    ok = _store().delete(pid)
    return ("", 204) if ok else (jsonify({"error": "Not found"}), 404)


# VM management
@api_bp.route("/projects/<pid>/vms", methods=["POST"])
@_secure_route()
def add_vm(pid: str):
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Missing VM name"}), 400
    if not _is_valid_vm_name(name):
        return jsonify({"error": "Invalid VM name. Use letters, numbers, and internal dashes only; no leading or trailing dashes."}), 400
    try:
        proj = _store().add_vm(pid, name)
        d = _project_to_json(proj)
        return jsonify(d)
    except KeyError:
        return jsonify({"error": "Project not found"}), 404


@api_bp.route("/projects/<pid>/vms/<name>", methods=["DELETE"])
@_secure_route()
def remove_vm(pid: str, name: str):
    try:
        proj = _store().remove_vm(pid, name)
        d = _project_to_json(proj)
        return jsonify(d)
    except KeyError:
        return jsonify({"error": "Project not found"}), 404


@api_bp.route("/projects/<pid>/vms/<name>", methods=["PATCH"])
@_secure_route()
def update_vm(pid: str, name: str):
    data = request.get_json(force=True) or {}
    # basic type normalization
    for k in ["start_commands", "stored_commands", "internal_network_adaptors"]:
        if k in data and isinstance(data[k], str):
            data[k] = [s.strip() for s in data[k].splitlines() if s.strip()]
    # Validate internal_network_adaptors when provided: letters only, max 8 chars
    if "internal_network_adaptors" in data:
        adaptors = data.get("internal_network_adaptors")
        if adaptors is not None:
            if not isinstance(adaptors, list):
                return jsonify({"error": "internal_network_adaptors must be a list of names"}), 400
            bad = [a for a in adaptors if not _is_valid_adaptor_name(a)]
            if bad:
                return jsonify({
                    "error": "Invalid adaptor names: letters only, max 8 characters",
                    "invalid": bad,
                }), 400
    try:
        # Only update fields explicitly provided in the payload to avoid accidental clearing
        fields = {}
        if "vmid" in data:
            fields["vmid"] = data.get("vmid")
        if "viewable_to_user" in data:
            fields["viewable_to_user"] = bool(data.get("viewable_to_user"))
        if "start_commands" in data:
            fields["start_commands"] = data.get("start_commands")
        if "stored_commands" in data:
            fields["stored_commands"] = data.get("stored_commands")
        if "internal_network_adaptors" in data:
            fields["internal_network_adaptors"] = data.get("internal_network_adaptors")

        proj = _store().update_vm(
            pid,
            name,
            **fields,
        )
        d = _project_to_json(proj)
        return jsonify(d)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404


@api_bp.route("/projects/<pid>/vms/<name>/rename", methods=["POST"])
@_secure_route()
def rename_vm(pid: str, name: str):
    data = request.get_json(force=True) or {}
    new_name = (data.get("new_name") or "").strip()
    if not new_name:
        return jsonify({"error": "new_name is required"}), 400
    if not _is_valid_vm_name(new_name):
        return jsonify({"error": "Invalid VM name. Use letters, numbers, and internal dashes only; no leading or trailing dashes."}), 400
    try:
        proj = _store().rename_vm(pid, name, new_name)
        d = _project_to_json(proj)
        return jsonify(d)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except KeyError as e:
        return jsonify({"error": str(e)}), 404

# Materials: upload, list, download, delete
@api_bp.route("/projects/<pid>/materials", methods=["GET"])
def list_materials(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    return jsonify({"materials": proj.materials})


@api_bp.route("/projects/<pid>/materials", methods=["POST"])
@_secure_route()
def upload_material(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "Empty filename"}), 400
    # Save under DATA_DIR/materials/<pid>_UUID_<filename>
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")
    os.makedirs(mats_dir, exist_ok=True)
    original = secure_filename(file.filename)
    safe_name = f"{pid}_{uuid.uuid4().hex}_{original}"
    path = os.path.join(mats_dir, safe_name)
    file.save(path)
    s.add_material(pid, safe_name)
    return jsonify({"filename": safe_name}), 201


@api_bp.route("/projects/<pid>/materials/<fname>", methods=["GET"])
def download_material(pid: str, fname: str):
    s = _store()
    proj = s.get(pid)
    if not proj or fname not in (proj.materials if proj else []):
        return jsonify({"error": "Not found"}), 404
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")
    return send_from_directory(mats_dir, fname, as_attachment=True)


@api_bp.route("/projects/<pid>/materials/<fname>", methods=["DELETE"])
@_secure_route()
def delete_material(pid: str, fname: str):
    s = _store()
    proj = s.get(pid)
    if not proj or fname not in (proj.materials if proj else []):
        return jsonify({"error": "Not found"}), 404
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")
    try:
        os.remove(os.path.join(mats_dir, fname))
    except FileNotFoundError:
        pass
    s.remove_material(pid, fname)
    return ("", 204)


# Exports: list and delete
@api_bp.route("/projects/<pid>/exports", methods=["GET"])
def list_exports(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    # Enrich with exists/size for local files
    out = []
    for e in list(getattr(proj, 'exports', []) or []):
        rec = dict(e)
        lp = rec.get('local_path') or ''
        try:
            rec['exists'] = bool(lp and os.path.isfile(lp))
            if rec['exists']:
                rec['size'] = os.path.getsize(lp)
        except Exception:
            rec['exists'] = False
        out.append(rec)
    return jsonify({"exports": out})


@api_bp.route("/projects/<pid>/exports/<export_id>", methods=["DELETE"])
@_secure_route()
def delete_export(pid: str, export_id: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    # Find record
    exports = list(getattr(proj, 'exports', []) or [])
    rec = next((e for e in exports if str(e.get('id')) == str(export_id)), None)
    if not rec:
        return jsonify({"error": "Export not found"}), 404
    # Remove local file if present
    try:
        lp = rec.get('local_path') or ''
        if lp and os.path.isfile(lp):
            os.remove(lp)
    except Exception:
        pass
    # Best-effort: also allow removing prior remote file records if provided
    try:
        host = rec.get('host') or _parse_host_from_url(getattr(proj, 'proxmox_url', '') or '')
        port = int(getattr(proj, 'proxmox_ssh_port', 22) or 22)
        body = request.get_json(silent=True) or {}
        username = (body.get('username') or '').strip()
        password = (body.get('password') or '').strip()
        if username and password and rec.get('remote_path'):
            ssh_user = username.split('@')[0] if '@' in username else username
            c = _ssh_connect(host, port, ssh_user, password)
            try:
                use_sudo = (str(ssh_user).strip().lower() != 'root')
                _ssh_run_cmd(c, f"rm -f {rec.get('remote_path')}", sudo=use_sudo, sudo_password=password)
            finally:
                try: c.close()
                except Exception: pass
    except Exception:
        pass
    # Remove record locally regardless
    proj.exports = [e for e in exports if str(e.get('id')) != str(export_id)]
    s.upsert(proj)
    return ("", 204)


@api_bp.route("/projects/<pid>/exports/<export_id>/download", methods=["GET"])
def download_export_by_id(pid: str, export_id: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    rec = next((e for e in (getattr(proj, 'exports', []) or []) if str(e.get('id')) == str(export_id)), None)
    if not rec:
        return jsonify({"error": "Export not found"}), 404
    lp = rec.get('local_path') or ''
    if not lp or not os.path.isfile(lp):
        return jsonify({"error": "File missing"}), 404
    # Friendly filename: <projectName>_YYYYMMDD_HHMMSS.zip based on stored timestamp
    proj_name = getattr(proj, 'name', '') or pid
    stem = _safe_file_stem(proj_name)
    ts = rec.get('timestamp') or ''
    dt = _parse_iso_datetime(ts)
    if dt is None:
        import datetime as _dt
        dt = _dt.datetime.utcnow()
    fname = f"{stem}_{_format_ymdhms(dt)}.zip"
    return send_file(lp, mimetype="application/zip", as_attachment=True, download_name=fname)


@api_bp.route("/projects/<pid>/exports/<export_id>/reveal", methods=["POST"])
@_secure_route()
def reveal_export_in_finder(pid: str, export_id: str):
    """Best-effort: on macOS, ask the OS to reveal the file in Finder. Returns ok even if unsupported."""
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    rec = next((e for e in (getattr(proj, 'exports', []) or []) if str(e.get('id')) == str(export_id)), None)
    if not rec:
        return jsonify({"error": "Export not found"}), 404
    lp = rec.get('local_path') or ''
    if not lp or not os.path.exists(lp):
        return jsonify({"error": "File missing"}), 404
    try:
        import subprocess, platform
        if platform.system() == 'Darwin':
            subprocess.Popen(['open', '-R', lp])
            return jsonify({"ok": True})
        # On other OSes, just return the folder path so the UI can display it
        return jsonify({"ok": True, "folder": os.path.dirname(lp)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@api_bp.route("/proxmox/nodes", methods=["POST"])
@_secure_route()
def proxmox_nodes():
    data = request.get_json(force=True) or {}
    base_url = data.get("baseUrl")
    verify = bool(data.get("verifySSL", True))
    username = data.get("username")
    password = data.get("password")
    token = data.get("token")
    if not base_url or (not token and not (username and password)):
        return jsonify({"error": "Missing baseUrl and credentials (username/password or token)"}), 400

    client = ProxmoxClient(base_url=base_url, token=token or None, username=username or None, password=password or None, verify=verify)
    try:
        nodes = client.list_nodes()
        return jsonify({"nodes": nodes})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@api_bp.route("/proxmox/templates", methods=["POST"])
@_secure_route()
def proxmox_templates():
    """List QEMU templates across all nodes.
    Body: { baseUrl, verifySSL, username, password, token }
    Returns: { templates: [ { node, vmid, name } ] }
    """
    data = request.get_json(force=True) or {}
    base_url = data.get("baseUrl")
    verify = bool(data.get("verifySSL", True))
    username = data.get("username")
    password = data.get("password")
    token = data.get("token")
    api_port = data.get("apiPort")
    if not base_url or (not token and not (username and password)):
        return jsonify({"error": "Missing baseUrl and credentials (username/password or token)"}), 400

    # Optionally apply apiPort override to base_url
    try:
        if api_port is not None:
            try:
                api_port = int(api_port)
            except Exception:
                api_port = None
        if api_port:
            u = urlparse(base_url)
            # Preserve username/password and hostname in netloc while replacing/adding port
            host = u.hostname or ''
            # Rebuild netloc with port and optional userinfo
            userinfo = ''
            if u.username:
                userinfo = u.username
                if u.password:
                    userinfo += f":{u.password}"
                userinfo += '@'
            netloc = f"{userinfo}{host}:{api_port}"
            base_url = urlunparse((u.scheme or 'https', netloc, u.path or '', u.params or '', u.query or '', u.fragment or ''))
    except Exception:
        pass

    client = ProxmoxClient(base_url=base_url, token=token or None, username=username or None, password=password or None, verify=verify)
    try:
        nodes = client.list_nodes() or []
        out = []
        # Helper to extract bridge names from a VM config
        def _extract_bridges(cfg: dict):
            bridges = []
            try:
                seen = set()
                for k, v in (cfg or {}).items():
                    ks = str(k)
                    if not ks.startswith('net'):
                        continue
                    if isinstance(v, str):
                        parts = [p.strip() for p in v.split(',') if p]
                        bridge = next((p.split('=', 1)[1] for p in parts if p.startswith('bridge=')), '')
                        if bridge and bridge not in seen:
                            seen.add(bridge)
                            bridges.append(bridge)
            except Exception:
                pass
            return bridges
        for n in nodes:
            try:
                node_name = n.get('node') or n.get('id') or n.get('name')
                if not node_name:
                    continue
                vms = client.list_qemu_vms(str(node_name)) or []
                for vm in vms:
                    try:
                        is_tmpl = vm.get('template') in (1, True, '1', 'true')
                        if not is_tmpl:
                            continue
                        vmid = vm.get('vmid')
                        name = vm.get('name') or vm.get('vmname') or ''
                        if vmid is None:
                            continue
                        try:
                            vmid = int(vmid)
                        except Exception:
                            continue
                        # Best-effort: fetch config to discover assigned bridges for this template
                        bridges = []
                        try:
                            cfg = client.get_qemu_config(str(node_name), int(vmid))
                            bridges = _extract_bridges(cfg)
                        except Exception:
                            bridges = []
                        out.append({ 'node': str(node_name), 'vmid': vmid, 'name': str(name), 'bridges': bridges })
                    except Exception:
                        continue
            except Exception:
                continue
        # Optional: sort by name then vmid
        try:
            out.sort(key=lambda x: (str(x.get('name') or ''), int(x.get('vmid') or 0)))
        except Exception:
            pass
        return jsonify({"templates": out})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@api_bp.route("/proxmox/nodes/<node>/network", methods=["POST"])
@_secure_route()
def proxmox_node_network(node: str):
    data = request.get_json(force=True) or {}
    base_url = data.get("baseUrl")
    verify = bool(data.get("verifySSL", True))
    username = data.get("username")
    password = data.get("password")
    token = data.get("token")
    if not base_url or (not token and not (username and password)):
        return jsonify({"error": "Missing baseUrl and credentials (username/password or token)"}), 400

    client = ProxmoxClient(base_url=base_url, token=token or None, username=username or None, password=password or None, verify=verify)
    try:
        nets = client.list_network(node)
        return jsonify({"network": nets})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@api_bp.route("/ctfd/challenges", methods=["POST"])
@_secure_route()
def ctfd_challenges():
    data = request.get_json(force=True) or {}
    base_url = data.get("baseUrl")
    token = data.get("token")
    if not base_url or not token:
        return jsonify({"error": "Missing baseUrl or token"}), 400

    client = CTFdClient(base_url=base_url, token=token)
    try:
        challenges = client.list_challenges()
        return jsonify({"challenges": challenges})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@api_bp.route('/projects/<pid>/ctfd/stats/challenges', methods=['POST'])
@_secure_route()
def ctfd_stats_challenges(pid: str):
    """Return challenge stats with teams and users who solved each challenge.
    Request JSON: { baseUrl, port?, token?, username?, password?, verifySSL?, detail?: bool }
    Response JSON: { items: [ { id, name, category, value(points), solves, visible, teams?, users?, teams_count?, users_count? } ], logs }
    Note: When detail is false, only counts are returned (teams_count/users_count) and teams/users arrays are omitted for speed.
    """
    s = _store(); proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    try:
        client = _ctfd_client_from_req(proj)
        # Require elevated role to read global solves; many CTFd deployments restrict this to admins/teachers
        try:
            role = client.get_role() if hasattr(client, 'get_role') else ''
        except Exception:
            role = ''
        if role not in ('admin', 'teacher'):
            return jsonify({
                'error': 'forbidden',
                'message': 'CTFd challenges stats requires an Admin or Teacher API token',
                'role': role or '',
                'using_token': bool(getattr(client, 'token', '')),
                'logs': getattr(client, 'logs', []),
            }), 403
        body = request.get_json(silent=True) or {}
        detail = bool(body.get('detail', True))
        items = []
        debug_logs = list(getattr(client, 'logs', []))
        # Detect user mode once (users vs teams) to interpret account_id when type is absent
        try:
            user_mode = str(client.get_config('user_mode') or '').strip().lower()
        except Exception:
            user_mode = ''
        # Use admin-capable listing to include hidden challenges
        ch_list = []
        try:
            ch_list = client.list_challenges_all() if hasattr(client, 'list_challenges_all') else client.list_challenges()
        except Exception:
            ch_list = client.list_challenges()
        for ch in ch_list or []:
            try:
                cid = int(ch.get('id'))
            except Exception:
                continue
            name = (ch.get('name') or '').strip()
            category = (ch.get('category') or '').strip()
            points = ch.get('value') or ch.get('points') or 0
            # Determine visibility from list item; if unknown, try fetching single challenge
            def _detect_visible(obj):
                try:
                    st = obj.get('state')
                    if isinstance(st, str) and st.strip():
                        return (st.strip().lower() == 'visible')
                except Exception:
                    pass
                try:
                    hid = obj.get('hidden')
                    if isinstance(hid, bool):
                        return (not hid)
                except Exception:
                    pass
                return None
            visible = _detect_visible(ch)
            if visible is None:
                try:
                    ch_full = client.get_challenge(cid)
                    visible = _detect_visible(ch_full)
                except Exception:
                    visible = None
            solves = client.list_challenge_solves(cid) or []
            # Debug: collect shape info of solves
            try:
                sample_keys = []
                for rec in solves[:5]:
                    if isinstance(rec, dict):
                        sample_keys.append(sorted(list(rec.keys()))[:20])
                debug_logs.append(f"[ctfd_stats] challenge {cid} '{name}': solves={len(solves)} sample_keys={sample_keys}")
            except Exception:
                pass
            if not detail:
                # Fast path: compute unique team/user counts only; skip name resolution and fallbacks
                def _id(val):
                    try:
                        if isinstance(val, dict):
                            for k in ('id','user_id','team_id','account_id'):
                                if k in val and val.get(k) is not None:
                                    return int(val.get(k))
                            for k in ('user','team','account'):
                                v2 = val.get(k)
                                if isinstance(v2, dict):
                                    for kk in ('id','user_id','team_id','account_id'):
                                        if kk in v2 and v2.get(kk) is not None:
                                            return int(v2.get(kk))
                            return None
                        if isinstance(val, (int, str)) and str(val).strip() != '':
                            return int(val)
                    except Exception:
                        return None
                    return None
                teams_set = set(); users_set = set()
                for srec in solves:
                    try:
                        acct_type = (
                            srec.get('account_type')
                            or (srec.get('account') or {}).get('type')
                            or (srec.get('user') or {}).get('type')
                            or (srec.get('team') or {}).get('type')
                            or ''
                        )
                        acct_type = str(acct_type).strip().lower()
                        acct_id_val = srec.get('account_id') if srec.get('account_id') is not None else (srec.get('account') or {})
                        if acct_type in ('team','teams'):
                            tid = _id(acct_id_val)
                            if tid is not None: teams_set.add(int(tid))
                        elif acct_type in ('user','users'):
                            uid = _id(acct_id_val)
                            if uid is not None: users_set.add(int(uid))
                        # If type missing, infer by user_mode
                        if (acct_type == '') and (acct_id_val is not None):
                            aid = _id(acct_id_val)
                            if aid is not None:
                                if user_mode.startswith('team'): teams_set.add(int(aid))
                                else: users_set.add(int(aid))
                        # Fallback hints for older schemas
                        uid = _id(srec.get('user_id')) if isinstance(srec, dict) else None
                        if uid is None: uid = _id((srec or {}).get('user')) if isinstance(srec, dict) else None
                        tid = _id((srec or {}).get('team_id')) if isinstance(srec, dict) else None
                        if tid is None: tid = _id((srec or {}).get('team')) if isinstance(srec, dict) else None
                        if uid is not None: users_set.add(int(uid))
                        if tid is not None: teams_set.add(int(tid))
                    except Exception:
                        continue
                items.append({
                    'id': cid,
                    'name': name,
                    'category': category,
                    'points': points,
                    'solves': len(solves),
                    'teams_count': len(teams_set),
                    'users_count': len(users_set),
                    'visible': bool(visible) if (visible is not None) else None,
                })
                # Skip detailed processing for this challenge
                continue
            # Track earliest timestamp and first-seen index for both teams and users
            teams_info = {}  # id -> { first_idx, ts_epoch, ts }
            users_info = {}  # id -> { first_idx, ts_epoch, ts }
            def _parse_ts_epoch(val):
                import datetime
                try:
                    if val is None:
                        return None
                    # numeric epoch seconds
                    if isinstance(val, (int, float)):
                        return float(val)
                    s = str(val).strip()
                    if not s:
                        return None
                    # Try ISO8601
                    try:
                        dt = datetime_module.datetime.fromisoformat(s.replace('Z','+00:00'))
                        return dt.timestamp()
                    except Exception:
                        pass
                    # Try integer seconds in string
                    try:
                        return float(int(s))
                    except Exception:
                        pass
                except Exception:
                    return None
                return None
            def _extract_ts(rec):
                for key in ('date','created','created_at','solved_at','timestamp'):
                    if key in rec:
                        return rec.get(key)
                return None
            def _touch(mapinfo, _id, idx, rec):
                try:
                    if _id is None:
                        return
                    ent = mapinfo.get(_id)
                    if not ent:
                        ts_raw = _extract_ts(rec)
                        ent = { 'first_idx': int(idx), 'ts': ts_raw, 'ts_epoch': _parse_ts_epoch(ts_raw) }
                        mapinfo[_id] = ent
                    else:
                        # keep earliest timestamp if a smaller epoch is seen
                        ts_raw = _extract_ts(rec)
                        ts_ep = _parse_ts_epoch(ts_raw)
                        if ts_ep is not None:
                            if ent.get('ts_epoch') is None or float(ts_ep) < float(ent.get('ts_epoch')):
                                ent['ts_epoch'] = float(ts_ep)
                                ent['ts'] = ts_raw
                except Exception:
                    return
            for idx, srec in enumerate(solves):
                try:
                    # Helper to normalize id from plain value or embedded object
                    def _id(val):
                        try:
                            if isinstance(val, dict):
                                # Common id keys across variants
                                for k in ('id','user_id','team_id','account_id'):
                                    if k in val and val.get(k) is not None:
                                        return int(val.get(k))
                                # Sometimes nested user/team appears as {'user': {'id':..}}
                                for k in ('user','team','account'):
                                    v2 = val.get(k)
                                    if isinstance(v2, dict):
                                        for kk in ('id','user_id','team_id','account_id'):
                                            if kk in v2 and v2.get(kk) is not None:
                                                return int(v2.get(kk))
                                return None
                            if isinstance(val, (int, str)) and str(val).strip() != '':
                                return int(val)
                        except Exception:
                            return None
                        return None
                    # Prefer account_type/account_id when present (CTFd >= 3)
                    acct_type = (
                        srec.get('account_type')
                        or (srec.get('account') or {}).get('type')
                        or (srec.get('user') or {}).get('type')
                        or (srec.get('team') or {}).get('type')
                        or ''
                    )
                    acct_type = str(acct_type).strip().lower()
                    acct_id_val = srec.get('account_id') if srec.get('account_id') is not None else (srec.get('account') or {})
                    if acct_type in ('team', 'teams'):
                        tid = _id(acct_id_val)
                        if tid is not None:
                            _touch(teams_info, tid, idx, srec)
                    elif acct_type in ('user', 'users'):
                        uid = _id(acct_id_val)
                        if uid is not None:
                            _touch(users_info, uid, idx, srec)
                    # If account_id is present but type missing, infer from global user_mode
                    if (acct_type == '') and (acct_id_val is not None):
                        aid = _id(acct_id_val)
                        if aid is not None:
                            if user_mode.startswith('team'):
                                _touch(teams_info, aid, idx, srec)
                            else:
                                _touch(users_info, aid, idx, srec)
                    # Fallbacks for older schemas — also capture both when available
                    uid = _id(srec.get('user_id'))
                    if uid is None:
                        uid = _id(srec.get('user'))
                    tid = _id(srec.get('team_id'))
                    if tid is None:
                        tid = _id(srec.get('team'))
                    if uid is not None:
                        _touch(users_info, uid, idx, srec)
                    if tid is not None:
                        _touch(teams_info, tid, idx, srec)
                except Exception:
                    continue
            # If no users detected but teams exist (common in team mode), try fallbacks:
            # 1) For each team that solved this challenge, query team solves and see if any record
            #    contains a user reference for this challenge.
            # 2) If still unknown, enumerate team members and query their solves to find which user
            #    solved this challenge (earliest solve wins). Capped to avoid explosion.
            if (not users_info) and teams_info:
                try:
                    team_solves_cache = {}
                    team_members_cache = {}
                    user_solves_cache = {}
                    # Avoid excessive API calls on extremely popular challenges
                    max_teams_for_fallback = 50
                    if len(teams_info) > max_teams_for_fallback:
                        debug_logs.append(f"[ctfd_stats] challenge {cid} fallback skipped: {len(teams_info)} teams > {max_teams_for_fallback}")
                    else:
                        def _match_chal(rec):
                            try:
                                sid = rec.get('challenge_id') if isinstance(rec, dict) else None
                                if sid is None and isinstance(rec, dict):
                                    sid = rec.get('challenge')
                                return (sid is not None and int(sid) == cid)
                            except Exception:
                                return False
                        def _pick_earliest_ts(recs):
                            best = None
                            best_ep = None
                            for r in recs or []:
                                ep = _parse_ts_epoch(_extract_ts(r))
                                if ep is None:
                                    continue
                                if best_ep is None or ep < best_ep:
                                    best_ep = ep
                                    best = r
                            return best
                        # Reuse the local _id helper by defining a thin wrapper
                        def _uid_from_rec(rec):
                            try:
                                if not isinstance(rec, dict):
                                    return None
                                # direct or nested user keys
                                for k in ('user_id','user'):
                                    v = rec.get(k)
                                    if v is not None:
                                        # inline _id from above scope
                                        try:
                                            if isinstance(v, dict):
                                                for kk in ('id','user_id','account_id'):
                                                    if kk in v and v.get(kk) is not None:
                                                        return int(v.get(kk))
                                            return int(v)
                                        except Exception:
                                            pass
                                # sometimes account refers to user entity in team mode submissions
                                acc = rec.get('account')
                                if isinstance(acc, dict):
                                    t = str(acc.get('type') or '').strip().lower()
                                    if t in ('user','users'):
                                        for kk in ('id','user_id','account_id'):
                                            if kk in acc and acc.get(kk) is not None:
                                                try:
                                                    return int(acc.get(kk))
                                                except Exception:
                                                    break
                                return None
                            except Exception:
                                return None
                        # Iterate teams and attribute a user per team if possible
                        found_users = 0
                        for tid in list(teams_info.keys()):
                            try:
                                if tid in team_solves_cache:
                                    tsolves = team_solves_cache[tid]
                                else:
                                    tsolves = client.list_team_solves(tid)
                                    team_solves_cache[tid] = tsolves
                                # Filter this challenge and pick earliest
                                t_ch = [r for r in (tsolves or []) if _match_chal(r)]
                                chosen = _pick_earliest_ts(t_ch)
                                uid = _uid_from_rec(chosen) if chosen else None
                                if uid is not None:
                                    _touch(users_info, uid, 0, chosen or {})
                                    found_users += 1
                                    continue
                                # If team solves didn't expose user, try members -> user solves
                                if tid in team_members_cache:
                                    members = team_members_cache[tid]
                                else:
                                    members = client.list_team_members(tid)
                                    team_members_cache[tid] = members
                                best_user = None
                                best_ep = None
                                best_rec = None
                                for m in (members or []):
                                    try:
                                        mid = None
                                        for kk in ('id','user_id','account_id'):
                                            if kk in m and m.get(kk) is not None:
                                                mid = int(m.get(kk))
                                                break
                                        if mid is None:
                                            continue
                                        if mid in user_solves_cache:
                                            usolves = user_solves_cache[mid]
                                        else:
                                            usolves = client.list_user_solves(mid)
                                            user_solves_cache[mid] = usolves
                                        u_ch = [r for r in (usolves or []) if _match_chal(r)]
                                        u_pick = _pick_earliest_ts(u_ch)
                                        if u_pick is None:
                                            continue
                                        ep = _parse_ts_epoch(_extract_ts(u_pick))
                                        if ep is None:
                                            continue
                                        if best_ep is None or ep < best_ep:
                                            best_ep = ep
                                            best_user = mid
                                            best_rec = u_pick
                                    except Exception:
                                        continue
                                if best_user is not None:
                                    _touch(users_info, best_user, 0, best_rec or {})
                                    found_users += 1
                            except Exception:
                                continue
                        if found_users:
                            debug_logs.append(f"[ctfd_stats] challenge {cid} user fallback attributed {found_users} user(s) via team/member solves")
                except Exception:
                    # Non-fatal; keep users empty if fallback fails
                    pass
            # Build ordered lists with names and ordinals (prefer timestamp order, fallback to first_idx)
            def _sorted_entries(info_map):
                try:
                    items_loc = list(info_map.items())
                    # Sort by ts_epoch (None last), then first_idx
                    items_loc.sort(key=lambda kv: ((kv[1].get('ts_epoch') is None), kv[1].get('ts_epoch') or float('inf'), int(kv[1].get('first_idx') or 1e9)))
                    out = []
                    for i, (idv, meta) in enumerate(items_loc, start=1):
                        out.append((idv, i, meta))
                    return out
                except Exception:
                    # Fallback to insertion order
                    out = []
                    idx2 = 1
                    for idv, meta in info_map.items():
                        out.append((idv, idx2, meta))
                        idx2 += 1
                    return out
            teams = []
            for tid, ordn, meta in _sorted_entries(teams_info):
                nm = client.get_team_name(tid) or str(tid)
                teams.append({ 'id': tid, 'name': nm, 'ord': int(ordn), 'ts': meta.get('ts') })
            users = []
            for uid, ordn, meta in _sorted_entries(users_info):
                nm = client.get_user_name(uid) or str(uid)
                users.append({ 'id': uid, 'name': nm, 'ord': int(ordn), 'ts': meta.get('ts') })
            items.append({
                'id': cid,
                'name': name,
                'category': category,
                'points': points,
                'solves': len(solves),
                'teams': teams,
                'users': users,
                'visible': bool(visible) if (visible is not None) else None,
            })
            # Debug: if users empty but we see user-like fields, log it
            try:
                if not users and solves:
                    acct_types = {}
                    user_hits = team_hits = 0
                    for rec in solves:
                        if not isinstance(rec, dict):
                            continue
                        at = (rec.get('account_type') or (rec.get('account') or {}).get('type') or (rec.get('user') or {}).get('type') or (rec.get('team') or {}).get('type') or '')
                        at = str(at).strip().lower()
                        if at:
                            acct_types[at] = acct_types.get(at, 0) + 1
                        # heuristics for presence of user/team ids
                        for k in ('user_id','user'):
                            if k in rec and rec.get(k) is not None:
                                user_hits += 1
                                break
                        for k in ('team_id','team'):
                            if k in rec and rec.get(k) is not None:
                                team_hits += 1
                                break
                    debug_logs.append(f"[ctfd_stats] challenge {cid} users empty; acct_types={acct_types} user_hits={user_hits} team_hits={team_hits} user_mode='{user_mode}'")
            except Exception:
                pass
        # Optional: sort by category then name
        try:
            items.sort(key=lambda x: (str(x.get('category') or ''), str(x.get('name') or '')))
        except Exception:
            pass
        return jsonify({ 'items': items, 'using_token': bool(client.token), 'logs': debug_logs })
    except CTFdError as e:
        # Propagate auth/permission errors with appropriate status
        status = int(getattr(e, 'status_code', 400) or 400)
        msg = str(e)
        if status in (401, 403):
            return jsonify({ 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', []) }), status
        # Other upstream errors: treat as bad gateway
        return jsonify({ 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', []) }), 502
    except Exception as e:
        # Unknown local error
        return jsonify({ 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', []) }), 500

@api_bp.post('/projects/<pid>/ctfd/challenges/list')
@_secure_route()
def ctfd_challenges_list(pid: str):
    """Return all challenges including hidden for progress accounting.
    Body: { baseUrl, port?, token?, username?, password?, verifySSL? }
    Returns: { challenges: [ { id, name, category, value, state, hidden } ], using_token, logs }
    """
    s = _store(); proj = s.get(pid)
    if not proj:
        return jsonify({'error': 'Project not found'}), 404
    try:
        client = _ctfd_client_from_req(proj)
        # Role gate similar to stats endpoint
        try:
            role = client.get_role() if hasattr(client, 'get_role') else ''
        except Exception:
            role = ''
        if role not in ('admin', 'teacher'):
            return jsonify({
                'error': 'forbidden',
                'message': 'Admin/Teacher API token required to list all challenges',
                'role': role or '',
                'using_token': bool(getattr(client, 'token', '')),
                'logs': getattr(client, 'logs', []),
            }), 403
        try:
            arr = client.list_challenges_all() if hasattr(client, 'list_challenges_all') else client.list_challenges()
        except Exception:
            arr = client.list_challenges()
        # Normalize minimal fields
        out = []
        for ch in arr or []:
            try:
                out.append({
                    'id': int(ch.get('id')),
                    'name': (ch.get('name') or '').strip(),
                    'category': (ch.get('category') or '').strip(),
                    'value': ch.get('value') or ch.get('points') or 0,
                    'state': ch.get('state'),
                    'hidden': ch.get('hidden'),
                })
            except Exception:
                continue
        return jsonify({ 'challenges': out, 'using_token': bool(getattr(client, 'token', '')), 'logs': getattr(client, 'logs', []) })
    except CTFdError as e:
        status = int(getattr(e, 'status_code', 400) or 400)
        return jsonify({ 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', []) }), status if status in (401,403) else 502
    except Exception as e:
        return jsonify({ 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', []) }), 500

@api_bp.post('/projects/<pid>/ctfd/stats/challenges/<int:cid>')
@_secure_route()
def ctfd_stats_challenge_one(pid: str, cid: int):
    """Return stats for a single challenge id. Mirrors the per-item logic of the bulk endpoint.
    Body: { baseUrl, port?, token?, username?, password?, verifySSL? }
    Returns: { item: { ... }, using_token, logs }
    """
    s = _store(); proj = s.get(pid)
    if not proj:
        return jsonify({'error': 'Project not found'}), 404
    try:
        client = _ctfd_client_from_req(proj)
        try:
            role = client.get_role() if hasattr(client, 'get_role') else ''
        except Exception:
            role = ''
        if role not in ('admin', 'teacher'):
            return jsonify({
                'error': 'forbidden',
                'message': 'CTFd challenge stats requires an Admin or Teacher API token',
                'role': role or '',
                'using_token': bool(getattr(client, 'token', '')),
                'logs': getattr(client, 'logs', []),
            }), 403
        logs = list(getattr(client, 'logs', []))
        # Determine user_mode once
        try:
            user_mode = str(client.get_config('user_mode') or '').strip().lower()
        except Exception:
            user_mode = ''
        # Fetch the challenge data (for name/category/value/state)
        ch = client.get_challenge(int(cid)) or {}
        try:
            name = (ch.get('name') or '').strip()
            category = (ch.get('category') or '').strip()
            points = ch.get('value') or ch.get('points') or 0
        except Exception:
            name = ''; category = ''; points = 0
        # Determine visibility
        def _detect_visible(obj):
            try:
                st = obj.get('state')
                if isinstance(st, str) and st.strip():
                    return (st.strip().lower() == 'visible')
            except Exception:
                pass
            try:
                hid = obj.get('hidden')
                if isinstance(hid, bool):
                    return (not hid)
            except Exception:
                pass
            return None
        visible = _detect_visible(ch)
        # Solves and attribution logic (copied from bulk, condensed where safe)
        solves = client.list_challenge_solves(int(cid)) or []
        try:
            sample_keys = []
            for rec in solves[:5]:
                if isinstance(rec, dict): sample_keys.append(sorted(list(rec.keys()))[:20])
            logs.append(f"[ctfd_stats_one] challenge {cid} '{name}': solves={len(solves)} sample_keys={sample_keys}")
        except Exception:
            pass
        teams_info = {}
        users_info = {}
        def _parse_ts_epoch(val):
            import datetime
            try:
                if val is None: return None
                if isinstance(val, (int, float)): return float(val)
                s = str(val).strip();
                if not s: return None
                try:
                    dt = datetime_module.datetime.fromisoformat(s.replace('Z','+00:00'))
                    return dt.timestamp()
                except Exception: pass
                try: return float(int(s))
                except Exception: pass
            except Exception:
                return None
            return None
        def _extract_ts(rec):
            for key in ('date','created','created_at','solved_at','timestamp'):
                if key in rec: return rec.get(key)
            return None
        def _touch(mapinfo, _id, idx, rec):
            try:
                if _id is None: return
                ent = mapinfo.get(_id)
                if not ent:
                    ts_raw = _extract_ts(rec)
                    ent = { 'first_idx': int(idx), 'ts': ts_raw, 'ts_epoch': _parse_ts_epoch(ts_raw) }
                    mapinfo[_id] = ent
                else:
                    ts_raw = _extract_ts(rec)
                    ts_ep = _parse_ts_epoch(ts_raw)
                    if ts_ep is not None:
                        if ent.get('ts_epoch') is None or float(ts_ep) < float(ent.get('ts_epoch')):
                            ent['ts_epoch'] = float(ts_ep)
                            ent['ts'] = ts_raw
            except Exception:
                return
        for idx, srec in enumerate(solves):
            try:
                def _id(val):
                    try:
                        if isinstance(val, dict):
                            for k in ('id','user_id','team_id','account_id'):
                                if k in val and val.get(k) is not None:
                                    return int(val.get(k))
                            for k in ('user','team','account'):
                                v2 = val.get(k)
                                if isinstance(v2, dict):
                                    for kk in ('id','user_id','team_id','account_id'):
                                        if kk in v2 and v2.get(kk) is not None:
                                            return int(v2.get(kk))
                            return None
                        if isinstance(val, (int, str)) and str(val).strip() != '':
                            return int(val)
                    except Exception:
                        return None
                    return None
                acct_type = (
                    srec.get('account_type')
                    or (srec.get('account') or {}).get('type')
                    or (srec.get('user') or {}).get('type')
                    or (srec.get('team') or {}).get('type')
                    or ''
                )
                acct_type = str(acct_type).strip().lower()
                acct_id_val = srec.get('account_id') if srec.get('account_id') is not None else (srec.get('account') or {})
                if acct_type in ('team', 'teams'):
                    tid = _id(acct_id_val)
                    if tid is not None: _touch(teams_info, tid, idx, srec)
                elif acct_type in ('user', 'users'):
                    uid = _id(acct_id_val)
                    if uid is not None: _touch(users_info, uid, idx, srec)
                if (acct_type == '') and (acct_id_val is not None):
                    aid = _id(acct_id_val)
                    if aid is not None:
                        if user_mode.startswith('team'): _touch(teams_info, aid, idx, srec)
                        else: _touch(users_info, aid, idx, srec)
                uid = _id(srec.get('user_id'))
                if uid is None: uid = _id(srec.get('user'))
                tid = _id(srec.get('team_id'))
                if tid is None: tid = _id(srec.get('team'))
                if uid is not None: _touch(users_info, uid, idx, srec)
                if tid is not None: _touch(teams_info, tid, idx, srec)
            except Exception:
                continue
        # Team-mode user attribution fallback
        if (not users_info) and teams_info:
            try:
                team_solves_cache = {}
                team_members_cache = {}
                user_solves_cache = {}
                max_teams_for_fallback = 50
                if len(teams_info) > max_teams_for_fallback:
                    logs.append(f"[ctfd_stats_one] challenge {cid} fallback skipped: {len(teams_info)} teams > {max_teams_for_fallback}")
                else:
                    def _match_chal(rec):
                        try:
                            sid = rec.get('challenge_id') if isinstance(rec, dict) else None
                            if sid is None and isinstance(rec, dict): sid = rec.get('challenge')
                            return (sid is not None and int(sid) == int(cid))
                        except Exception:
                            return False
                    def _pick_earliest_ts(recs):
                        best = None; best_ep = None
                        for r in recs or []:
                            ep = _parse_ts_epoch(_extract_ts(r))
                            if ep is None: continue
                            if best_ep is None or ep < best_ep:
                                best_ep = ep; best = r
                        return best
                    def _uid_from_rec(rec):
                        try:
                            if not isinstance(rec, dict): return None
                            for k in ('user_id','user'):
                                v = rec.get(k)
                                if v is not None:
                                    try:
                                        if isinstance(v, dict):
                                            for kk in ('id','user_id','account_id'):
                                                if kk in v and v.get(kk) is not None:
                                                    return int(v.get(kk))
                                        return int(v)
                                    except Exception:
                                        pass
                            acc = rec.get('account')
                            if isinstance(acc, dict):
                                t = str(acc.get('type') or '').strip().lower()
                                if t in ('user','users'):
                                    for kk in ('id','user_id','account_id'):
                                        if kk in acc and acc.get(kk) is not None:
                                            try: return int(acc.get(kk))
                                            except Exception: break
                            return None
                        except Exception:
                            return None
                    found_users = 0
                    for tid in list(teams_info.keys()):
                        try:
                            if tid in team_solves_cache: tsolves = team_solves_cache[tid]
                            else:
                                tsolves = client.list_team_solves(tid); team_solves_cache[tid] = tsolves
                            t_ch = [r for r in (tsolves or []) if _match_chal(r)]
                            chosen = _pick_earliest_ts(t_ch)
                            uid = _uid_from_rec(chosen) if chosen else None
                            if uid is not None:
                                _touch(users_info, uid, 0, chosen or {}); found_users += 1; continue
                            if tid in team_members_cache: members = team_members_cache[tid]
                            else:
                                members = client.list_team_members(tid); team_members_cache[tid] = members
                            best_user = None; best_ep = None; best_rec = None
                            for m in (members or []):
                                try:
                                    mid = None
                                    for kk in ('id','user_id','account_id'):
                                        if kk in m and m.get(kk) is not None:
                                            mid = int(m.get(kk)); break
                                    if mid is None: continue
                                    if mid in user_solves_cache: usolves = user_solves_cache[mid]
                                    else:
                                        usolves = client.list_user_solves(mid); user_solves_cache[mid] = usolves
                                    u_ch = [r for r in (usolves or []) if _match_chal(r)]
                                    u_pick = _pick_earliest_ts(u_ch)
                                    if u_pick is None: continue
                                    ep = _parse_ts_epoch(_extract_ts(u_pick))
                                    if ep is None: continue
                                    if best_ep is None or ep < best_ep:
                                        best_ep = ep; best_user = mid; best_rec = u_pick
                                except Exception:
                                    continue
                            if best_user is not None:
                                _touch(users_info, best_user, 0, best_rec or {}); found_users += 1
                        except Exception:
                            continue
                    if found_users:
                        logs.append(f"[ctfd_stats_one] challenge {cid} user fallback attributed {found_users} user(s)")
            except Exception:
                pass
        def _sorted_entries(info_map):
            try:
                items_loc = list(info_map.items())
                items_loc.sort(key=lambda kv: ((kv[1].get('ts_epoch') is None), kv[1].get('ts_epoch') or float('inf'), int(kv[1].get('first_idx') or 1e9)))
                out = []
                for i, (idv, meta) in enumerate(items_loc, start=1):
                    out.append((idv, i, meta))
                return out
            except Exception:
                out = []; idx2 = 1
                for idv, meta in info_map.items(): out.append((idv, idx2, meta)); idx2 += 1
                return out
        teams = []
        for tid, ordn, meta in _sorted_entries(teams_info):
            nm = client.get_team_name(tid) or str(tid)
            teams.append({ 'id': tid, 'name': nm, 'ord': int(ordn), 'ts': meta.get('ts') })
        users = []
        for uid, ordn, meta in _sorted_entries(users_info):
            nm = client.get_user_name(uid) or str(uid)
            users.append({ 'id': uid, 'name': nm, 'ord': int(ordn), 'ts': meta.get('ts') })
        item = {
            'id': int(cid), 'name': name, 'category': category, 'points': points,
            'solves': len(solves), 'teams': teams, 'users': users,
            'visible': bool(visible) if (visible is not None) else None,
        }
        return jsonify({ 'item': item, 'using_token': bool(getattr(client, 'token', '')), 'logs': logs })
    except CTFdError as e:
        status = int(getattr(e, 'status_code', 400) or 400)
        return jsonify({ 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', []) }), status if status in (401,403) else 502
    except Exception as e:
        return jsonify({ 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', []) }), 500

@api_bp.post('/projects/<pid>/ctfd/challenges/visibility')
@_secure_route()
def ctfd_challenges_visibility(pid: str):
    """Bulk update visibility for a list of CTFd challenges.
    Body: { baseUrl, port?, token?, username?, password?, verifySSL?, ids: [int], visible: bool }
    Returns: { ok, updated: [ { id, state } ], errors: [ { id, error } ], using_token, logs }
    """
    s = _store(); proj = s.get(pid)
    if not proj:
        return jsonify({'ok': False, 'error': 'Project not found'}), 404
    try:
        client = _ctfd_client_from_req(proj)
        # Require elevated role for updates
        role = client.get_role() if hasattr(client, 'get_role') else ''
        if role not in ('admin', 'teacher'):
            return jsonify({'ok': False, 'error': 'forbidden', 'message': f'Admin/Teacher role required (got {role})'}), 403
        body = request.get_json(silent=True) or {}
        ids = body.get('ids') or []
        visible = body.get('visible')
        try:
            ids = [int(i) for i in ids if str(i).strip() != '']
        except Exception:
            ids = []
        if not isinstance(visible, bool):
            return jsonify({'ok': False, 'error': 'visible must be a boolean'}), 400
        if not ids:
            return jsonify({'ok': False, 'error': 'ids must be a non-empty array'}), 400
        updated = []
        errors = []
        for cid in ids:
            try:
                ch = client.update_challenge_state(int(cid), bool(visible)) if hasattr(client, 'update_challenge_state') else {}
                # Determine resulting state/visibility best-effort
                st = None
                try:
                    st = ch.get('state') if isinstance(ch, dict) else None
                except Exception:
                    st = None
                updated.append({'id': int(cid), 'state': st})
            except CTFdError as e:
                # Propagate granular error per id
                errors.append({'id': int(cid), 'error': str(e), 'status': int(getattr(e, 'status_code', 400) or 400)})
            except Exception as e:
                errors.append({'id': int(cid), 'error': str(e)})
        return jsonify({'ok': True, 'updated': updated, 'errors': errors, 'using_token': bool(client.token), 'logs': getattr(client, 'logs', [])})
    except CTFdError as e:
        status = int(getattr(e, 'status_code', 400) or 400)
        msg = str(e)
        if status in (401, 403):
            return jsonify({'ok': False, 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', [])}), status
        return jsonify({'ok': False, 'error': msg, 'logs': getattr(locals().get('client', {}), 'logs', [])}), 502
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e), 'logs': getattr(locals().get('client', {}), 'logs', [])}), 500
