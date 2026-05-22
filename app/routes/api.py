import os
import io
import json
import zipfile
import hashlib
import base64
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
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
import re
import mimetypes
from urllib.parse import urlparse, urlunparse
from werkzeug.utils import secure_filename
from urllib.parse import urlsplit
import threading
from datetime import datetime, timedelta, timezone
from dataclasses import asdict
import time
from ..connectors.proxmox import ProxmoxClient, GuestAgentUnavailableError
from ..connectors.ctfd import CTFdClient, CTFdError
from ..storage.projects import (
    ProjectStore,
    Project,
    sanitize_start_command_steps,
    sanitize_validation_commands,
    _coerce_enabled,
)
from ..storage.runtime import RuntimeStore
from ..storage.secrets import encrypt_str as _enc_secret, decrypt_str as _dec_secret
from ..storage.user_secrets import UserSecretsStore

api_bp = Blueprint("api", __name__)
LOG = logging.getLogger(__name__)

@api_bp.route("/test/credentials", methods=["POST"])
def api_test_credentials():
    body = request.get_json(silent=True) or {}
    pmx_creds = body.get("proxmox")
    ctf_creds = body.get("ctfd")
    
    if pmx_creds:
        url = (pmx_creds.get("url") or "").strip()
        user = (pmx_creds.get("username") or "").strip()
        pwd = pmx_creds.get("password") or ""
        verify_ssl = bool(pmx_creds.get("verify_ssl", False))
        if not url or not user or not pwd:
            return jsonify({"ok": False, "error": "Proxmox URL, Username, and Password are required."})
        try:
            client = ProxmoxClient(url, username=user, password=pwd, verify=verify_ssl)
            nodes = client.list_nodes()
            if not nodes:
                return jsonify({"ok": False, "error": "Proxmox connection succeeded but returned no nodes. Check token permissions."})
        except Exception as e:
            return jsonify({"ok": False, "error": f"Proxmox validation failed: {str(e)}"})
            
    if ctf_creds:
        url = (ctf_creds.get("url") or "").strip()
        token = (ctf_creds.get("token") or "").strip()
        verify_ssl = bool(ctf_creds.get("verify_ssl", False))
        if not url or not token:
            return jsonify({"ok": False, "error": "CTFd URL and Admin Access Token are required."})
        try:
            client = CTFdClient(url, token, verify_ssl=verify_ssl)
            u = client.get_current_user()
            if not u:
                return jsonify({"ok": False, "error": "CTFd connection failed or token is invalid."})
        except Exception as e:
            return jsonify({"ok": False, "error": f"CTFd validation failed: {str(e)}"})
            
    return jsonify({"ok": True})


def _hash_audio_data_url(data_url: str) -> Optional[str]:
    try:
        _mime, raw_bytes = ProjectStore._decode_data_url(data_url)
    except Exception:
        raw_bytes = b""
    if not raw_bytes:
        return None
    try:
        return hashlib.sha256(raw_bytes).hexdigest()
    except Exception:
        return None


def _remap_sound_keys_in_obj(obj: Any, remap: Dict[str, str]):
    if not remap:
        return
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if k == 'soundKey' and isinstance(v, str) and v in remap:
                obj[k] = remap[v]
                continue
            _remap_sound_keys_in_obj(v, remap)
    elif isinstance(obj, list):
        for it in obj:
            _remap_sound_keys_in_obj(it, remap)


def _dedupe_media_audio(audio_map: Any) -> Any:
    """Collapse duplicate uploaded audio entries (media:*) by hashing clip bytes.

    This de-dupes within the imported payload and remaps any `soundKey` references
    to point at the retained canonical media key.
    """
    if not isinstance(audio_map, dict):
        return audio_map

    hash_to_media_key: Dict[str, str] = {}
    media_remap: Dict[str, str] = {}

    for raw_key, entry in list(audio_map.items()):
        key = str(raw_key or '')
        if not key.startswith('media:'):
            continue
        if not isinstance(entry, dict):
            continue

        sounds = entry.get('sounds')
        if not isinstance(sounds, list) or not sounds:
            data_url = entry.get('dataUrl')
            sounds = [{'dataUrl': data_url}] if data_url else []

        data_url = None
        for s in sounds:
            if isinstance(s, dict) and isinstance(s.get('dataUrl'), str) and s.get('dataUrl').startswith('data:'):
                data_url = s.get('dataUrl')
                break
        if not data_url:
            continue

        digest = _hash_audio_data_url(str(data_url))
        if not digest:
            continue
        if digest in hash_to_media_key:
            media_remap[key] = hash_to_media_key[digest]
        else:
            hash_to_media_key[digest] = key

    if media_remap:
        _remap_sound_keys_in_obj(audio_map, media_remap)
        for dup_key, canonical_key in media_remap.items():
            try:
                if dup_key != canonical_key and dup_key in audio_map:
                    audio_map.pop(dup_key, None)
            except Exception:
                pass

    return audio_map

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


def _validate_iface(value: str) -> str:
    """Validate a Linux bridge/interface name using a tight allowlist."""
    try:
        iface = str(value or '').strip()
    except Exception:
        iface = ''
    if not iface:
        raise ValueError("interface name required")
    if not SECURE_IFACE_RE.match(iface):
        raise ValueError(f"invalid interface name: {iface}")
    return iface


def _safe_file_stem(value: str, default: str = "project") -> str:
    """Return a filesystem-friendly stem for export file names."""
    try:
        text = str(value or '').strip()
    except Exception:
        text = ''
    if not text:
        text = default
    safe = secure_filename(text) or ''
    safe = safe.strip('._')
    if not safe:
        safe = re.sub(r'[^A-Za-z0-9_-]+', '_', text).strip('._')
    return safe or default


def _format_ymdhms(dt_obj: datetime) -> str:
    """Format datetime as YYYYMMDD_HHMMSS in UTC."""
    if not isinstance(dt_obj, datetime):
        raise TypeError("dt_obj must be datetime")
    if dt_obj.tzinfo is None:
        dt_obj = dt_obj.replace(tzinfo=timezone.utc)
    else:
        dt_obj = dt_obj.astimezone(timezone.utc)
    return dt_obj.strftime("%Y%m%d_%H%M%S")


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    """Parse flexible ISO-8601-ish timestamps into datetime objects."""
    if value is None:
        return None
    try:
        text = str(value).strip()
    except Exception:
        text = ''
    if not text:
        return None
    candidate = text
    if candidate.endswith('Z'):
        candidate = candidate[:-1] + '+00:00'
    try:
        return datetime.fromisoformat(candidate)
    except Exception:
        pass
    # Fallback formats commonly seen in logs/exports
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
    ):
        try:
            return datetime.strptime(text, fmt)
        except Exception:
            continue
    try:
        return datetime.utcfromtimestamp(float(text))
    except Exception:
        return None


def _project_max_jobs(proj: Optional[Project], default: int = 5) -> int:
    """Return the configured per-project max job count (>=1)."""
    try:
        value = int(getattr(proj, 'proxmox_max_create_jobs', default) or default)
    except Exception:
        value = default
    if value < 1:
        value = 1
    return value


def _pool_workers_for(proj: Optional[Project], item_count: int, hard_cap: int = 16) -> int:
    """Clamp worker pools to the project max jobs and optional hard cap."""
    try:
        count = int(item_count)
    except Exception:
        count = 0
    max_jobs = _project_max_jobs(proj)
    limit = hard_cap if (hard_cap and hard_cap > 0) else max_jobs
    usable_cap = limit if limit > 0 else max_jobs
    workers = min(count, max_jobs, usable_cap) if count > 0 else 1
    return max(1, workers)


_BRIDGE_OWNER_COMMENT_PREFIX = 'SCE-BRIDGE'


def _adaptor_numeric_suffix_letters(value: Any) -> str:
    try:
        num = int(value)
    except Exception:
        return ''
    if num < 0:
        return ''
    out = ''
    while True:
        out = chr(65 + (num % 26)) + out
        num = (num // 26) - 1
        if num < 0:
            break
    return out


def _normalize_bridge_adaptor_name(adaptor_name: Any) -> str:
    try:
        raw = str(adaptor_name or '').strip()
        if not raw:
            return ''
        base = re.sub(r"[^A-Za-z]", "", raw)
        suffix = ''
        digit_match = re.search(r"(\d+)$", raw)
        if digit_match:
            suffix = _adaptor_numeric_suffix_letters(digit_match.group(1))
        if suffix:
            allowed_base = max(0, 8 - len(suffix))
            return f"{base[:allowed_base]}{suffix}" or suffix[:8]
        return base[:8]
    except Exception:
        return ''


def _bridge_iface_name(idx: Any, adaptor_name: Any) -> str:
    try:
        index = int(idx)
    except Exception:
        index = 0
    base = _normalize_bridge_adaptor_name(adaptor_name)
    name = f"{base}{index}" if base else f"br{index}"
    if len(name) > 15:
        name = name[:15]
    return name or f"br{index}"


def _bridge_legacy_iface_name(tag: str, idx: Any, adaptor_name: Any) -> str:
    try:
        index = int(idx)
    except Exception:
        index = 0
    base_old = f"{adaptor_name}|{tag}|{index}"
    h = int(hashlib.sha1(base_old.encode('utf-8')).hexdigest()[:6], 16)
    num = 100 + (h % 8899)
    return f"vmbr{num}"


def _bridge_owner_comment(pid: str, idx: Any, adaptor_name: Any, source: str = '') -> str:
    parts = [
        _BRIDGE_OWNER_COMMENT_PREFIX,
        f"pid={str(pid or '').strip()}",
        f"idx={int(idx) if str(idx).strip() else 0}",
        f"adaptor={_normalize_bridge_adaptor_name(adaptor_name) or 'na'}",
    ]
    if source:
        parts.append(f"source={str(source).strip()}")
    return ' '.join(parts)


def _bridge_owner_comment_for_iface(pid: str, idx: Any, iface_name: Any, source: str = '') -> str:
    try:
        iface = str(iface_name or '').strip()
    except Exception:
        iface = ''
    adaptor = re.sub(r"\d+$", "", iface)
    return _bridge_owner_comment(pid, idx, adaptor or iface, source)


def _parse_bridge_owner_comment(comment: Any) -> Dict[str, str]:
    try:
        raw = str(comment or '').strip()
    except Exception:
        raw = ''
    if not raw.startswith(_BRIDGE_OWNER_COMMENT_PREFIX):
        return {}
    parts = raw.split()
    out: Dict[str, str] = {}
    for token in parts[1:]:
        if '=' not in token:
            continue
        key, value = token.split('=', 1)
        out[key.strip()] = value.strip()
    return out


def _build_bridge_project_snapshot(proj: Project, tag: str) -> Dict[str, Any]:
    vms = []
    for vm in list(getattr(proj, 'vms', []) or []):
        try:
            name = str(getattr(vm, 'name', '') or '').strip()
        except Exception:
            name = ''
        if not name:
            continue
        adaptors = []
        for adaptor in list(getattr(vm, 'internal_network_adaptors', []) or []):
            normalized = _normalize_bridge_adaptor_name(adaptor)
            if normalized:
                adaptors.append(normalized)
        vms.append({ 'name': name, 'adaptors': adaptors })
    return {
        'id': str(getattr(proj, 'id', '') or ''),
        'name': str(getattr(proj, 'name', '') or ''),
        'tag': str(tag or ''),
        'vms': vms,
    }


def _project_has_bridge_consumer_on_node(project_snapshot: Dict[str, Any], node: str, idx: Any, adaptor_name: Any, live_name_map: Dict[str, Dict[str, Any]]) -> bool:
    adaptor_key = _normalize_bridge_adaptor_name(adaptor_name)
    if not adaptor_key:
        return False
    try:
        index = int(idx)
    except Exception:
        return False
    tag = str((project_snapshot or {}).get('tag') or '')
    for vm in list((project_snapshot or {}).get('vms') or []):
        if adaptor_key not in list((vm or {}).get('adaptors') or []):
            continue
        gen_name = f"{str((vm or {}).get('name') or '')}{tag}{index}"
        info = live_name_map.get(gen_name.lower()) or {}
        if str(info.get('node') or '') == str(node or ''):
            return True
    return False


def _append_unique_reason(items: List[Dict[str, Any]], item: Dict[str, Any]):
    reason = str((item or {}).get('reason') or '')
    node = str((item or {}).get('node') or '')
    name = str((item or {}).get('name') or '')
    for existing in items:
        if str(existing.get('reason') or '') == reason and str(existing.get('node') or '') == node and str(existing.get('name') or '') == name:
            return
    items.append(item)


def _scan_bridges_in_use(node: str, candidate_bridges: List[str], client: ProxmoxClient) -> Set[str]:
    wanted = {str(b or '').strip() for b in (candidate_bridges or []) if str(b or '').strip()}
    in_use: Set[str] = set()
    if not wanted:
        return in_use
    try:
        for ent in client.list_qemu_vms(node) or []:
            try:
                r_vmid = ent.get('vmid')
                if r_vmid is None:
                    continue
                cfg_other = client.get_qemu_config(node=node, vmid=int(r_vmid)) or {}
                for key, value in (cfg_other or {}).items():
                    if not str(key).startswith('net') or not isinstance(value, str):
                        continue
                    parts = [p.strip() for p in value.split(',') if p]
                    bridge = next((p.split('=', 1)[1] for p in parts if p.startswith('bridge=')), '')
                    if bridge in wanted:
                        in_use.add(bridge)
                if in_use >= wanted:
                    break
            except Exception:
                continue
    except Exception:
        return in_use
    return in_use


def _execute_delete_bridge_cleanup(project_snapshot: Dict[str, Any], client: ProxmoxClient, bulk_bridge_deletions: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    notices: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    network_applied_nodes: List[str] = []
    network_apply_errors: List[Dict[str, Any]] = []
    bridges_to_reload: Set[str] = set()
    project_id = str((project_snapshot or {}).get('id') or '')

    for node, items in (bulk_bridge_deletions or {}).items():
        try:
            iface_meta: Dict[str, Dict[str, Any]] = {}
            try:
                for net in client.list_network(node) or []:
                    iface = str((net or {}).get('iface') or '')
                    if iface:
                        iface_meta[iface] = net
            except Exception:
                iface_meta = {}

            live_name_map: Dict[str, Dict[str, Any]] = {}
            try:
                for ent in client.list_qemu_vms(node) or []:
                    name = str((ent or {}).get('name') or '')
                    if name:
                        live_name_map[name.lower()] = {
                            'node': node,
                            'vmid': int(ent.get('vmid')) if ent.get('vmid') is not None else None,
                            'type': 'qemu'
                        }
            except Exception:
                pass
            try:
                if hasattr(client, 'list_lxc_vms'):
                    for ent in client.list_lxc_vms(node) or []:
                        name = str((ent or {}).get('name') or ent.get('hostname') or '')
                        if name:
                            live_name_map[name.lower()] = {
                                'node': node,
                                'vmid': int(ent.get('vmid')) if ent.get('vmid') is not None else None,
                                'type': 'lxc'
                            }
            except Exception:
                pass

            unknown_entries: List[Dict[str, Any]] = []
            seen_bridge: Set[str] = set()
            for entry in list(items or []):
                bridge = str((entry or {}).get('bridge') or '')
                if not bridge or bridge in seen_bridge:
                    continue
                seen_bridge.add(bridge)
                idx = int((entry or {}).get('index') or 0)
                gen_name = str((entry or {}).get('name') or '')
                adaptor = str((entry or {}).get('adaptor') or '')

                if idx > 0 and adaptor and _project_has_bridge_consumer_on_node(project_snapshot, node, idx, adaptor, live_name_map):
                    _append_unique_reason(notices, { 'index': idx, 'name': gen_name, 'node': node, 'reason': f'bridge retained (project consumer remains) {bridge}' })
                    continue

                net_entry = iface_meta.get(bridge)
                if not net_entry:
                    _append_unique_reason(notices, { 'index': idx, 'name': gen_name, 'node': node, 'reason': f'bridge delete skipped for {bridge}: does not exist' })
                    continue

                owner = _parse_bridge_owner_comment((net_entry or {}).get('comments') or (net_entry or {}).get('comment'))
                if owner:
                    owner_matches = (
                        owner.get('pid') == project_id
                        and owner.get('idx') == str(idx)
                        and owner.get('adaptor') == _normalize_bridge_adaptor_name(adaptor)
                    )
                    if not owner_matches:
                        owner_desc = f"pid={owner.get('pid') or '?'} idx={owner.get('idx') or '?'} adaptor={owner.get('adaptor') or '?'}"
                        _append_unique_reason(notices, { 'index': idx, 'name': gen_name, 'node': node, 'reason': f'bridge retained (foreign owner {owner_desc}) {bridge}' })
                        continue
                    try:
                        client.delete_bridge(node=node, iface=bridge)
                        bridges_to_reload.add(node)
                    except Exception as e:
                        msg = str(e).lower()
                        warn = ('not exist' in msg) or ('no such' in msg) or ('not found' in msg) or (' 404' in msg)
                        item = { 'index': idx, 'name': gen_name, 'node': node, 'reason': f'bridge delete skipped for {bridge}: does not exist' if warn else f'bridge delete failed for {bridge}: {e}' }
                        if warn:
                            _append_unique_reason(notices, item)
                        else:
                            errors.append(item)
                    continue

                unknown_entries.append(entry)

            if unknown_entries:
                bridges_in_use = _scan_bridges_in_use(node, [str((entry or {}).get('bridge') or '') for entry in unknown_entries], client)
                for entry in unknown_entries:
                    bridge = str((entry or {}).get('bridge') or '')
                    idx = int((entry or {}).get('index') or 0)
                    gen_name = str((entry or {}).get('name') or '')
                    if bridge in bridges_in_use:
                        _append_unique_reason(notices, { 'index': idx, 'name': gen_name, 'node': node, 'reason': f'bridge retained (in use) {bridge}' })
                        continue
                    try:
                        client.delete_bridge(node=node, iface=bridge)
                        bridges_to_reload.add(node)
                    except Exception as e:
                        msg = str(e).lower()
                        warn = ('not exist' in msg) or ('no such' in msg) or ('not found' in msg) or (' 404' in msg)
                        item = { 'index': idx, 'name': gen_name, 'node': node, 'reason': f'bridge delete skipped for {bridge}: does not exist' if warn else f'bridge delete failed for {bridge}: {e}' }
                        if warn:
                            _append_unique_reason(notices, item)
                        else:
                            errors.append(item)
        except Exception as e:
            errors.append({ 'node': node, 'reason': f'bulk bridge cleanup failed: {e}' })

    for node in bridges_to_reload:
        try:
            client.reload_network(node)
            network_applied_nodes.append(node)
        except Exception as e:
            network_apply_errors.append({ 'node': node, 'reason': f'network reload failed: {e}' })

    return {
        'notices': notices,
        'errors': errors,
        'network_applied_nodes': network_applied_nodes,
        'network_apply_errors': network_apply_errors,
    }


def _schedule_delete_bridge_cleanup(project_snapshot: Dict[str, Any], client_kwargs: Dict[str, Any], bulk_bridge_deletions: Dict[str, List[Dict[str, Any]]]) -> bool:
    cleanup_plan = {
        str(node): [dict(entry or {}) for entry in list(items or [])]
        for node, items in (bulk_bridge_deletions or {}).items()
        if items
    }
    if not cleanup_plan:
        return False

    def _worker():
        try:
            client = ProxmoxClient(**client_kwargs)
            result = _execute_delete_bridge_cleanup(project_snapshot, client, cleanup_plan)
            try:
                LOG.info(
                    "Deferred delete bridge cleanup finished for %s: nodes=%s reloads=%s notices=%s errors=%s",
                    project_snapshot.get('id') or '?',
                    len(cleanup_plan),
                    len(result.get('network_applied_nodes') or []),
                    len(result.get('notices') or []),
                    len(result.get('errors') or []) + len(result.get('network_apply_errors') or []),
                )
            except Exception:
                pass
        except Exception:
            LOG.exception("Deferred delete bridge cleanup failed for %s", project_snapshot.get('id') or '?')

    worker = threading.Thread(
        target=_worker,
        name=f"sce-delete-cleanup-{project_snapshot.get('id') or 'unknown'}",
        daemon=True,
    )
    worker.start()
    return True


def _write_project_audio_to_zip(zf: zipfile.ZipFile, proj: Project, *, include_prefixes: Optional[tuple[str, ...]] = None) -> int:
    """Embed audio clips into the provided ZipFile, returning number of clips written.

    include_prefixes: when provided, only include audio entries whose key starts with one of these prefixes.
    """
    audio = getattr(proj, 'audio', {}) or {}
    if not isinstance(audio, dict) or not audio:
        return 0
    manifest = {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "events": [],
    }
    total_written = 0
    for idx, (raw_key, entry) in enumerate(audio.items(), start=1):
        if include_prefixes:
            try:
                key_s = str(raw_key or '')
            except Exception:
                key_s = ''
            if not any(key_s.startswith(pfx) for pfx in include_prefixes):
                continue
        if not isinstance(entry, dict):
            continue
        try:
            event_key = str(raw_key or '').strip()
        except Exception:
            event_key = ''
        if not event_key:
            event_key = f"event_{idx}"
        safe_key = _safe_file_stem(event_key, default=f"event_{idx}")
        sounds = entry.get('sounds') or []
        if not sounds and entry.get('dataUrl'):
            sounds = [{
                'dataUrl': entry.get('dataUrl'),
                'name': entry.get('name'),
                'size': entry.get('size'),
                'type': entry.get('type'),
                'updated': entry.get('updated'),
            }]
        if not isinstance(sounds, list):
            continue
        clip_entries = []
        for clip_idx, sound in enumerate(sounds, start=1):
            if not isinstance(sound, dict):
                continue
            data_url = sound.get('dataUrl')
            if not isinstance(data_url, str) or not data_url.startswith('data:'):
                continue
            mime, raw_bytes = ProjectStore._decode_data_url(data_url)
            if not raw_bytes:
                continue
            ext = ''
            if mime:
                try:
                    ext = mimetypes.guess_extension(mime) or ''
                except Exception:
                    ext = ''
            if not ext and mime and '/' in mime:
                ext = f".{mime.split('/')[-1]}"
            if not ext:
                ext = '.bin'
            clip_name = sound.get('name') or f"clip_{clip_idx}"
            clip_stem = secure_filename(str(clip_name)) or f"clip_{clip_idx}"
            arc_path = f"audio/{safe_key}/{clip_stem}{ext}"
            try:
                zf.writestr(arc_path, raw_bytes)
            except Exception as exc:
                LOG.warning("Failed to add audio clip %s to export: %s", arc_path, exc)
                continue
            total_written += 1
            clip_entries.append({
                'name': clip_name,
                'filename': arc_path,
                'size': len(raw_bytes),
                'mime': mime or 'application/octet-stream',
                'updated': sound.get('updated'),
            })
        if clip_entries:
            manifest['events'].append({
                'key': event_key,
                'safeKey': safe_key,
                'clipCount': len(clip_entries),
                'clips': clip_entries,
                'speakTemplates': entry.get('speakTemplates') or [],
            })
    if total_written:
        try:
            zf.writestr('audio/manifest.json', json.dumps(manifest, indent=2))
        except Exception as exc:
            LOG.warning("Failed to write audio manifest: %s", exc)
    return total_written

# VM refresh performance caching
_VM_CONFIG_CACHE = {}  # {f"{node}:{vmid}": (timestamp, config_dict)}
_POOL_CACHE = {}  # {poolid: (timestamp, set_of_vmids)}
_CACHE_TTL_SECONDS = 60  # Cache VM configs for 60 seconds
_CTFD_CATEGORY_FIRSTS_CACHE = {}  # {cache_key: (timestamp_utc, payload_dict)}
_CTFD_CATEGORY_FIRSTS_TTL_SECONDS = 30


def _prune_ctfd_category_firsts_cache(now: Optional[datetime] = None) -> None:
    try:
        current = now or datetime.now(timezone.utc)
        expired = []
        for key, value in list(_CTFD_CATEGORY_FIRSTS_CACHE.items()):
            try:
                cached_time, _payload = value
            except Exception:
                expired.append(key)
                continue
            if current - cached_time >= timedelta(seconds=_CTFD_CATEGORY_FIRSTS_TTL_SECONDS):
                expired.append(key)
        for key in expired:
            _CTFD_CATEGORY_FIRSTS_CACHE.pop(key, None)
    except Exception:
        return


def _make_ctfd_category_firsts_cache_key(pid: str, client: CTFdClient, body: Dict[str, Any]) -> str:
    try:
        auth_token = str((body or {}).get('token') or '').strip()
    except Exception:
        auth_token = ''
    try:
        auth_user = str((body or {}).get('username') or '').strip().lower()
    except Exception:
        auth_user = ''
    auth_kind = 'token' if auth_token else ('user' if auth_user else 'anon')
    auth_marker = auth_token or auth_user
    auth_hash = hashlib.sha256(auth_marker.encode('utf-8')).hexdigest()[:16] if auth_marker else 'anon'
    try:
        base_url = str(getattr(client, 'base_url', '') or '').rstrip('/').lower()
    except Exception:
        base_url = ''
    verify_ssl = '1' if getattr(client, 'verify_ssl', True) else '0'
    return f"{str(pid or '').strip()}|{base_url}|{verify_ssl}|{auth_kind}:{auth_hash}"


def _get_cached_ctfd_category_firsts(cache_key: str):
    try:
        now = datetime.now(timezone.utc)
        cached = _CTFD_CATEGORY_FIRSTS_CACHE.get(str(cache_key or ''))
        if not cached:
            return None
        cached_time, payload = cached
        if now - cached_time >= timedelta(seconds=_CTFD_CATEGORY_FIRSTS_TTL_SECONDS):
            _CTFD_CATEGORY_FIRSTS_CACHE.pop(str(cache_key or ''), None)
            return None
        return copy.deepcopy(payload)
    except Exception:
        return None


def _set_cached_ctfd_category_firsts(cache_key: str, payload: Dict[str, Any]) -> None:
    try:
        now = datetime.now(timezone.utc)
        _prune_ctfd_category_firsts_cache(now)
        _CTFD_CATEGORY_FIRSTS_CACHE[str(cache_key or '')] = (now, copy.deepcopy(payload))
    except Exception:
        return


def _invalidate_vm_config_cache_entries(entries: "Iterable[tuple[str, int]]") -> None:
    """Invalidate specific VM config cache entries.

    VM refresh uses `_get_cached_vm_config` for performance. After actions that
    mutate QEMU config (like nets_set/nets_remove), invalidate affected entries
    so an immediate refresh reflects the new state.
    """
    try:
        for node, vmid in entries or []:
            try:
                key = f"{str(node)}:{int(vmid)}"
                _VM_CONFIG_CACHE.pop(key, None)
            except Exception:
                continue
    except Exception:
        return

def _get_cached_vm_config(client, node: str, vmid: int, force_refresh: bool = False, is_lxc: bool = False):
    """Get VM config with caching for performance"""
    cache_key = f"{node}:{vmid}"
    now = datetime.now()
    
    if not force_refresh and cache_key in _VM_CONFIG_CACHE:
        cached_time, cached_cfg = _VM_CONFIG_CACHE[cache_key]
        if now - cached_time < timedelta(seconds=_CACHE_TTL_SECONDS):
            return cached_cfg
    
    # Fetch fresh from Proxmox
    if is_lxc:
        cfg = client.get_lxc_config(node=node, vmid=int(vmid))
    else:
        cfg = client.get_qemu_config(node=node, vmid=int(vmid))
    _VM_CONFIG_CACHE[cache_key] = (now, cfg)
    return cfg


def _qemu_agent_enabled_config(cfg: Dict[str, Any]) -> bool:
    raw = (cfg or {}).get('agent')
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return int(raw) != 0
    text = str(raw).strip().lower()
    if not text:
        return False
    truthy = {'1', 'true', 'yes', 'on', 'enabled'}
    falsy = {'0', 'false', 'no', 'off', 'disabled'}
    head = text.split(',', 1)[0].strip()
    if head in truthy:
        return True
    if head in falsy:
        return False
    for part in [p.strip() for p in text.split(',') if p.strip()]:
        if '=' not in part:
            continue
        key, val = [x.strip() for x in part.split('=', 1)]
        if key != 'enabled':
            continue
        if val in truthy:
            return True
        if val in falsy:
            return False
    return False


def _qemu_agent_enabled_from_cfg_or_hint(cfg: Dict[str, Any], hint_raw: Any) -> bool:
    """Prefer config-level agent option when present; otherwise use list hint."""
    if isinstance(cfg, dict) and ('agent' in cfg):
        return _qemu_agent_enabled_config(cfg)
    return _qemu_agent_enabled_config({'agent': hint_raw})


def _prefetch_vm_configs_parallel(
    proj: Optional[Project],
    vm_refs: Iterable[Tuple[str, int]],
    *,
    force_refresh: bool,
    client_factory,
    vm_types: Optional[Dict[Tuple[str, int], str]] = None,
) -> Dict[Tuple[str, int], Dict[str, Any]]:
    """Fetch VM configs in parallel for refresh-heavy endpoints.

    Returns a mapping of (node, vmid) -> config dict. Individual fetch failures are
    logged and omitted so callers can still return partial status data.
    """
    unique_refs: List[Tuple[str, int]] = []
    seen: Set[Tuple[str, int]] = set()
    for raw_node, raw_vmid in vm_refs or []:
        try:
            ref = (str(raw_node), int(raw_vmid))
        except Exception:
            continue
        if not ref[0] or ref in seen:
            continue
        seen.add(ref)
        unique_refs.append(ref)

    if not unique_refs:
        return {}

    results: Dict[Tuple[str, int], Dict[str, Any]] = {}

    def _fetch_one(ref: Tuple[str, int]):
        node, vmid = ref
        thread_client = client_factory()
        is_lxc = False
        if vm_types and vm_types.get(ref) == 'lxc':
            is_lxc = True
        cfg = _get_cached_vm_config(thread_client, node, vmid, force_refresh=force_refresh, is_lxc=is_lxc) or {}
        return ref, cfg

    workers = _pool_workers_for(proj, len(unique_refs), hard_cap=8)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(_fetch_one, ref): ref for ref in unique_refs}
        for fut in as_completed(future_map):
            ref = future_map[fut]
            try:
                fetched_ref, cfg = fut.result()
                results[fetched_ref] = cfg if isinstance(cfg, dict) else {}
            except Exception as exc:
                LOG.warning("Could not fetch config for VM %s/%s: %s", ref[0], ref[1], exc)
    return results


def _get_cached_pool_members(client, poolid: str, force_refresh: bool = False) -> Set[int]:
    cache_key = str(poolid or '').strip()
    now = datetime.now()
    if not cache_key:
        return set()

    if not force_refresh and cache_key in _POOL_CACHE:
        cached_time, cached_members = _POOL_CACHE[cache_key]
        if now - cached_time < timedelta(seconds=_CACHE_TTL_SECONDS):
            return set(cached_members or set())

    members = client.list_pool_members(cache_key) or []
    member_vmids: Set[int] = set()
    for member in members:
        vmid = _extract_pool_member_vmid(member)
        if vmid is not None:
            member_vmids.add(vmid)
    _POOL_CACHE[cache_key] = (now, set(member_vmids))
    return member_vmids


def _extract_pool_member_vmid(member: Any) -> Optional[int]:
    try:
        entry = member if isinstance(member, dict) else {}
    except Exception:
        entry = {}

    type_hint = str(entry.get('type') or '').strip().lower()
    if type_hint in {'storage', 'sdn', 'group', 'user'}:
        return None

    for key in ('vmid', 'id'):
        raw = entry.get(key)
        if raw is None:
            continue
        if key == 'vmid':
            try:
                return int(raw)
            except Exception:
                pass
        text = str(raw).strip()
        if not text:
            continue
        match = re.search(r'(?:^|/)(?:qemu|vm)/(\d+)$', text, flags=re.IGNORECASE)
        if match:
            try:
                return int(match.group(1))
            except Exception:
                continue
        if not type_hint or type_hint in {'qemu', 'vm'}:
            try:
                return int(text)
            except Exception:
                continue

    if type_hint in {'qemu', 'vm'}:
        for key in ('name', 'resource'):
            text = str(entry.get(key) or '').strip()
            match = re.search(r'(?:^|/)(?:qemu|vm)/(\d+)$', text, flags=re.IGNORECASE)
            if match:
                try:
                    return int(match.group(1))
                except Exception:
                    continue
    return None


def _prefetch_pool_members_parallel(
    proj: Optional[Project],
    poolids: Iterable[str],
    *,
    force_refresh: bool,
    client_factory,
) -> Dict[str, Set[int]]:
    unique_poolids: List[str] = []
    seen: Set[str] = set()
    for raw_poolid in poolids or []:
        try:
            poolid = str(raw_poolid or '').strip()
        except Exception:
            poolid = ''
        if not poolid or poolid in seen:
            continue
        seen.add(poolid)
        unique_poolids.append(poolid)

    if not unique_poolids:
        return {}

    results: Dict[str, Set[int]] = {}

    def _fetch_one(poolid: str):
        thread_client = client_factory()
        return poolid, _get_cached_pool_members(thread_client, poolid, force_refresh=force_refresh)

    workers = _pool_workers_for(proj, len(unique_poolids), hard_cap=8)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(_fetch_one, poolid): poolid for poolid in unique_poolids}
        for fut in as_completed(future_map):
            poolid = future_map[fut]
            try:
                fetched_poolid, members = fut.result()
                results[fetched_poolid] = set(members or set())
            except Exception as exc:
                LOG.warning("Could not fetch pool members for %s: %s", poolid, exc)
                results[poolid] = set()
    return results


def _has_user_access_role(roles_set: Any) -> bool:
    try:
        return ('PVEUser' in roles_set) or ('PVEVMUser' in roles_set)
    except Exception:
        return False


def _ensure_proxmox_role(client: ProxmoxClient, roleid: str, privileges: List[str]) -> None:
    try:
        if not client.get_role(roleid):
            client.create_role(roleid, privileges)
    except Exception:
        pass


def _grant_user_access_vm_role(client: ProxmoxClient, userid: str, vmid: int) -> str:
    try:
        client.set_acl_user_vm(userid, vmid, roles='PVEUser', propagate=True)
        return 'PVEUser'
    except Exception as exc:
        msg = str(exc).lower()
        if 'role' in msg and ('not found' in msg or 'no such' in msg or 'does not exist' in msg):
            client.set_acl_user_vm(userid, vmid, roles='PVEVMUser', propagate=True)
            return 'PVEVMUser'
        raise


def _delete_vm_acl_role(client: ProxmoxClient, userid: str, vmid: int, role: str) -> bool:
    try:
        client.delete_acl_user_vm(userid, vmid, roles=role, propagate=True)
        return True
    except Exception:
        return False


def _reconcile_vm_access_roles(
    client: ProxmoxClient,
    userid: str,
    vmid: int,
    *,
    accessible: bool,
    rollback_enabled: bool,
    current_roles: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    removed: List[str] = []
    granted: Optional[str] = None
    current = set(current_roles or set())

    if accessible:
        if 'AcostaRollback' in current or current_roles is None:
            if _delete_vm_acl_role(client, userid, vmid, 'AcostaRollback'):
                removed.append('AcostaRollback')
                current.discard('AcostaRollback')
        if not _has_user_access_role(current):
            granted = _grant_user_access_vm_role(client, userid, vmid)
            current.add(granted)
    else:
        for role in ('PVEUser', 'PVEVMUser'):
            if role in current or current_roles is None:
                if _delete_vm_acl_role(client, userid, vmid, role):
                    removed.append(role)
                    current.discard(role)
        if rollback_enabled:
            _ensure_proxmox_role(client, 'AcostaRollback', ['VM.Snapshot.Rollback', 'VM.Audit', 'VM.PowerMgmt'])
            if 'AcostaRollback' not in current:
                client.set_acl_user_vm(userid, vmid, roles='AcostaRollback', propagate=True)
                granted = 'AcostaRollback'
                current.add('AcostaRollback')
        else:
            if 'AcostaRollback' in current or current_roles is None:
                if _delete_vm_acl_role(client, userid, vmid, 'AcostaRollback'):
                    removed.append('AcostaRollback')
                    current.discard('AcostaRollback')

    return {
        'granted': granted,
        'removed': removed,
        'current_roles': current,
    }


def _iter_json_dicts_from_text(text: Any) -> Iterable[Dict[str, Any]]:
    try:
        source = str(text or '')
    except Exception:
        source = ''
    if not source:
        return []

    decoder = json.JSONDecoder()
    found: List[Dict[str, Any]] = []
    cursor = 0
    length = len(source)
    while cursor < length:
        start = source.find('{', cursor)
        if start < 0:
            break
        try:
            parsed, offset = decoder.raw_decode(source[start:])
        except Exception:
            cursor = start + 1
            continue
        if isinstance(parsed, dict):
            found.append(parsed)
        cursor = start + max(int(offset), 1)
    return found


def _vm_description_matches_project(proj: Optional[Project], description: Any) -> bool:
    project_id = str(getattr(proj, 'id', '') or '').strip()
    project_name = str(getattr(proj, 'name', '') or '').strip()
    for meta in _iter_json_dicts_from_text(description):
        try:
            meta_project_id = str(meta.get('project_id') or '').strip()
        except Exception:
            meta_project_id = ''
        if project_id and meta_project_id == project_id:
            return True
        try:
            scenario_name = str(meta.get('Scenario') or meta.get('scenario') or '').strip()
        except Exception:
            scenario_name = ''
        if project_name and scenario_name == project_name:
            return True
    return False


def _vm_is_in_project_notes(client: ProxmoxClient, proj: Optional[Project], node: Any, vmid: Any) -> bool:
    try:
        node_name = str(node or '').strip()
        vmid_int = int(vmid)
    except Exception:
        return False
    if not node_name:
        return False
    try:
        cfg = client.get_qemu_config(node_name, vmid_int) or {}
    except Exception:
        return False
    return _vm_description_matches_project(proj, cfg.get('description'))

def _clear_vm_cache(project_id=None):
    """Clear cached VM data (call after create/delete/clone operations)"""
    global _VM_CONFIG_CACHE, _POOL_CACHE
    if project_id:
        # Could implement project-specific clearing if needed
        pass
    else:
        _VM_CONFIG_CACHE.clear()
        _POOL_CACHE.clear()

# Simple in-process job tracking so long-running actions can show progress/cancellation
_JOB_LOCK = threading.Lock()
_ACTIVE_JOBS: Dict[str, Dict[str, Any]] = {}


def _job_key(pid: str) -> str:
    return f"project:{pid}"


def _start_job(pid: str, name: str, total_steps: Optional[int] = None):
    rec = {
        'project': pid,
        'name': name,
        'action': name,
        'status': 'running',
        'started': time.time(),
        'progress': 0,
        'total_steps': total_steps,
        'detail': {},
        'cancel': False,
    }
    with _JOB_LOCK:
        _ACTIVE_JOBS[_job_key(pid)] = rec


def _update_job_detail(pid: str, **fields):
    if not fields:
        return
    with _JOB_LOCK:
        rec = _ACTIVE_JOBS.get(_job_key(pid))
        if not rec:
            return
        rec.update(fields)


def _end_job(pid: str, status: str = 'completed'):
    with _JOB_LOCK:
        rec = _ACTIVE_JOBS.get(_job_key(pid))
        if rec:
            rec['status'] = status
            rec['ended'] = time.time()


def _cancel_job(pid: str):
    with _JOB_LOCK:
        rec = _ACTIVE_JOBS.get(_job_key(pid))
        if rec:
            rec['cancel'] = True
            rec['status'] = 'cancelled'


def _is_cancelled(pid: str) -> bool:
    with _JOB_LOCK:
        rec = _ACTIVE_JOBS.get(_job_key(pid))
        return bool(rec and rec.get('cancel'))


def _format_vm_label(entry: Any) -> str:
    try:
        name = str((entry or {}).get('name', '')).strip()
    except Exception:
        name = ''
    idx = None
    try:
        idx_value = (entry or {}).get('index')
        if idx_value is not None and idx_value != '':
            idx = int(idx_value)
    except Exception:
        idx = None
    if name and idx is not None:
        return f"{name} (instance {idx})"
    if name:
        return name
    if idx is not None:
        return f"Instance {idx}"
    return 'VM'


def _shorten_command_text(command_text: Any, limit: int = 96) -> str:
    try:
        text = str(command_text or '')
    except Exception:
        text = ''
    text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
    if '\n' in text:
        text = text.split('\n', 1)[0]
    if len(text) > limit:
        return text[: limit - 1] + '…'
    return text


def _format_delay_label(delay_seconds: Any) -> Optional[str]:
    try:
        num = float(delay_seconds)
    except (TypeError, ValueError):
        return None
    if num <= 0:
        return '0s'
    if num >= 10:
        return f"{int(round(num))}s"
    if num >= 1:
        return f"{num:.1f}s"
    return f"{num:.3f}s"


def _job_emit_delay_status(pid: str, entry: Any, step: int, delay_seconds: Any):
    label = _format_vm_label(entry)
    delay_label = _format_delay_label(delay_seconds)
    message = (
        f"Waiting {delay_label} before step {step} on {label}"
        if delay_label
        else f"Waiting before step {step} on {label}"
    )
    detail = {
        'kind': 'delay',
        'vm': label,
        'step': step,
        'delay_seconds': delay_seconds,
        'delay_label': delay_label,
    }
    _update_job_detail(pid, phase='delay', current=label, step=step, message=message, detail=detail)


def _job_emit_command_status(
    pid: str,
    entry: Any,
    step: Optional[int],
    command_idx: Optional[int],
    command_text: Any,
    *,
    command_number: Optional[int] = None,
    command_total: Optional[int] = None,
    step_command_total: Optional[int] = None,
    phase: str = 'command',
):
    label = _format_vm_label(entry)
    short_cmd = _shorten_command_text(command_text)
    seq_label = ''
    if command_number is not None:
        seq_label = f"command {command_number}"
        if command_total:
            seq_label += f"/{command_total}"
    elif step is not None:
        seq_label = 'command'
    idx_part = ''
    if step is not None and command_idx:
        idx_part = f" #{command_idx}"
    step_part = f" (step {step}{idx_part})" if step is not None else ''
    if seq_label:
        seq_part = f" {seq_label}"
    else:
        seq_part = ' command'
    if short_cmd:
        message = f"Running{seq_part}{step_part} on {label}: {short_cmd}"
    else:
        message = f"Running{seq_part}{step_part} on {label}"
    detail = {
        'kind': phase,
        'vm': label,
        'step': step,
        'command_index': command_idx,
        'command': short_cmd,
        'command_number': command_number,
        'command_total': command_total,
        'step_command_total': step_command_total,
    }
    _update_job_detail(pid, phase=phase, current=label, step=step, message=message, detail=detail)


def _job_emit_batch_progress(
    pid: str,
    phase: str,
    verb: str,
    completed: Any,
    total: Any,
    *,
    entry: Any = None,
    current: Optional[str] = None,
    progress_start: int = 10,
    progress_end: int = 95,
    message: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
):
    try:
        total_i = max(int(total or 0), 0)
    except Exception:
        total_i = 0
    try:
        done_i = max(int(completed or 0), 0)
    except Exception:
        done_i = 0
    if total_i > 0:
        done_i = min(done_i, total_i)

    label = str(current or _format_vm_label(entry) or '').strip()
    if total_i > 0:
        fraction = done_i / max(total_i, 1)
        progress = int(round(progress_start + fraction * max(progress_end - progress_start, 0)))
    else:
        progress = progress_end if done_i > 0 else progress_start

    detail_payload: Dict[str, Any] = {
        'kind': 'batch',
        'vm': label,
        'completed': done_i,
        'total': total_i,
        'verb': verb,
    }
    if isinstance(detail, dict):
        detail_payload.update(detail)

    if not message:
        if label and total_i > 0:
            message = f'{verb} {label}… {done_i}/{total_i} complete'
        elif total_i > 0:
            message = f'{verb}… {done_i}/{total_i} complete'
        elif label:
            message = f'{verb} {label}…'
        else:
            message = verb

    _update_job_detail(
        pid,
        phase=phase,
        current=label,
        step=done_i,
        total_steps=total_i,
        progress=progress,
        message=message,
        detail=detail_payload,
    )

# --- Simple in-process job tracking helpers (re-added after cleanup) ---
# Several endpoints call _start_job/_end_job and allow cancellation via a shared
def _secure_route(required_roles=None, api_key=True):
    from functools import wraps
    required_roles = {str(r).lower() for r in (required_roles or [])}

    def _auth_error_response(payload, status_code, *, auth_failure=False):
        response = jsonify(payload)
        response.status_code = status_code
        if auth_failure:
            response.headers['X-DeployForge-Auth-Failure'] = '1'
        return response

    def deco(func):
        @wraps(func)
        def inner(*args, **kwargs):
            # Session authentication layer
            try:
                app = current_app._get_current_object()
            except Exception:
                app = None

            if app and app.config.get('AUTH_ENABLE'):
                current_user = getattr(app, 'current_user', lambda: None)() if hasattr(app, 'current_user') else None
                if not current_user:
                    return _auth_error_response({'error': 'authentication required'}, 401, auth_failure=True)
                if required_roles:
                    have_roles = {str(r).lower() for r in current_user.get('roles', [])}
                    if not (have_roles & required_roles):
                        return _auth_error_response({'error': 'forbidden'}, 403, auth_failure=True)

            # API key enforcement layer (if enabled)
            if api_key:
                try:
                    key = current_app.config.get('API_KEY')
                except Exception:
                    key = None
                if key:
                    supplied = request.headers.get('X-API-Key') or request.args.get('api_key')
                    if supplied != key:
                        return _auth_error_response({'error': 'invalid or missing API key'}, 401)

            return func(*args, **kwargs)

        return inner
    return deco


@api_bp.route("/debug/storage", methods=["GET"])
@_secure_route(required_roles=['admin'])
def debug_storage():
    """Debug helper: report resolved storage paths.

    Useful to verify docker-compose volume persistence (DATA_DIR=/data).
    """
    import tempfile

    try:
        data_dir = str(current_app.config.get('DATA_DIR') or '')
    except Exception:
        data_dir = ''
    try:
        env_data_dir = os.environ.get('DATA_DIR')
    except Exception:
        env_data_dir = None

    try:
        projects_json = os.path.join(data_dir, 'projects.json') if data_dir else ''
    except Exception:
        projects_json = ''

    meta: Dict[str, Any] = {
        'env_DATA_DIR': env_data_dir,
        'DATA_DIR': data_dir,
        'projects_json': projects_json,
        'docker_compose_expected_DATA_DIR': '/data',
    }

    try:
        meta['cwd'] = os.getcwd()
    except Exception:
        meta['cwd'] = None

    try:
        meta['temp_dir'] = tempfile.gettempdir()
    except Exception:
        meta['temp_dir'] = None

    try:
        meta['DATA_DIR_is_temp'] = bool(meta.get('temp_dir')) and bool(data_dir) and os.path.abspath(data_dir).startswith(os.path.abspath(str(meta.get('temp_dir'))))
    except Exception:
        meta['DATA_DIR_is_temp'] = None

    try:
        meta['docker_compose_volume_ok'] = bool(data_dir) and os.path.abspath(data_dir) == os.path.abspath('/data')
    except Exception:
        meta['docker_compose_volume_ok'] = None

    try:
        st = os.stat(projects_json) if projects_json else None
    except Exception:
        st = None
    if st:
        try:
            meta['projects_json_exists'] = True
            meta['projects_json_size_bytes'] = int(st.st_size)
            meta['projects_json_mtime_utc'] = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
        except Exception:
            pass
    else:
        try:
            meta['projects_json_exists'] = bool(projects_json and os.path.exists(projects_json))
        except Exception:
            meta['projects_json_exists'] = None

    return jsonify(meta)


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
    force_refresh = False
    try:
        force_refresh = bool(data.get('forceRefresh'))
    except Exception:
        force_refresh = False
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
    _start_job(pid, 'refresh_vm')
    _update_job_detail(pid, phase='inventory', progress=5, message='Connecting to Proxmox…')
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
            try:
                raw_validation_commands = sanitize_validation_commands(getattr(vm, 'validation_commands', []))
                validation_configured = any((entry or {}).get('enabled', True) is not False for entry in raw_validation_commands)
            except Exception:
                validation_configured = False
            if spec_name or spec_vmid is not None:
                exp.append({ 'name': spec_name, 'vmid': spec_vmid, 'viewable': bool(viewable), 'validation_configured': bool(validation_configured) })
        expected[i] = exp
    client = ProxmoxClient(base_url=base_url, token=token or None, username=username, password=password, verify=verify)
    try:
        t_start = time.time()
        nodes = client.list_nodes()
        total_nodes = max(len(nodes), 1)
        _update_job_detail(pid, phase='inventory', step=0, total_steps=total_nodes, progress=10, message=f'Scanning Proxmox nodes… 0/{total_nodes} complete')
        
        # Build maps of name -> details, vmid -> name, and lowercase-name -> canonical name
        name_map = {}
        id_map = {}
        lower_name_to_canon = {}
        running_vm_refs: Set[Tuple[str, int]] = set()
        agent_hint_by_ref: Dict[Tuple[str, int], Any] = {}
        vm_ref_types: Dict[Tuple[str, int], str] = {}
        
        # PERFORMANCE OPTIMIZATION: Fetch VMs and LXCs from all nodes in parallel
        def _fetch_node_vms(node_info):
            """Helper to fetch VMs and LXCs from a single node (for parallel execution)"""
            node = node_info.get('node') or node_info.get('id') or ''
            if not node:
                return (node, [], [], None)
            qemus = []
            lxcs = []
            err = None
            try:
                # Create a new client instance for thread safety (sessions aren't thread-safe)
                thread_client = ProxmoxClient(base_url=base_url, token=token or None, username=username, password=password, verify=verify)
                try:
                    qemus = thread_client.list_qemu_vms(node) or []
                except Exception as e:
                    err = e
                try:
                    if hasattr(thread_client, 'list_lxc_vms'):
                        lxcs = thread_client.list_lxc_vms(node) or []
                except Exception as e:
                    if err is None:
                        err = e
                return (node, qemus, lxcs, err)
            except Exception as e:
                return (node, [], [], e)
        
        # Execute node fetching in parallel (typically 2-4 nodes, but can be more)
        processed_nodes = 0
        with ThreadPoolExecutor(max_workers=min(len(nodes), 8)) as executor:
            futures = [executor.submit(_fetch_node_vms, n) for n in nodes]
            
            for future in as_completed(futures):
                node, qemus, lxcs, error = future.result()
                processed_nodes += 1
                try:
                    _update_job_detail(
                        pid,
                        phase='inventory',
                        current=str(node or ''),
                        step=processed_nodes,
                        total_steps=total_nodes,
                        progress=int(round(10 + (processed_nodes / max(total_nodes, 1)) * 45)),
                        message=f'Scanned node {node or "(unknown)"}; {processed_nodes}/{total_nodes} complete',
                        detail={ 'kind': 'batch', 'vm': str(node or ''), 'completed': processed_nodes, 'total': total_nodes, 'verb': 'Scanning' },
                    )
                except Exception:
                    pass
                if error and not qemus and not lxcs:
                    logging.warning(f"Could not list VMs or LXCs on node {node}: {error}")
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
                        'state': q.get('qmpstatus') or q.get('status') or '',
                        'power_state': q.get('status') or '',
                        'qmp_state': q.get('qmpstatus') or '',
                        'agent_hint': q.get('agent'),
                        'type': 'qemu',
                    }
                    lower_name_to_canon[canon.lower()] = canon
                    try:
                        if vmid_val is not None:
                            vm_ref_types[(str(node), int(vmid_val))] = 'qemu'
                            agent_hint_by_ref[(str(node), int(vmid_val))] = q.get('agent')
                            power_state = str(q.get('status') or '').strip().lower()
                            qmp_state = str(q.get('qmpstatus') or '').strip().lower()
                            if power_state == 'running' or qmp_state == 'running':
                                running_vm_refs.add((str(node), int(vmid_val)))
                    except Exception:
                        pass

                for l in lxcs:
                    name = (l.get('name') or l.get('hostname') or l.get('vmid'))
                    if not name:
                        continue
                    vmid_val = int(l.get('vmid')) if l.get('vmid') is not None else None
                    if vmid_val is not None:
                        id_map[vmid_val] = str(l.get('name') or l.get('hostname') or vmid_val)
                    canon = str(name)
                    name_map[canon] = {
                        'node': node,
                        'vmid': vmid_val,
                        'state': l.get('status') or '',
                        'power_state': l.get('status') or '',
                        'qmp_state': '',
                        'agent_hint': None,
                        'type': 'lxc',
                    }
                    lower_name_to_canon[canon.lower()] = canon
                    try:
                        if vmid_val is not None:
                            vm_ref_types[(str(node), int(vmid_val))] = 'lxc'
                            power_state = str(l.get('status') or '').strip().lower()
                            if power_state == 'running':
                                running_vm_refs.add((str(node), int(vmid_val)))
                    except Exception:
                        pass
        
        t_fetch = time.time()
        logging.info(f"VM/LXC refresh: node fetching took {(t_fetch-t_start)*1000:.0f}ms for {len(nodes)} nodes")
    except Exception as e:
        _update_job_detail(pid, phase='error', progress=100, message=f'VM/LXC refresh failed: {e}')
        _end_job(pid, status='error')
        return jsonify({"error": f"Proxmox: {e}"}), 502

    # Pools list (single call) to avoid per-instance pool existence checks.
    pool_ids = None
    try:
        _update_job_detail(pid, phase='access', progress=60, message='Checking pools and access controls…')
        pool_ids = { str((p or {}).get('poolid') or '') for p in (client.list_pools() or []) }
        pool_ids = { p for p in pool_ids if p }
    except Exception:
        pool_ids = None

    def _norm_userid(uname: str) -> str:
        u = str(uname or '').strip()
        if not u:
            return ''
        return u if '@' in u else f"{u}@pve"

    def _poolid_from_uname(uname: str) -> str:
        base = str(uname or '').strip().split('@', 1)[0]
        return re.sub(r"[^A-Za-z0-9_-]+", "", base)

    matched_vm_refs: List[Tuple[str, int]] = []
    for instance_specs in expected.values():
        for spec in instance_specs:
            spec_name = spec.get('name')
            matched = name_map.get(spec_name)
            if not matched and spec_name:
                lc = lower_name_to_canon.get(str(spec_name).lower())
                if lc:
                    matched = name_map.get(lc)
            if not matched:
                continue
            node = matched.get('node')
            vmid = matched.get('vmid')
            if node and vmid is not None:
                try:
                    matched_vm_refs.append((str(node), int(vmid)))
                except Exception:
                    continue

    prefetched_vm_configs = _prefetch_vm_configs_parallel(
        proj,
        matched_vm_refs,
        force_refresh=force_refresh,
        client_factory=lambda: ProxmoxClient(
            base_url=base_url,
            token=token or None,
            username=username,
            password=password,
            verify=verify,
        ),
        vm_types=vm_ref_types,
    )

    runtime_store = _runtime_store()

    candidate_poolids: List[str] = []
    for i in range(1, instances + 1):
        try:
            creds = list(getattr(proj, 'credentials', []) or [])
            urec = creds[i - 1] if i - 1 < len(creds) else None
            uname = (urec or {}).get('username') or ''
            poolid = _poolid_from_uname(uname)
            if poolid and (pool_ids is None or poolid in pool_ids):
                candidate_poolids.append(poolid)
        except Exception:
            continue

    pool_members_cache = _prefetch_pool_members_parallel(
        proj,
        candidate_poolids,
        force_refresh=force_refresh,
        client_factory=lambda: ProxmoxClient(
            base_url=base_url,
            token=token or None,
            username=username,
            password=password,
            verify=verify,
        ),
    )

    def _norm_acl_path(path: str) -> str:
        p = str(path or '').strip()
        if not p:
            return ''
        if not p.startswith('/'):
            p = f"/{p}"
        # Trim trailing slash except for root
        if len(p) > 1:
            p = p.rstrip('/')
        return p

    # Fetch ACLs once so we can report effective per-instance user access.
    # Effective access can be inherited via propagate from ancestor paths (e.g., /vms).
    acl_index = None
    try:
        entries = client.list_acls() or []
        acl_index = {}
        for e in entries:
            try:
                ugid = str(e.get('ugid') or '').strip().lower()
                path = _norm_acl_path(e.get('path') or '')
                roleid = str(e.get('roleid') or '').strip()
                if not ugid or not path or not roleid:
                    continue
                propagate_raw = e.get('propagate')
                propagate = bool(propagate_raw in (1, True, '1', 'true', 'True'))
                acl_index.setdefault((ugid, path), []).append((roleid, propagate))
            except Exception:
                continue
    except Exception:
        acl_index = None

    def _has_access_role_id(roleid: str) -> bool:
        try:
            return roleid in ('PVEUser', 'PVEVMUser')
        except Exception:
            return False

    def _path_grants_access(ugid: str, path: str, require_propagate: bool) -> bool:
        if acl_index is None:
            return False
        try:
            key = (str(ugid or '').strip().lower(), _norm_acl_path(path))
            entries = acl_index.get(key, [])
            for roleid, propagate in entries:
                if not _has_access_role_id(str(roleid)):
                    continue
                if require_propagate and not propagate:
                    continue
                return True
        except Exception:
            return False
        return False

    def _effective_user_access(ugid: str, vmid: int, poolid: str | None) -> bool | None:
        # If we couldn't fetch ACLs, leave as unknown (None).
        if acl_index is None:
            return None
        try:
            ug = str(ugid or '').strip().lower()
            # Pool-level grant can also confer access.
            if poolid:
                if _path_grants_access(ug, f"/pool/{poolid}", require_propagate=False):
                    return True
            # Direct VM path
            if _path_grants_access(ug, f"/vms/{int(vmid)}", require_propagate=False):
                return True
            # Inherited via propagate from /vms or /
            if _path_grants_access(ug, "/vms", require_propagate=True):
                return True
            if _path_grants_access(ug, "/", require_propagate=True):
                return True
        except Exception:
            return None
        return False

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
        try:
            pct = int(round(70 + (i / max(instances or 1, 1)) * 25)) if instances > 0 else 95
            _update_job_detail(pid, phase='summarizing', current=f'Instance {i}', step=i, total_steps=max(instances, 1), progress=min(pct, 95), message=f'Compiling instance {i}/{max(instances, 1)}…')
        except Exception:
            pass
        entry = current.get(i) or { 'index': i, 'created': False, 'managers': {} }
        mgrs = entry.get('managers') or {}
        names = expected[i]
        # Pre-compute per-instance userid/poolid for access reporting
        userid = None
        poolid = None
        try:
            creds = list(getattr(proj, 'credentials', []) or [])
            urec = creds[i-1] if i-1 < len(creds) else None
            uname = (urec or {}).get('username') or ''
            if uname:
                userid = _norm_userid(uname)
                poolid = _poolid_from_uname(uname)
        except Exception:
            userid = None
            poolid = None
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
                agent_hint_raw = matched.get('agent_hint')
                nets = []
                tmpl_id = None
                tmpl_name = ''
                cfg = {}
                pool_val = ''
                try:
                    if node and vmid is not None:
                        cfg = prefetched_vm_configs.get((str(node), int(vmid))) or {}
                        nets = _extract_nets(cfg)
                        pool_val = str(cfg.get('pool') or '').strip() if isinstance(cfg, dict) else ''
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
                    pool_val = ''
                found_details.append({
                    'name': canon_name,
                    'vmid': vmid,
                    'type': matched.get('type') or 'qemu',
                    'state': matched.get('state') or '',
                    'power_state': matched.get('power_state') or matched.get('state') or '',
                    'qmp_state': matched.get('qmp_state') or '',
                    'nets': nets,
                    'node': node,
                    'template_id': tmpl_id,
                    'template_name': tmpl_name,
                    'validation_commands_configured': bool(spec.get('validation_configured')),
                    'qemu_agent_enabled': _qemu_agent_enabled_from_cfg_or_hint(cfg if isinstance(cfg, dict) else {}, agent_hint_raw) if matched.get('type') == 'qemu' else False,
                    'qemu_agent_validated': False,
                    'qemu_agent_validation_state': 'unknown',
                    'lock': str(cfg.get('lock') or '').strip() if isinstance(cfg, dict) else '',
                    'description': str(cfg.get('description') or '').strip() if isinstance(cfg, dict) else '',
                    'pool': pool_val,
                    # Effective access for the instance user (credential username)
                    'user_access': _effective_user_access(userid, int(vmid), poolid) if (userid and vmid is not None) else None,
                })
                if node and vmid is not None:
                    validation_result = None
                    try:
                        getter = getattr(runtime_store, 'get_vm_validation_result', None)
                        if callable(getter):
                            validation_result = getter(proj.id, canon_name, vmid=vmid, node=node)
                        else:
                            legacy_validated = runtime_store.get_vm_validation_state(proj.id, canon_name, vmid=vmid, node=node)
                            if legacy_validated:
                                validation_result = True
                    except Exception:
                        validation_result = None
                    if validation_result is True:
                        found_details[-1]['qemu_agent_validated'] = True
                        found_details[-1]['qemu_agent_validation_state'] = 'passed'
                    elif validation_result is False:
                        found_details[-1]['qemu_agent_validated'] = False
                        found_details[-1]['qemu_agent_validation_state'] = 'failed'
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
            # Reuse computed poolid above where possible
            if poolid is None:
                creds = list(getattr(proj, 'credentials', []) or [])
                urec = creds[i-1] if i-1 < len(creds) else None
                uname = (urec or {}).get('username') or ''
                poolid = _poolid_from_uname(uname)
            if poolid:
                try:
                    if pool_ids is not None:
                        pool_exists = poolid in pool_ids
                    else:
                        pool_exists = bool(client.get_pool(poolid) is not None)
                    mgrs['pools'] = 'ready' if pool_exists else 'missing'
                    # Compute membership details when pool exists
                    if pool_exists:
                        pool_vmids = pool_members_cache.get(poolid, set())
                        
                        # All configured VMs for this instance count toward expected pool membership
                        names_viewable = list(names)
                        total_expected = len(names_viewable)
                        # Count expected VMs by resolved details instead of exact generated-name equality.
                        # Proxmox may return canonical names with different casing than the configured expectation.
                        expected_found_vmids: Set[int] = set()
                        for fd in found_details:
                            try:
                                if fd.get('vmid') is not None:
                                    expected_found_vmids.add(int(fd.get('vmid')))
                            except Exception:
                                continue
                        in_count = sum(1 for vm_vmid in expected_found_vmids if vm_vmid in pool_vmids)
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
    _update_job_detail(pid, phase='done', step=max(instances, 1), total_steps=max(instances, 1), progress=100, message=f'Refresh completed: {len(out)} instance status entr{"y" if len(out) == 1 else "ies"}')
    _end_job(pid)
    
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

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            normalized = value.strip().lower()
            if not normalized:
                return default
            if normalized in {'false', '0', 'no', 'off', 'disabled'}:
                return False
            if normalized in {'true', '1', 'yes', 'on', 'enabled'}:
                return True
        return bool(value)

    apply_scenario = _coerce_bool_flag(body.get('applyScenario') if 'applyScenario' in body else None, True)
    sync_user_access = _coerce_bool_flag(body.get('syncUserAccess') if 'syncUserAccess' in body else None, True)
    set_network_interfaces = _coerce_bool_flag(body.get('setNetworkInterfaces') if 'setNetworkInterfaces' in body else None, True)
    take_snapshot = _coerce_bool_flag(body.get('takeSnapshot') if 'takeSnapshot' in body else None, True)
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    normalized_targets = []
    total_targets = len(targets)
    for pos, target in enumerate(targets, start=1):
        if isinstance(target, dict):
            item = dict(target)
        else:
            item = { 'name': str(target or '') }
        item['_ordinal'] = pos
        item['_total'] = total_targets
        normalized_targets.append(item)
    targets = normalized_targets
    global_linked = bool(getattr(proj, 'proxmox_use_linked_clones', True))

    def _target_progress_meta(item: Any, name: Any = None) -> Tuple[str, Optional[int], int, str]:
        try:
            current_name = str(name if name is not None else ((item or {}).get('name') or '')).strip()
        except Exception:
            current_name = ''
        ordinal = None
        try:
            raw_ordinal = (item or {}).get('_ordinal')
            if raw_ordinal is not None and raw_ordinal != '':
                ordinal = int(raw_ordinal)
        except Exception:
            ordinal = None
        total = total_targets
        if ordinal is not None and total > 0 and current_name:
            label = f"{current_name} ({ordinal}/{total})"
        elif current_name:
            label = current_name
        elif ordinal is not None and total > 0:
            label = f"VM ({ordinal}/{total})"
        else:
            label = 'VM'
        return current_name or 'VM', ordinal, total, label

    def _clone_progress(ordinal: Optional[int], fraction: float = 0.0) -> int:
        if total_targets <= 0:
            return 0
        if ordinal is None:
            ordinal = 1
        base = max(0.0, (float(ordinal) - 1.0) + max(0.0, fraction))
        return int(min(60, max(0, (base / max(total_targets, 1)) * 60)))

    def _network_progress(ordinal: Optional[int], fraction: float = 0.0) -> int:
        if total_targets <= 0:
            return 60
        if ordinal is None:
            ordinal = 1
        base = max(0.0, (float(ordinal) - 1.0) + max(0.0, fraction))
        return int(min(90, max(60, 60 + (base / max(total_targets, 1)) * 30)))

    def _snapshot_progress(ordinal: Optional[int], total_snapshots: int, completed: int = 0) -> int:
        if total_snapshots <= 0:
            return 90
        if ordinal is None:
            ordinal = completed + 1
        base = max(float(completed), float(ordinal) - 1.0)
        return int(min(99, max(90, 90 + (base / max(total_snapshots, 1)) * 9)))

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
                    'template': q.get('template'),
                    'type': 'qemu'
                })
        except Exception:
            pass
        try:
            for c in client.list_lxc_vms(node):
                cluster.append({
                    'node': node,
                    'name': str(c.get('name') or c.get('hostname') or ''),
                    'vmid': int(c.get('vmid')) if c.get('vmid') is not None else None,
                    'template': c.get('template'),
                    'type': 'lxc'
                })
        except Exception:
            pass
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
    snapshotted = []
    # Track bridges created in this batch to avoid re-warn when we reencounter them
    created_bridges = set()  # set of (node, iface)
    notices = []
    if not set_network_interfaces:
        notices.append({ 'reason': 'Post-clone network interface assignment skipped by request.' })
    if not take_snapshot:
        notices.append({ 'reason': 'Post-clone snapshot skipped by request.' })
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
        current_name, ordinal, total, progress_label = _target_progress_meta(t, newname)
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
        is_lxc = getattr(cfg, 'vm_type', 'qemu') == 'lxc' or (src and src.get('type') == 'lxc')
        snapshots_present = False
        linked_like_disk = False
        if use_linked:
            if is_lxc:
                try:
                    snaps = client.list_lxc_snapshots(node=node, vmid=src_vmid) or []
                    snapshots_present = len(snaps) > 0
                except Exception:
                    snapshots_present = False
                try:
                    cfg_src_full = client.get_lxc_config(node=node, vmid=src_vmid) or {}
                    for k,v in (cfg_src_full or {}).items():
                        ks = str(k)
                        if ks.startswith(('rootfs', 'mp')):
                            val = str(v)
                            if 'base-' in val or 'subvol-' in val:
                                linked_like_disk = True
                                break
                except Exception:
                    pass
            else:
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
            # Allow Proxmox to make the final decision, but never downgrade to a full clone silently.
            try:
                debug_msgs.append(f"linked-clone heuristic: source lacks template indicators (vmid={src_vmid}); will attempt linked only and return an error if Proxmox rejects it")
            except Exception:
                pass
        storage_vol = getattr(cfg, 'storage_volume', None) or getattr(proj, 'proxmox_storage_volume', None)
        timeout_sec = int(getattr(cfg, 'clone_timeout_sec', None) or getattr(proj, 'proxmox_clone_timeout_seconds', 1800))
        def do_clone_with_id(chosen_id: int, full_clone: bool):
            if is_lxc:
                return client.clone_lxc(node=node, vmid=src_vmid, newid=chosen_id, name=newname, storage=(None if not full_clone else (storage_vol or None)), full=(1 if full_clone else 0) or bool(full_clone))
            return client.clone_qemu(node=node, vmid=src_vmid, newid=chosen_id, name=newname, storage=(None if not full_clone else (storage_vol or None)), full=(1 if full_clone else 0) or bool(full_clone))
        attempts = []
        vmid_attempts = attempts
        newid = None
        fallback_full_used = False
        try:
            _update_job_detail(
                pid,
                phase='cloning',
                current=current_name,
                step=max((ordinal or 1) - 1, 0),
                total_steps=total_targets,
                progress=_clone_progress(ordinal),
                message=f'Creating VM {progress_label}: cloning template…',
            )
        except Exception:
            pass
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
                    # Linked clone was explicitly requested; do not silently retry as a full clone.
                    try:
                        debug_msgs.append(f"linked clone attempt failed for {newname} vmid_candidate={candidate}: {e1}")
                    except Exception:
                        pass
                    msg = str(e1).lower()
                    if ('already exist' in msg) or ('config' in msg and 'exists' in msg) or ('conflict' in msg):
                        continue
                    return ('error', None, {
                        'index': idx,
                        'name': newname,
                        'reason': f'linked clone failed: {e1}. Full clone fallback is disabled when linked clone is selected.',
                        'vmid_attempts': attempts,
                    })
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
        adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or []) if set_network_interfaces else []
        expected_bridges_for_vm = []
        for i, a in enumerate(adaptors):
            bname = _bridge_iface_name(idx, a)
            expected_bridges_for_vm.append(bname)
        try:
            _update_job_detail(
                pid,
                phase='cloning',
                current=current_name,
                step=max((ordinal or 1) - 1, 0),
                total_steps=total_targets,
                progress=_clone_progress(ordinal, 0.7),
                message=f'Finalizing VM {progress_label}: post-clone settings…',
            )
        except Exception:
            pass
        post_errors = []  # will accumulate only pool/acl errors now
        # Optional post-clone snapshot (deferred to post-networking phase)
        try:
            skip_snap = getattr(cfg, 'skip_post_clone_snapshot', None)
            if skip_snap is None:
                skip_snap = bool(getattr(proj, 'proxmox_skip_post_clone_snapshot', False))
        except Exception:
            skip_snap = False
        skip_snap = bool(skip_snap) or (not take_snapshot)
        
        if apply_scenario:
            try:
                cfg_user = getattr(cfg, 'vm_user', None)
                cfg_pass = getattr(cfg, 'vm_pass', None)

                notes_payload = {
                    "Scenario": proj.name
                }
                if cfg_user:
                    notes_payload["User"] = cfg_user
                if cfg_pass:
                    notes_payload["Pass"] = cfg_pass

                json_notes = json.dumps(notes_payload, indent=4)
                if is_lxc:
                    ex_cfg = client.get_lxc_config(node=node, vmid=int(newid)) or {}
                else:
                    ex_cfg = client.get_qemu_config(node=node, vmid=int(newid)) or {}
                old_desc = ex_cfg.get('description', '')

                if old_desc:
                    new_desc = f"{old_desc}\n\n{json_notes}"
                else:
                    new_desc = json_notes

                if is_lxc:
                    client.set_lxc_options(node=node, vmid=int(newid), options={'description': new_desc})
                else:
                    client.set_qemu_options(node=node, vmid=int(newid), options={'description': new_desc})
                debug_msgs.append(f"Successfully appended scenario credentials to VM Notes for vmid={newid}")
            except Exception as notes_err:
                debug_msgs.append(f"Failed to append scenario credentials to VM Notes: {notes_err}")

        assignment_info = {}
        if sync_user_access:
            try:
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
                                            if is_lxc:
                                                client.set_lxc_options(node=node, vmid=int(newid), options={ 'pool': poolid })
                                            else:
                                                client.set_qemu_options(node=node, vmid=int(newid), options={ 'pool': poolid })
                                            assignment_info['pool'] = poolid
                                            assignment_info['pool_member_added'] = True
                                            try:
                                                debug_msgs.append(f"fallback:set_options pool={poolid} vmid={int(newid)} -> success")
                                            except Exception:
                                                pass
                                        except Exception as e3:
                                            try:
                                                debug_msgs.append(f"fallback:set_options pool={poolid} vmid={int(newid)} -> failed: {e3}")
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
                                        if is_lxc:
                                            client.set_lxc_options(node=node, vmid=int(newid), options={ 'pool': poolid })
                                        else:
                                            client.set_qemu_options(node=node, vmid=int(newid), options={ 'pool': poolid })
                                        assignment_info['pool'] = poolid
                                        assignment_info['pool_member_added'] = True
                                        try:
                                            debug_msgs.append(f"fallback:set_options pool={poolid} vmid={int(newid)} -> success")
                                        except Exception:
                                            pass
                                    except Exception as e3:
                                        try:
                                            debug_msgs.append(f"fallback:set_options pool={poolid} vmid={int(newid)} -> failed: {e3}")
                                        except Exception:
                                            pass
                                        post_errors.append({ 'index': idx, 'name': newname, 'reason': f'pool members endpoint unsupported and VM-config fallback failed: {e3}' })
                                else:
                                    try:
                                        debug_msgs.append(f"add_pool_member: failed pool={poolid} vmid={int(newid)}: {e}")
                                    except Exception:
                                        pass
                                    post_errors.append({ 'index': idx, 'name': newname, 'reason': f'add pool member failed: {e}' })
                    try:
                        if uname:
                            try:
                                if current_app.config.get('ACL_DEBUG'):
                                    current_app.logger.info(f"[create][ACL] reconciling user={userid} for vmid={newid} name={newname} accessible={viewable}")
                            except Exception:
                                pass
                            user_rec = client.get_user(userid)
                            if user_rec is not None:
                                try:
                                    if current_app.config.get('ACL_DEBUG'):
                                        current_app.logger.info(f"[create][ACL] applying reconciled role user={userid} vmid={newid} accessible={viewable}")
                                except Exception:
                                    pass
                                try:
                                    acl_result = _reconcile_vm_access_roles(
                                        client,
                                        userid,
                                        int(newid),
                                        accessible=viewable,
                                        rollback_enabled=bool(getattr(proj, 'proxmox_assign_rollback_on_non_viewable', True)),
                                        current_roles=None,
                                    )
                                    assignment_info['acl_set'] = True
                                    assignment_info['acl_role'] = acl_result.get('granted')
                                    try:
                                        debug_msgs.append(
                                            f"acl_set: user={userid} vmid={int(newid)} accessible={viewable} role={acl_result.get('granted') or 'unchanged'} removed={','.join(acl_result.get('removed') or []) or 'none'}"
                                        )
                                    except Exception:
                                        pass
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
            payload = { 'index': idx, 'name': newname, 'vmid': newid, 'node': node, 'vmid_attempts': vmid_attempts, 'debug': debug_msgs, 'expected_bridges': expected_bridges_for_vm, 'fallback_full_clone': fallback_full_used, 'skip_post_clone_snapshot': bool(skip_snap), '_ordinal': ordinal, 'type': 'lxc' if is_lxc else 'qemu' }
            payload.update(assignment_info)
            return ('post', payload, post_errors)
        payload = { 'index': idx, 'name': newname, 'vmid': newid, 'node': node, 'vmid_attempts': vmid_attempts, 'debug': debug_msgs, 'expected_bridges': expected_bridges_for_vm, 'fallback_full_clone': fallback_full_used, 'skip_post_clone_snapshot': bool(skip_snap), '_ordinal': ordinal, 'type': 'lxc' if is_lxc else 'qemu' }
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
    max_jobs = int(getattr(proj, 'proxmox_max_create_jobs', 5) or 1)
    if max_jobs < 1:
        max_jobs = 1
    # Schedule clones in parallel with a cap
    to_process = list(targets)
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
                        current_name, ordinal, total, progress_label = _target_progress_meta(t)
                        _update_job_detail(
                            pid,
                            phase='cloning',
                            step=done,
                            progress=pct,
                            current=current_name,
                            message=f'Cloned {progress_label}; {done}/{len(targets)} complete',
                        )
                    except Exception:
                        pass

    # Post-clone networking phase: create missing bridges, ensure ageing lines in /etc/network/interfaces.new, assign NICs, then reload networks
    try:
        # 1) Aggregate required bridges per node
        bridges_needed = {}
        bridge_consumers = {}
        _update_job_detail(pid, phase='networking', message='Analyzing required network adaptors…')
        for r in results:
            try:
                node = r.get('node')
                if not node:
                    continue
                expected_bridges = list(r.get('expected_bridges') or [])
                for bridge_pos, b in enumerate(expected_bridges, start=1):
                    if b:
                        bridges_needed.setdefault(node, set()).add(b)
                        bridge_consumers.setdefault(node, {}).setdefault(b, []).append({
                            'name': r.get('name') or '',
                            'index': r.get('index'),
                            '_ordinal': r.get('_ordinal'),
                            'bridge_pos': bridge_pos,
                            'bridge_total': len(expected_bridges),
                        })
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
                consumer = ((bridge_consumers.get(node) or {}).get(b) or [{}])[0]
                vm_name, ordinal, total, progress_label = _target_progress_meta(consumer, consumer.get('name') or b)
                bridge_pos = int(consumer.get('bridge_pos') or 1)
                bridge_total = int(consumer.get('bridge_total') or 1)
                if b in existing:
                    try:
                        _update_job_detail(
                            pid,
                            phase='networking',
                            current=vm_name,
                            progress=_network_progress(ordinal, 0.2),
                            message=f'Adaptor ready for {progress_label}: bridge {b} {bridge_pos}/{bridge_total}',
                        )
                    except Exception:
                        pass
                    continue
                try:
                    _update_job_detail(
                        pid,
                        phase='networking',
                        current=vm_name,
                        progress=_network_progress(ordinal, 0.1),
                        message=f'Creating adaptor for {progress_label}: bridge {b} {bridge_pos}/{bridge_total}…',
                    )
                    client.create_bridge(node=node, iface=b, autostart=True, ports=None, comments=_bridge_owner_comment_for_iface(pid, consumer.get('index') or 0, b, 'post-clone'))
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
                vm_name, ordinal, total, progress_label = _target_progress_meta(r, r.get('name') or str(vmid))
                expected = list(r.get('expected_bridges') or [])
                if not expected:
                    continue
                for bridge_pos, bridge_name in enumerate(expected, start=1):
                    _update_job_detail(
                        pid,
                        phase='networking',
                        current=vm_name,
                        progress=_network_progress(ordinal, bridge_pos / max(len(expected), 1)),
                        message=f'Assigning adaptor for {progress_label}: bridge {bridge_name} {bridge_pos}/{len(expected)}…',
                    )
                vm_type = r.get('type', 'qemu')
                if vm_type == 'lxc':
                    netspecs = [f"name=eth{i},bridge={b}" for i, b in enumerate(expected)]
                    try:
                        existing_cfg = client.get_lxc_config(node=node, vmid=vmid)
                    except Exception:
                        existing_cfg = {}
                else:
                    netspecs = [f"e1000,bridge={b}" for b in expected]
                    try:
                        existing_cfg = client.get_qemu_config(node=node, vmid=vmid)
                    except Exception:
                        existing_cfg = {}
                
                new_net_keys = [f"net{i}" for i in range(len(netspecs))]
                existing_net_keys = [k for k in (existing_cfg or {}).keys() if str(k).startswith('net')]
                delete_keys = [k for k in existing_net_keys if k not in new_net_keys]
                
                if delete_keys:
                    if vm_type == 'lxc':
                        try:
                            client.set_lxc_nets(node=node, vmid=vmid, nets=[], delete_keys=delete_keys)
                        except Exception:
                            pass
                    else:
                        try:
                            client.set_qemu_nets(node=node, vmid=vmid, nets=[], delete_keys=delete_keys)
                        except Exception:
                            pass
                
                if vm_type == 'lxc':
                    client.set_lxc_nets(node=node, vmid=vmid, nets=netspecs, delete_keys=None)
                else:
                    client.set_qemu_nets(node=node, vmid=vmid, nets=netspecs, delete_keys=None)
            except Exception as e:
                errors.append({'reason': f'set nets failed post-clone: {e}'})

        # 4b) Post-clone snapshot (deferred) - execute in parallel
        snapshot_tasks = []
        for r in results:
            if r.get('skip_post_clone_snapshot'):
                continue
            vmid = r.get('vmid')
            node = r.get('node')
            if vmid and node:
                snapshot_tasks.append(r)

        if snapshot_tasks:
            _update_job_detail(pid, phase='snapshotting', message=f'Creating post-network snapshots ({len(snapshot_tasks)} VMs)…')
            snapshot_workers = _pool_workers_for(proj, len(snapshot_tasks))
            def _do_post_snap(item):
                try:
                    vm_name, ordinal, total, progress_label = _target_progress_meta(item, item.get('name') or str(item.get('vmid') or 'VM'))
                    _update_job_detail(
                        pid,
                        phase='snapshotting',
                        current=vm_name,
                        progress=_snapshot_progress(ordinal, len(snapshot_tasks)),
                        message=f'Creating snapshot for {progress_label}…',
                    )
                    # Timeout matching the original logic (900s)
                    is_lxc = item.get('type', 'qemu') == 'lxc'
                    if is_lxc:
                        supid = client.snapshot_lxc(node=item['node'], vmid=item['vmid'], snapname='post-clone', description='Auto snapshot after clone')
                    else:
                        supid = client.snapshot_qemu(node=item['node'], vmid=item['vmid'], snapname='post-clone', description='Auto snapshot after clone')
                    client._wait_task(item['node'], supid, timeout=900)
                    return {
                        'name': item.get('name') or '',
                        'vmid': item.get('vmid'),
                        'node': item.get('node') or '',
                        'snapname': 'post-clone',
                    }
                except Exception as e:
                    return f"snapshot failed for {item.get('name')}: {e}"

            with ThreadPoolExecutor(max_workers=snapshot_workers) as pool:
                snap_futs = {pool.submit(_do_post_snap, t): t for t in snapshot_tasks}
                snapshot_done = 0
                for fut in as_completed(snap_futs):
                    res = fut.result()
                    snapshot_done += 1
                    try:
                        item = snap_futs[fut]
                        vm_name, ordinal, total, progress_label = _target_progress_meta(item, item.get('name') or str(item.get('vmid') or 'VM'))
                        _update_job_detail(
                            pid,
                            phase='snapshotting',
                            current=vm_name,
                            step=snapshot_done,
                            total_steps=len(snapshot_tasks),
                            progress=_snapshot_progress(ordinal, len(snapshot_tasks), completed=snapshot_done),
                            message=(
                                f'Snapshot created for {progress_label}; {snapshot_done}/{len(snapshot_tasks)} complete'
                                if isinstance(res, dict) else
                                f'Snapshot failed for {progress_label}; {snapshot_done}/{len(snapshot_tasks)} complete'
                            ),
                        )
                    except Exception:
                        pass
                    if isinstance(res, dict):
                        snapshotted.append(res)
                    elif res:
                        # Log error but don't fail the whole job
                        try:
                            t_item = snap_futs[fut]
                            errors.append({'reason': res, 'name': t_item.get('name')})
                        except Exception:
                            pass

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
                should_have_snapshot = not bool(r.get('skip_post_clone_snapshot'))
                has_snap = not should_have_snapshot
                if should_have_snapshot:
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
                    if getattr(cfg, 'vm_type', 'qemu') == 'lxc':
                        cfg_now = client.get_lxc_config(node=node, vmid=vmid) or {}
                    else:
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
                                if getattr(cfg, 'vm_type', 'qemu') == 'lxc':
                                    cfg_now = client.get_lxc_config(node=node, vmid=vmid) or {}
                                else:
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
    try:
        runtime_store = _runtime_store()
        for item in results or []:
            runtime_store.clear_vm_validation_state(
                pid,
                item.get('name'),
                vmid=item.get('vmid'),
                node=item.get('node'),
            )
    except Exception:
        pass
    _end_job(pid)
    _update_job_detail(pid, phase='done', message='Create completed', progress=100)
    verify_summary = {
        'missing_snapshot': sum(1 for i in verify_issues if i.get('missing_snapshot')),
        'nets_mismatch': sum(1 for i in verify_issues if not i.get('nets_ok', True)),
        'ageing_missing': sum(1 for i in verify_issues if i.get('ageing_missing')),
    }
    return jsonify({ 'created': results, 'skipped': skipped, 'errors': errors, 'notices': notices, 'ambiguous': ambiguous_out, 'network_applied_nodes': network_applied_nodes, 'network_apply_errors': network_apply_errors, 'snapshotted': snapshotted, 'vmid_retry_info': vmid_retry_info_filtered, 'verify': { 'issues': verify_issues, 'summary': verify_summary } })


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
    DEFAULT_CMD_TIMEOUT = 300
    DEFAULT_VALIDATION_TIMEOUT = 10
    MAX_CMD_TIMEOUT = 86400

    def _coerce_timeout(value: Any, default: int = DEFAULT_CMD_TIMEOUT) -> int:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return default
        if num <= 0:
            return default
        try:
            num = int(round(num))
        except Exception:
            num = int(num)
        if num > MAX_CMD_TIMEOUT:
            num = MAX_CMD_TIMEOUT
        return num

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
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
            if norm in {'true', '1', 'yes', 'on', 'enabled', 'long', 'longrunning'}:
                return True
            if norm in {'false', '0', 'no', 'off', 'disabled', 'short', 'standard'}:
                return False
        return bool(value)

    def _compile_validation_regex(pattern: str) -> Tuple[Optional[re.Pattern], Optional[str]]:
        text = str(pattern or '').strip()
        if not text:
            return None, 'missing regular expression'
        body = text
        flags = 0
        if len(text) >= 2 and text.startswith('/'):
            slash_idx = text.rfind('/')
            if slash_idx > 0:
                body = text[1:slash_idx]
                flag_part = text[slash_idx + 1:]
                for ch in flag_part:
                    if ch == 'i':
                        flags |= re.IGNORECASE
                    elif ch == 'm':
                        flags |= re.MULTILINE
                    elif ch == 's':
                        flags |= re.DOTALL
                    elif ch == 'x':
                        flags |= re.VERBOSE
                    elif ch:
                        return None, f"unsupported regex flag: {ch}"
        try:
            return re.compile(body, flags), None
        except re.error as exc:
            return None, f"invalid regex: {exc}"

    def _extract_validation_commands(vcfg_obj: Any) -> List[Dict[str, Any]]:
        raw = sanitize_validation_commands(getattr(vcfg_obj, 'validation_commands', [])) if vcfg_obj else []
        out: List[Dict[str, Any]] = []
        for order, entry in enumerate(raw, start=1):
            if not isinstance(entry, dict):
                continue
            cmd_text = _normalize_command_text(entry.get('command'))
            if not cmd_text:
                continue
            enabled = _coerce_bool_flag(entry.get('enabled'), True)
            if not enabled:
                continue
            match_expr = str(entry.get('match') or '').strip()
            timeout_seconds = _coerce_timeout(entry.get('timeout_seconds'), default=DEFAULT_VALIDATION_TIMEOUT)
            out.append({
                'order': order,
                'command': cmd_text,
                'match': match_expr,
                'timeout_seconds': timeout_seconds,
            })
        return out
    DEFAULT_CMD_TIMEOUT = 300
    DEFAULT_VALIDATION_TIMEOUT = 10
    MAX_CMD_TIMEOUT = 86400

    def _coerce_timeout(value: Any, default: int = DEFAULT_CMD_TIMEOUT) -> int:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return default
        if num <= 0:
            return default
        try:
            num = int(round(num))
        except Exception:
            num = int(num)
        if num > MAX_CMD_TIMEOUT:
            num = MAX_CMD_TIMEOUT
        return num

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
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
            if norm in {'true', '1', 'yes', 'on', 'enabled', 'long', 'longrunning'}:
                return True
            if norm in {'false', '0', 'no', 'off', 'disabled', 'short', 'standard'}:
                return False
        return bool(value)
    DEFAULT_CMD_TIMEOUT = 300
    DEFAULT_VALIDATION_TIMEOUT = 10
    MAX_CMD_TIMEOUT = 86400

    def _coerce_timeout(value: Any) -> int:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return DEFAULT_CMD_TIMEOUT
        if num <= 0:
            return DEFAULT_CMD_TIMEOUT
        try:
            num = int(round(num))
        except Exception:
            num = int(num)
        if num > MAX_CMD_TIMEOUT:
            num = MAX_CMD_TIMEOUT
        return num

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
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
            if norm in {'true', '1', 'yes', 'on', 'enabled', 'long', 'longrunning'}:
                return True
            if norm in {'false', '0', 'no', 'off', 'disabled', 'short', 'standard'}:
                return False
        return bool(value)
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
                    name_bucket.setdefault(key, []).append({ 'node': node, 'name': nm, 'vmid': vmid, 'template': q.get('template'), 'type': 'qemu' })
        except Exception:
            pass
        try:
            for c in client.list_lxc_vms(node):
                nm = str(c.get('name') or c.get('hostname') or '')
                vmid = int(c.get('vmid')) if c.get('vmid') is not None else None
                key = nm.lower() if nm else ''
                if key and vmid is not None:
                    name_bucket.setdefault(key, []).append({ 'node': node, 'name': nm, 'vmid': vmid, 'template': c.get('template'), 'type': 'lxc' })
        except Exception:
            pass

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
                            is_lxc = getattr(cfg, 'vm_type', 'qemu') == 'lxc' or (src and src.get('type') == 'lxc')
                            is_tmpl = bool(src.get('template') in (1, '1', True, 'true'))
                            has_snapshots = False
                            linked_like = False
                            if is_lxc:
                                # Fetch extra metadata to improve accuracy
                                try:
                                    cfg_full = client.get_lxc_config(node=src.get('node'), vmid=vmid_explicit)
                                except Exception:
                                    cfg_full = {}
                                # Snapshot heuristic
                                try:
                                    snaps = client.list_lxc_snapshots(node=src.get('node'), vmid=vmid_explicit) or []
                                    has_snapshots = len(snaps) > 0
                                except Exception:
                                    pass
                                # Disk heuristic
                                try:
                                    for k,v in (cfg_full or {}).items():
                                        ks = str(k)
                                        if ks.startswith(('rootfs', 'mp')):
                                            val = str(v)
                                            if 'base-' in val or 'subvol-' in val:
                                                linked_like = True; break
                                except Exception:
                                    pass
                            else:
                                # Fetch extra metadata to improve accuracy
                                try:
                                    cfg_full = client.get_qemu_config(node=src.get('node'), vmid=vmid_explicit)
                                except Exception:
                                    cfg_full = {}
                                # Snapshot heuristic
                                try:
                                    snaps = client.list_qemu_snapshots(node=src.get('node'), vmid=vmid_explicit) or []
                                    has_snapshots = len(snaps) > 0
                                except Exception:
                                    pass
                                # Disk heuristic
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
                    is_lxc = getattr(cfg, 'vm_type', 'qemu') == 'lxc' or (src and src.get('type') == 'lxc')
                    is_tmpl = bool(src.get('template') in (1, '1', True, 'true'))
                    vmid_src = src.get('vmid')
                    node_src = src.get('node')
                    has_snapshots = False
                    linked_like = False
                    if is_lxc:
                        # Extended heuristics for template detection
                        try:
                            cfg_full = client.get_lxc_config(node=node_src, vmid=vmid_src)
                        except Exception:
                            cfg_full = {}
                        try:
                            snaps = client.list_lxc_snapshots(node=node_src, vmid=vmid_src) or []
                            has_snapshots = len(snaps) > 0
                        except Exception:
                            pass
                        try:
                            for k,v in (cfg_full or {}).items():
                                ks = str(k)
                                if ks.startswith(('rootfs', 'mp')):
                                    val = str(v)
                                    if 'base-' in val or 'subvol-' in val:
                                        linked_like = True; break
                        except Exception:
                            pass
                    else:
                        # Extended heuristics for template detection
                        try:
                            cfg_full = client.get_qemu_config(node=node_src, vmid=vmid_src)
                        except Exception:
                            cfg_full = {}
                        try:
                            snaps = client.list_qemu_snapshots(node=node_src, vmid=vmid_src) or []
                            has_snapshots = len(snaps) > 0
                        except Exception:
                            pass
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
    DEFAULT_CMD_TIMEOUT = 300
    DEFAULT_VALIDATION_TIMEOUT = 10
    MAX_CMD_TIMEOUT = 86400

    def _coerce_timeout(value: Any, default: int = DEFAULT_CMD_TIMEOUT) -> int:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return default
        if num <= 0:
            return default
        try:
            num = int(round(num))
        except Exception:
            num = int(num)
        if num > MAX_CMD_TIMEOUT:
            num = MAX_CMD_TIMEOUT
        return num

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
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
            if norm in {'true', '1', 'yes', 'on', 'enabled', 'long', 'longrunning'}:
                return True
            if norm in {'false', '0', 'no', 'off', 'disabled', 'short', 'standard'}:
                return False
        return bool(value)

    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    runtime_store = _runtime_store()
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
    verify_cleanup = bool(body.get('verifyCleanup')) if ('verifyCleanup' in body) else True

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            normalized = value.strip().lower()
            if not normalized:
                return default
            if normalized in {'false', '0', 'no', 'off', 'disabled'}:
                return False
            if normalized in {'true', '1', 'yes', 'on', 'enabled'}:
                return True
        return bool(value)

    delete_users_and_pools = _coerce_bool_flag(body.get('deleteUsersAndPools') if 'deleteUsersAndPools' in body else None, False)
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
    selected_indices = sorted({ int((t or {}).get('index', 0)) for t in targets if (t or {}).get('index') })

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
                    name_to_info[nm.lower()] = { 'node': node, 'vmid': int(q.get('vmid')) if q.get('vmid') is not None else None, 'name': nm, 'type': 'qemu' }
            for c in client.list_lxc_vms(node):
                nm = str(c.get('name') or c.get('hostname') or '')
                if nm:
                    name_to_info[nm.lower()] = { 'node': node, 'vmid': int(c.get('vmid')) if c.get('vmid') is not None else None, 'name': nm, 'type': 'lxc' }
        except Exception:
            continue

    deleted = []
    skipped = []
    errors = []
    notices = []
    bridges_to_reload = set()
    network_applied_nodes = []
    network_apply_errors = []
    deleted_users = []
    deleted_pools = []

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
        vtype = info.get('type', 'qemu')
        adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or [])
        return ('ok', { 'index': idx, 'gen_name': gen_name, 'node': node, 'vmid': vmid, 'type': vtype, 'adaptors': adaptors })

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
        bname = _bridge_iface_name(idx, adaptor_name)
        bulk_bridge_deletions.setdefault(node, []).append({ 'bridge': bname, 'index': idx, 'name': gen_name, 'adaptor': _normalize_bridge_adaptor_name(adaptor_name), 'legacy': False })
        # Legacy hashed bridge variant
        try:
            old_bname = _bridge_legacy_iface_name(tag, idx, adaptor_name)
            bulk_bridge_deletions.setdefault(node, []).append({ 'bridge': old_bname, 'index': idx, 'name': gen_name, 'adaptor': _normalize_bridge_adaptor_name(adaptor_name), 'legacy': True })
        except Exception:
            pass

    def do_delete(task):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        idx = task['index']
        gen_name = task['gen_name']
        node = task['node']
        vmid = task['vmid']
        is_lxc = task.get('type') == 'lxc'
        adaptors = task['adaptors']
        if is_lxc:
            upid = client.delete_lxc(node=node, vmid=vmid, purge=True, destroy_unreferenced_disks=True)
        else:
            upid = client.delete_qemu(node=node, vmid=vmid, purge=True, destroy_unreferenced_disks=True)
        client._wait_task(node, upid, timeout=1200)
        # Record bridges for later deletion (post all deletions) to avoid race conditions and repeated node reloads
        for a in adaptors:
            _record_bridge_for_cleanup(node, idx, a, gen_name)
        return ({ 'index': idx, 'name': gen_name, 'vmid': vmid, 'node': node })

    pool_workers = _pool_workers_for(proj, len(tasks))
    total_tasks = len(tasks)
    if total_tasks > 0:
        _job_emit_batch_progress(pid, 'deleting', 'Deleting', 0, total_tasks, message=f'Deleting VM(s)… 0/{total_tasks} complete')
    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
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
            finally:
                if total_tasks > 0:
                    done = len(deleted) + len(errors)
                    _job_emit_batch_progress(pid, 'deleting', 'Deleting', done, total_tasks, current=str(t.get('gen_name') or ''), message=f'Delete processed for {t.get("gen_name") or "VM"}; {done}/{total_tasks} complete')
    project_snapshot = _build_bridge_project_snapshot(proj, tag)
    deferred_cleanup = { 'scheduled': False, 'nodes': [], 'bridge_count': 0 }
    if bulk_bridge_deletions:
        unique_cleanup_bridges = {
            (str(node), str((entry or {}).get('bridge') or ''))
            for node, items in bulk_bridge_deletions.items()
            for entry in (items or [])
            if str((entry or {}).get('bridge') or '')
        }
        deferred_cleanup = {
            'scheduled': False,
            'nodes': sorted(str(node) for node in bulk_bridge_deletions.keys()),
            'bridge_count': len(unique_cleanup_bridges),
        }

    if verify_cleanup:
        cleanup_result = _execute_delete_bridge_cleanup(project_snapshot, client, bulk_bridge_deletions)
        notices.extend(list(cleanup_result.get('notices') or []))
        errors.extend(list(cleanup_result.get('errors') or []))
        network_applied_nodes.extend(list(cleanup_result.get('network_applied_nodes') or []))
        network_apply_errors.extend(list(cleanup_result.get('network_apply_errors') or []))
    elif bulk_bridge_deletions:
        client_kwargs = {
            'base_url': base_url,
            'token': getattr(proj, 'proxmox_api_token', '') or None,
            'username': username,
            'password': password,
            'verify': verify,
        }
        deferred_cleanup['scheduled'] = _schedule_delete_bridge_cleanup(project_snapshot, client_kwargs, bulk_bridge_deletions)
        if deferred_cleanup['scheduled']:
            _append_unique_reason(notices, { 'reason': f"bridge cleanup scheduled in background for {len(deferred_cleanup['nodes'])} node(s)" })

    # Optional deep post-delete verification. This can be expensive on nodes with many VMs/storages,
    # so callers can opt out when they only need the delete result and bridge cleanup.
    verify_result = {
        'skipped': not verify_cleanup,
        'issues': [],
        'summary': { 'nets_left': 0, 'disks_left': 0, 'snaps_left': 0 },
    }
    if verify_cleanup:
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
                        verify_result['issues'].append({ 'index': idx, 'name': name, 'node': node, 'vmid': vmid, 'nets_left': lingering_nets })
                        verify_result['summary']['nets_left'] += 1
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
                        verify_result['issues'].append({ 'index': idx, 'name': name, 'node': node, 'vmid': vmid, 'disks_left': disks, 'snaps_left': snaps })
                        verify_result['summary']['disks_left'] += 1 if disks else 0
                        verify_result['summary']['snaps_left'] += 1 if snaps else 0
                except Exception:
                    pass
        except Exception:
            pass

    if delete_users_and_pools and selected_indices:
        remaining_names_lc = set()
        try:
            post_nodes = client.list_nodes()
        except Exception:
            post_nodes = nodes
        for n in post_nodes:
            node = n.get('node') or n.get('id') or ''
            if not node:
                continue
            try:
                for q in client.list_qemu_vms(node):
                    nm = str(q.get('name') or '').strip()
                    if nm:
                        remaining_names_lc.add(nm.lower())
            except Exception:
                continue

        cleanup_indices = []
        for idx in selected_indices:
            remaining_for_idx = []
            for cfg in vms_cfg:
                base_name = str(getattr(cfg, 'name', '') or '').strip()
                if not base_name:
                    continue
                gen_name = f"{base_name}{tag}{idx}"
                if gen_name.lower() in remaining_names_lc:
                    remaining_for_idx.append(gen_name)
            if remaining_for_idx:
                _append_unique_reason(notices, { 'index': idx, 'reason': f'user/pool cleanup skipped: scenario VMs still remain for instance {idx}' })
                continue
            cleanup_indices.append(idx)

        if cleanup_indices:
            cleanup_resp = _delete_proxmox_users_and_pools_for_indices(proj, client, cleanup_indices)
            deleted_users.extend(list(cleanup_resp.get('deleted_users') or []))
            deleted_pools.extend(list(cleanup_resp.get('deleted_pools') or []))
            errors.extend(list(cleanup_resp.get('errors') or []))
            notices.extend(list(cleanup_resp.get('notices') or []))

    try:
        runtime_store = _runtime_store()
        for item in deleted or []:
            runtime_store.clear_vm_validation_state(
                pid,
                item.get('name'),
                vmid=item.get('vmid'),
                node=item.get('node'),
            )
    except Exception:
        pass
    _end_job(pid)
    return jsonify({ 'deleted': deleted, 'deleted_users': deleted_users, 'deleted_pools': deleted_pools, 'skipped': skipped, 'errors': errors, 'notices': notices, 'network_applied_nodes': network_applied_nodes, 'network_apply_errors': network_apply_errors, 'verify': verify_result, 'deferred_cleanup': deferred_cleanup })


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


def _list_cluster_vms_by_name(client: ProxmoxClient) -> Tuple[Dict[str, Dict[str, Any]], Optional[str]]:
    name_to_info: Dict[str, Dict[str, Any]] = {}
    try:
        nodes = client.list_nodes() or []

        def _fetch_node_vms(node_info):
            node = (node_info or {}).get('node') or (node_info or {}).get('id') or ''
            node = str(node)
            if not node:
                return (None, [], [], None)
            try:
                thread_client = ProxmoxClient(
                    base_url=client.base_url,
                    token=client.token,
                    username=client.username,
                    password=client.password,
                    verify=client.verify,
                )
                qemus = thread_client.list_qemu_vms(node) or []
                lxcs = []
                try:
                    if hasattr(thread_client, 'list_lxc_vms'):
                        lxcs = thread_client.list_lxc_vms(node) or []
                except Exception:
                    pass
                return (node, qemus, lxcs, None)
            except Exception as e:
                return (node, [], [], e)

        max_workers = min(len(nodes) or 1, 8)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(_fetch_node_vms, n) for n in nodes]
            for fut in as_completed(futures):
                node, qemus, lxcs, err = fut.result()
                if err or not node:
                    continue
                for q in qemus:
                    nm = str((q or {}).get('name') or '')
                    if not nm:
                        continue
                    name_to_info[nm.lower()] = {
                        'node': node,
                        'vmid': int(q.get('vmid')) if q.get('vmid') is not None else None,
                        'name': nm,
                        'type': 'qemu',
                        'status': str(q.get('status') or q.get('qmpstatus') or '').lower(),
                        'power_status': str(q.get('status') or '').lower(),
                        'qmp_status': str(q.get('qmpstatus') or '').lower(),
                    }
                for l in lxcs:
                    nm = str((l or {}).get('name') or (l or {}).get('hostname') or '')
                    if not nm:
                        continue
                    name_to_info[nm.lower()] = {
                        'node': node,
                        'vmid': int(l.get('vmid')) if l.get('vmid') is not None else None,
                        'name': nm,
                        'type': 'lxc',
                        'status': str(l.get('status') or '').lower(),
                        'power_status': str(l.get('status') or '').lower(),
                        'qmp_status': '',
                    }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {}, f'failed to list nodes: {e}'
    return name_to_info, None


def _normalize_project_target(proj: Project, target: Any) -> Optional[Dict[str, Any]]:
    try:
        idx = int((target or {}).get('index'))
        incoming = str((target or {}).get('name') or '').strip()
    except Exception:
        return None
    if not incoming:
        return None

    tag = str(getattr(proj, 'tag', '') or '').strip()
    suffix = f"{tag}{idx}"
    base_name = incoming
    if suffix and base_name.endswith(suffix):
        base_name = base_name[:len(base_name) - len(suffix)]

    known_config = False
    try:
        cfg_map = { str(getattr(v, 'name', '') or ''): v for v in (getattr(proj, 'vms', []) or []) }
        cfg_map_lc = { str(getattr(v, 'name', '') or '').lower(): v for v in (getattr(proj, 'vms', []) or []) }
        cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
        if not cfg:
            for vm in (getattr(proj, 'vms', []) or []):
                candidate = str(getattr(vm, 'name', '') or '')
                if candidate and suffix and f"{candidate}{suffix}" == incoming:
                    cfg = vm
                    base_name = candidate
                    break
        if cfg:
            known_config = True
            base_name = str(getattr(cfg, 'name', '') or base_name)
    except Exception:
        known_config = False

    generated_name = f"{base_name}{suffix}" if base_name else incoming
    return {
        'index': idx,
        'input_name': incoming,
        'base_name': base_name,
        'generated_name': generated_name,
        'known_config': known_config,
    }


def _retry_check_item(
    normalized_target: Dict[str, Any],
    *,
    retry_name: Optional[str] = None,
    resolved_name: Optional[str] = None,
    info: Optional[Dict[str, Any]] = None,
    reason: Optional[str] = None,
    snapname: Optional[str] = None,
) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        'index': int(normalized_target.get('index') or 0),
        'name': str(retry_name or normalized_target.get('input_name') or normalized_target.get('generated_name') or ''),
    }
    resolved = str(resolved_name or '').strip()
    if resolved and resolved != item['name']:
        item['resolved_name'] = resolved
    if info:
        if info.get('node'):
            item['node'] = info.get('node')
        if info.get('vmid') is not None:
            item['vmid'] = info.get('vmid')
    if reason:
        item['reason'] = reason
    if snapname:
        item['snapname'] = snapname
    return item


def _vm_retry_state_matches(action: str, info: Dict[str, Any], cfg: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
    power_state = str((info or {}).get('power_status') or (info or {}).get('status') or '').strip().lower()
    qmp_state = str((info or {}).get('qmp_status') or '').strip().lower()
    lock_state = str((cfg or {}).get('lock') or '').strip()
    current_state = power_state or qmp_state or 'unknown'

    if action == 'start':
        matched = power_state in ('running', 'starting', 'rebooting') or qmp_state in ('running', 'prelaunch')
        return matched, ('vm is already running' if matched else f'current state is {current_state}')
    if action == 'suspend':
        matched = power_state in ('paused', 'suspended') or qmp_state in ('paused', 'suspended')
        return matched, ('vm is already suspended' if matched else f'current state is {current_state}')
    if action == 'poweroff':
        matched = power_state in ('stopped', 'down', 'shutoff', 'off', 'halted', 'stopping', 'shutdown') or qmp_state in ('stopped', 'shutdown')
        return matched, ('vm is already stopped' if matched else f'current state is {current_state}')
    if action == 'unlock':
        matched = not lock_state
        return matched, ('vm is already unlocked' if matched else f'lock is still {lock_state}')
    return False, f'unhandled retry verification action: {action}'


def _resolve_targets_to_vm_info(proj: Project, client: ProxmoxClient, targets: list):
    """Map incoming targets (index, name base or generated) to actual VM info (node, vmid, gen_name).
    Returns (mapped_list, skipped_list, errors_list)
    """
    name_to_info, list_err = _list_cluster_vms_by_name(client)
    if list_err:
        return [], [], [{ 'reason': list_err }]
    mapped = []
    skipped = []
    errors = []
    for t in targets:
        normalized = _normalize_project_target(proj, t)
        if not normalized:
            errors.append({ 'name': t, 'reason': 'invalid target' })
            continue
        idx = int(normalized['index'])
        base_name = str(normalized.get('base_name') or '')
        gen_name = str(normalized.get('generated_name') or '')
        if not normalized.get('known_config'):
            errors.append({ 'index': idx, 'name': base_name, 'reason': 'unknown base name' })
            continue
        info = name_to_info.get(gen_name.lower())
        if not info or info.get('vmid') is None:
            skipped.append({ 'index': idx, 'name': gen_name, 'reason': 'not found' })
            continue
        # Append each resolved VM info to the mapped list (fix: ensure inside loop)
        mapped.append({
            'index': idx,
            'name': gen_name,
            'node': info['node'],
            'vmid': info['vmid'],
            'type': info.get('type', 'qemu'),
            'status': info.get('status', ''),
            'power_status': info.get('power_status', ''),
            'qmp_status': info.get('qmp_status', ''),
        })
    return mapped, skipped, errors


@api_bp.route("/projects/<pid>/instances/actions/<action>/retry-check", methods=["POST"])
def instances_action_retry_check(pid: str, action: str):
    supported = {'create', 'delete', 'start', 'unlock', 'suspend', 'poweroff', 'snapshot', 'apply_scenario'}
    if action not in supported:
        return jsonify({"error": "Retry verification is not supported for this action"}), 400

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
    snapname = str(body.get('snapname') or '').strip()
    if action == 'snapshot' and not snapname:
        return jsonify({"error": "Missing snapshot name for retry verification"}), 400
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400

    client = ProxmoxClient(base_url=base_url, token=getattr(proj, 'proxmox_api_token', '') or None, username=username, password=password, verify=verify)
    name_to_info, list_err = _list_cluster_vms_by_name(client)
    if list_err:
        return jsonify({"error": list_err}), 502

    completed: List[Dict[str, Any]] = []
    remaining: List[Dict[str, Any]] = []

    for target in targets:
        normalized = _normalize_project_target(proj, target)
        if not normalized:
            remaining.append({ 'name': str(target or ''), 'reason': 'invalid target' })
            continue

        base_name = str(normalized.get('base_name') or '')
        generated_name = str(normalized.get('generated_name') or '')
        retry_name = base_name if action in ('create', 'delete') else generated_name

        if not normalized.get('known_config'):
            remaining.append(_retry_check_item(normalized, retry_name=retry_name or normalized.get('input_name'), resolved_name=generated_name, reason='unknown base name'))
            continue

        info = name_to_info.get(generated_name.lower())

        if action == 'create':
            if info and info.get('vmid') is not None:
                completed.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason='VM already exists'))
            else:
                remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=generated_name, reason='VM not present after verification'))
            continue

        if action == 'delete':
            if not info or info.get('vmid') is None:
                completed.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=generated_name, reason='VM is already absent'))
            else:
                remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason='VM still exists'))
            continue

        if not info or info.get('vmid') is None:
            remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=generated_name, reason='VM not found during verification'))
            continue

        if action == 'snapshot':
            try:
                snaps = client.list_snapshots_qemu(node=info['node'], vmid=int(info['vmid'])) or []
            except Exception as e:
                remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason=f'snapshot check failed: {e}', snapname=snapname))
                continue
            matched = any(str((snap or {}).get('name') or '') == snapname for snap in snaps)
            if matched:
                completed.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason=f'snapshot {snapname} already exists', snapname=snapname))
            else:
                remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason=f'snapshot {snapname} not found', snapname=snapname))
            continue

        cfg = None
        if action in ('unlock', 'apply_scenario'):
            try:
                cfg = client.get_qemu_config(node=info['node'], vmid=int(info['vmid'])) or {}
            except Exception as e:
                remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason=f'config check failed: {e}'))
                continue

        if action == 'apply_scenario':
            if _vm_description_matches_project(proj, (cfg or {}).get('description')):
                completed.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason='Scenario notes already match this project'))
            else:
                remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason='Scenario notes are not present yet'))
            continue

        matched, reason = _vm_retry_state_matches(action, info, cfg)
        if matched:
            completed.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason=reason))
        else:
            remaining.append(_retry_check_item(normalized, retry_name=retry_name, resolved_name=str(info.get('name') or generated_name), info=info, reason=reason))

    return jsonify({ 'completed': completed, 'remaining': remaining, 'snapname': snapname or None })


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
    pool_workers = _pool_workers_for(proj, len(mapped))
    total_mapped = len(mapped)
    if total_mapped > 0:
        _job_emit_batch_progress(pid, 'starting', 'Starting', 0, total_mapped, message=f'Starting VM(s)… 0/{total_mapped} complete')
    # Run in parallel with a reasonable pool size
    def do_start(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        st = (m.get('status') or '').lower()
        is_lxc = m.get('type') == 'lxc'
        if st == 'suspended':
            if is_lxc:
                upid = client.resume_lxc(node=m['node'], vmid=m['vmid'])
            else:
                upid = client.resume_qemu(node=m['node'], vmid=m['vmid'])
            client._wait_task(m['node'], upid, timeout=600, vmid=m['vmid'], completed_vm_statuses=['running'])
            return ('resumed', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] })
        if is_lxc:
            upid = client.start_lxc(node=m['node'], vmid=m['vmid'])
        else:
            upid = client.start_qemu(node=m['node'], vmid=m['vmid'])
        client._wait_task(m['node'], upid, timeout=600, vmid=m['vmid'], completed_vm_statuses=['running'])
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
            finally:
                if total_mapped > 0:
                    done = len(started) + len(resumed) + len(errors)
                    _job_emit_batch_progress(pid, 'starting', 'Starting', done, total_mapped, current=str(m.get('name') or ''), message=f'Start processed for {m.get("name") or "VM"}; {done}/{total_mapped} complete')
    _end_job(pid)
    return jsonify({ 'started': started, 'resumed': resumed, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/apply_scenario", methods=["POST"])
def instances_apply_scenario(pid: str):
    _start_job(pid, 'apply_scenario')
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
        return jsonify({"error": "Missing Proxmox URL and credentials"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
        
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    applied = []
    
    pool_workers = _pool_workers_for(proj, len(mapped))
    delay = float(getattr(proj, 'proxmox_update_delay_seconds', 0.5))
    total_mapped = len(mapped)
    if total_mapped > 0:
        _job_emit_batch_progress(pid, 'applying', 'Applying Scenario', 0, total_mapped, message=f'Applying scenario notes… 0/{total_mapped} complete')
    
    # Map configurations by name for easy lookup
    cfg_map = {}
    for cfg in getattr(proj, 'vms', []):
        name = getattr(cfg, 'name', '')
        if name:
            cfg_map[name.lower()] = cfg

    def do_apply(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
            
        node = m['node']
        vmid = m['vmid']
        gen_name = str(m.get('name', ''))
        idx_str = str(m.get('index', ''))
        
        # We must recover the pure template name to find it in cfg_map
        base_name = gen_name
        tag = str(proj.tag or '').strip()
        suf = f"{tag}{idx_str}"
        if suf and base_name.endswith(suf):
            base_name = base_name[:-len(suf)]
            
        base_name_lc = base_name.lower()
        
        # Prepare notes payload
        notes_payload = {
            "Scenario": proj.name
        }
        
        cfg = cfg_map.get(base_name_lc)
        if cfg:
            cfg_user = getattr(cfg, 'vm_user', None)
            cfg_pass = getattr(cfg, 'vm_pass', None)
            if cfg_user:
                notes_payload["User"] = cfg_user
            if cfg_pass:
                notes_payload["Pass"] = cfg_pass
                
        json_notes = json.dumps(notes_payload, indent=4)
        
        # Fetch existing config to preserve old notes while replacing previous JSON payload
        is_lxc = m.get('type') == 'lxc'
        if is_lxc:
            ex_cfg = client.get_lxc_config(node=node, vmid=int(vmid)) or {}
        else:
            ex_cfg = client.get_qemu_config(node=node, vmid=int(vmid)) or {}
        old_desc = ex_cfg.get('description', '')
        
        if old_desc:
            import re
            # Remove previous Scenario JSON block if it exists
            # This regex looks for { followed by things, "Scenario":, things, and }
            clean_desc = re.sub(r'\{[^{}]*"Scenario"[^{}]*\}', '', old_desc, flags=re.DOTALL)
            clean_desc = clean_desc.strip()
            if clean_desc:
                new_desc = f"{clean_desc}\n\n{json_notes}"
            else:
                new_desc = json_notes
        else:
            new_desc = json_notes
            
        if is_lxc:
            client.set_lxc_options(node=node, vmid=int(vmid), options={'description': new_desc})
        else:
            client.set_qemu_options(node=node, vmid=int(vmid), options={'description': new_desc})
        return ('applied', { 'index': m['index'], 'name': m['name'], 'vmid': vmid, 'node': node })

    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
        future_map = {}
        for i, m in enumerate(mapped):
            future_map[pool.submit(do_apply, m)] = m
            if i < len(mapped) - 1 and delay > 0:
                try:
                    _safe_sleep(delay)
                except Exception:
                    pass
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                applied.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'apply scenario failed: {e}' })
            finally:
                if total_mapped > 0:
                    done = len(applied) + len(errors)
                    _job_emit_batch_progress(pid, 'applying', 'Applying Scenario', done, total_mapped, current=str(m.get('name') or ''), message=f'Applied scenario step for {m.get("name") or "VM"}; {done}/{total_mapped} complete')
    _end_job(pid)
    return jsonify({ 'applied': applied, 'skipped': skipped, 'errors': errors })


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
    pool_workers = _pool_workers_for(proj, len(mapped))
    total_mapped = len(mapped)
    if total_mapped > 0:
        _job_emit_batch_progress(pid, 'suspending', 'Suspending', 0, total_mapped, message=f'Suspending VM(s)… 0/{total_mapped} complete')
    def do_suspend(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        is_lxc = m.get('type') == 'lxc'
        if is_lxc:
            upid = client.suspend_lxc(node=m['node'], vmid=m['vmid'])
        else:
            upid = client.suspend_qemu(node=m['node'], vmid=m['vmid'])
        client._wait_task(m['node'], upid, timeout=600, vmid=m['vmid'], completed_vm_statuses=['suspended', 'stopped'])
        return ('suspended', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] })

    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
        future_map = { pool.submit(do_suspend, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                suspended.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'suspend failed: {e}' })
            finally:
                if total_mapped > 0:
                    done = len(suspended) + len(errors)
                    _job_emit_batch_progress(pid, 'suspending', 'Suspending', done, total_mapped, current=str(m.get('name') or ''), message=f'Suspend processed for {m.get("name") or "VM"}; {done}/{total_mapped} complete')
    _end_job(pid)
    return jsonify({ 'suspended': suspended, 'skipped': skipped, 'errors': errors })


@api_bp.route("/projects/<pid>/instances/actions/unlock", methods=["POST"])
def instances_unlock(pid: str):
    _start_job(pid, 'unlock')
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
    unlocked = []
    pool_workers = _pool_workers_for(proj, len(mapped))
    total_mapped = len(mapped)
    if total_mapped > 0:
        _job_emit_batch_progress(pid, 'unlocking', 'Unlocking', 0, total_mapped, message=f'Unlocking VM(s)… 0/{total_mapped} complete')

    def do_unlock(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        is_lxc = m.get('type') == 'lxc'
        if is_lxc:
            upid = client.unlock_lxc(node=m['node'], vmid=m['vmid'])
        else:
            upid = client.unlock_qemu(node=m['node'], vmid=m['vmid'])
        client._wait_task(m['node'], upid, timeout=600)
        return ('unlocked', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] })

    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
        future_map = { pool.submit(do_unlock, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                unlocked.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'unlock failed: {e}' })
            finally:
                if total_mapped > 0:
                    done = len(unlocked) + len(errors)
                    _job_emit_batch_progress(pid, 'unlocking', 'Unlocking', done, total_mapped, current=str(m.get('name') or ''), message=f'Unlock processed for {m.get("name") or "VM"}; {done}/{total_mapped} complete')
    _end_job(pid)
    return jsonify({ 'unlocked': unlocked, 'skipped': skipped, 'errors': errors })


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
    pool_workers = _pool_workers_for(proj, len(mapped))
    total_mapped = len(mapped)
    if total_mapped > 0:
        _job_emit_batch_progress(pid, 'powering_off', 'Powering Off', 0, total_mapped, message=f'Powering off VM(s)… 0/{total_mapped} complete')
    def do_poweroff(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        is_lxc = m.get('type') == 'lxc'
        if is_lxc:
            upid = client.stop_lxc(node=m['node'], vmid=m['vmid'])
        else:
            upid = client.stop_qemu(node=m['node'], vmid=m['vmid'])
        client._wait_task(m['node'], upid, timeout=600, vmid=m['vmid'], completed_vm_statuses=['stopped'])
        return ('stopped', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'] })

    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
        future_map = { pool.submit(do_poweroff, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                powered_off.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'power off failed: {e}' })
            finally:
                if total_mapped > 0:
                    done = len(powered_off) + len(errors)
                    _job_emit_batch_progress(pid, 'powering_off', 'Powering Off', done, total_mapped, current=str(m.get('name') or ''), message=f'Power-off processed for {m.get("name") or "VM"}; {done}/{total_mapped} complete')
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
        snapname = 'manual-' + _dt.datetime.now(_dt.timezone.utc).strftime('%Y%m%d-%H%M%S')
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    snapshotted = []
    delay = float(getattr(proj, 'proxmox_snapshot_delay_seconds', 5.0))
    total_mapped = len(mapped)
    if total_mapped > 0:
        _job_emit_batch_progress(pid, 'snapshotting', 'Snapshotting', 0, total_mapped, message=f'Creating snapshots… 0/{total_mapped} complete')
    # Execute snapshots sequentially with delay throttle to avoid overloading storage
    for i, m in enumerate(mapped):
        if _is_cancelled(pid):
            errors.append({ 'reason': 'cancelled' })
            break
        is_lxc = m.get('type') == 'lxc'
        try:
            if is_lxc:
                upid = client.snapshot_lxc(node=m['node'], vmid=m['vmid'], snapname=snapname, description=f'User snapshot for {m["name"]}')
            else:
                upid = client.snapshot_qemu(node=m['node'], vmid=m['vmid'], snapname=snapname, description=f'User snapshot for {m["name"]}')
            client._wait_task(m['node'], upid, timeout=600)
            snapshotted.append({ 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'], 'snapname': snapname })
        except Exception as e:
            errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'snapshot failed: {e}' })
        finally:
            if total_mapped > 0:
                done = len(snapshotted) + sum(1 for err in errors if err.get('name'))
                _job_emit_batch_progress(pid, 'snapshotting', 'Snapshotting', done, total_mapped, current=str(m.get('name') or ''), message=f'Snapshot processed for {m.get("name") or "VM"}; {done}/{total_mapped} complete')
        # Sleep between snapshots if more remain
        if i < len(mapped)-1 and delay and delay > 0:
            try:
                _safe_sleep(delay)
            except Exception:
                pass
    _end_job(pid)
    return jsonify({ 'snapshotted': snapshotted, 'skipped': skipped, 'errors': errors, 'snapname': snapname })


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
    total_mapped = len(mapped)
    if total_mapped > 0:
        _job_emit_batch_progress(pid, 'restoring', 'Restoring', 0, total_mapped, message=f'Restoring snapshots… 0/{total_mapped} complete')
    def do_restore(m):
        if _is_cancelled(pid):
            raise RuntimeError('cancelled')
        is_lxc = m.get('type') == 'lxc'
        if is_lxc:
            snaps = client.list_snapshots_lxc(node=m['node'], vmid=m['vmid'])
        else:
            snaps = client.list_snapshots_qemu(node=m['node'], vmid=m['vmid'])
        snaps = [s for s in snaps if s.get('name') and s.get('name') != 'current']
        if not snaps:
            return ('skipped', { 'index': m['index'], 'name': m['name'], 'reason': 'no snapshots found' })
        snaps_sorted = sorted(snaps, key=lambda s: (s.get('snaptime') or 0), reverse=True)
        snapname = snaps_sorted[0].get('name')
        if is_lxc:
            upid = client.restore_snapshot_lxc(node=m['node'], vmid=m['vmid'], snapname=snapname, start_after=start_after)
        else:
            upid = client.restore_snapshot_qemu(node=m['node'], vmid=m['vmid'], snapname=snapname, start_after=start_after)
        client._wait_task(m['node'], upid, timeout=900)
        return ('restored', { 'index': m['index'], 'name': m['name'], 'vmid': m['vmid'], 'node': m['node'], 'snapname': snapname, 'started': start_after, 'latest': True })

    pool_workers = _pool_workers_for(proj, len(mapped))
    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
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
            finally:
                if total_mapped > 0:
                    done = len(restored) + sum(1 for item in skipped if item.get('name')) + len(errors)
                    _job_emit_batch_progress(pid, 'restoring', 'Restoring', done, total_mapped, current=str(m.get('name') or ''), message=f'Restore processed for {m.get("name") or "VM"}; {done}/{total_mapped} complete')
    _end_job(pid)
    return jsonify({ 'restored': restored, 'skipped': skipped, 'errors': errors, 'notice': notice })


def _parse_qemu_net_spec(spec: Any) -> Dict[str, Any]:
    """Parse a Proxmox QEMU netX string.

    Examples:
      - "e1000,bridge=vmbr0"
      - "e1000=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1"
    """
    try:
        text = str(spec or '').strip()
    except Exception:
        text = ''
    tokens = [t.strip() for t in text.split(',') if t.strip()]
    if not tokens:
        return { 'raw': text, 'tokens': [], 'model': '', 'first': '', 'kv': {}, 'extras': [] }
    first = tokens[0]
    model = first.split('=', 1)[0].strip()
    kv: Dict[str, str] = {}
    extras: List[str] = []
    for t in tokens[1:]:
        if '=' in t:
            k, v = t.split('=', 1)
            kv[k.strip()] = v.strip()
        else:
            extras.append(t)
    return { 'raw': text, 'tokens': tokens, 'model': model, 'first': first, 'kv': kv, 'extras': extras }


def _net_spec_matches(existing_spec: Any, expected_spec: str) -> bool:
    ex = _parse_qemu_net_spec(existing_spec)
    exp = _parse_qemu_net_spec(expected_spec)
    if not exp.get('model') or not exp.get('kv', {}).get('bridge'):
        return False
    return (str(ex.get('model') or '') == str(exp.get('model') or '')) and (str(ex.get('kv', {}).get('bridge') or '') == str(exp.get('kv', {}).get('bridge') or ''))


def _build_corrected_net_spec(existing_spec: Any, expected_spec: str) -> str:
    """Return a spec that preserves MAC/options when possible but fixes model/bridge to expected."""
    exp = _parse_qemu_net_spec(expected_spec)
    exp_model = str(exp.get('model') or '').strip()
    exp_bridge = str(exp.get('kv', {}).get('bridge') or '').strip()
    if not exp_model or not exp_bridge:
        return str(expected_spec)

    ex = _parse_qemu_net_spec(existing_spec)
    # Start with existing tokens if present; otherwise start fresh.
    tokens = list(ex.get('tokens') or [])
    if not tokens:
        return f"{exp_model},bridge={exp_bridge}"

    # Ensure model (keep MAC if it already matches expected model).
    first = str(ex.get('first') or '').strip()
    ex_model = str(ex.get('model') or '').strip()
    if ex_model != exp_model:
        tokens[0] = exp_model

    # Drop any existing bridge token(s).
    rest = [t for t in tokens[1:] if not str(t).strip().startswith('bridge=')]
    # Re-insert bridge right after the first token.
    new_tokens = [tokens[0], f"bridge={exp_bridge}"] + rest
    return ','.join([t for t in new_tokens if str(t).strip()])


@api_bp.route("/projects/<pid>/instances/actions/nets_set", methods=["POST"])
@api_bp.route("/projects/<pid>/instances/actions/nets_assign", methods=["POST"])
def instances_nets_set(pid: str):
    """Set (idempotently) VM network interfaces for selected VMs.

    - Ensures the expected netX entries exist and point at the expected bridges.
    - If an interface already exists and matches (model + bridge), it is left unchanged.
    - If an interface exists but mismatches, it is corrected.
    - Any extra netX entries beyond the configured adaptor count are removed.
    - If missing bridges are created on a node, the node networking is reloaded once after the batch.
    """
    _start_job(pid, 'nets_set')
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
    notices: List[Dict[str, Any]] = []
    network_applied_nodes: List[str] = []
    network_apply_errors: List[Dict[str, Any]] = []
    nodes_with_vm_changes: Set[str] = set()

    # 1) Pre-create missing bridges per node (batch), so VM netX specs can reference them.
    bridges_needed: Dict[str, Set[str]] = {}
    bridge_owners: Dict[str, Dict[str, int]] = {}
    for m in mapped:
        try:
            idx = int(m.get('index') or 0)
            gen_name = str(m.get('name') or '')
            node = str(m.get('node') or '')
            if not node or idx <= 0 or not gen_name:
                continue
            base_name = gen_name
            suf = f"{tag}{idx}"
            if suf and gen_name.endswith(suf):
                base_name = gen_name[:len(gen_name) - len(suf)]
            cfg = cfg_map.get(base_name) or cfg_map_lc.get(base_name.lower())
            if not cfg:
                continue
            adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or [])
            for a in adaptors:
                bname = _bridge_iface_name(idx, a)
                if bname:
                    bridges_needed.setdefault(node, set()).add(bname)
                    bridge_owners.setdefault(node, {}).setdefault(bname, idx)
        except Exception:
            continue

    bridges_to_reload: Set[str] = set()
    for node, needed in bridges_needed.items():
        existing = set()
        try:
            nets = client.list_network(node) or []
            for net in nets:
                iface = str((net or {}).get('iface') or '')
                if iface:
                    existing.add(iface)
        except Exception:
            existing = set()
        for b in sorted(needed):
            if b in existing:
                continue
            try:
                owner_idx = (bridge_owners.get(node) or {}).get(b, 0)
                client.create_bridge(node=node, iface=b, autostart=True, ports=None, comments=_bridge_owner_comment_for_iface(pid, owner_idx, b, 'nets_set'))
                bridges_to_reload.add(node)
                notices.append({ 'node': node, 'reason': f'bridge created: {b}' })
            except Exception as e:
                errors.append({ 'node': node, 'reason': f'bridge create failed for {b}: {e}' })

    def _base_from_generated(gen_name: str, idx: int) -> str:
        try:
            suf = f"{tag}{idx}"
            if gen_name.endswith(suf):
                return gen_name[:len(gen_name)-len(suf)]
        except Exception:
            pass
        return gen_name

    def _make_thread_client() -> ProxmoxClient:
        return ProxmoxClient(
            base_url=base_url,
            token=getattr(proj, 'proxmox_api_token', '') or None,
            username=username,
            password=password,
            verify=verify,
        )

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
        # Build expected netspecs from configured adaptors
        adaptors = list(getattr(cfg, 'internal_network_adaptors', []) or [])
        if not adaptors:
            return ('error', { 'index': idx, 'name': gen_name, 'reason': 'no adaptors configured' })
        is_lxc = (m.get('type') == 'lxc') or (getattr(cfg, 'vm_type', 'qemu') == 'lxc')
        netspecs = []
        for i, a in enumerate(adaptors):
            bname = _bridge_iface_name(idx, a)
            if is_lxc:
                netspecs.append(f"name=eth{i},bridge={bname}")
            else:
                netspecs.append(f"e1000,bridge={bname}")
        try:
            thread_client = _make_thread_client()
            try:
                if is_lxc:
                    existing_cfg = thread_client.get_lxc_config(node=node, vmid=vmid) or {}
                else:
                    existing_cfg = thread_client.get_qemu_config(node=node, vmid=vmid) or {}
            except Exception:
                existing_cfg = {}

            desired_keys = [f'net{i}' for i in range(len(netspecs))]
            existing_net_keys = [k for k in (existing_cfg or {}).keys() if str(k).startswith('net')]
            delete_keys = [k for k in existing_net_keys if str(k) not in set(desired_keys)]

            to_set: Dict[str, str] = {}
            changed = []
            for i, exp in enumerate(netspecs):
                key = f'net{i}'
                cur = (existing_cfg or {}).get(key)
                if cur is not None and _net_spec_matches(cur, exp):
                    continue
                # Correct mismatch or create missing.
                to_set[key] = _build_corrected_net_spec(cur, exp)
                changed.append(key)

            if not to_set and not delete_keys:
                return ('skipped', { 'index': idx, 'name': gen_name, 'vmid': vmid, 'node': node, 'reason': 'already correct' })

            payload: Dict[str, Any] = {}
            if delete_keys:
                payload['delete'] = ','.join([str(k) for k in delete_keys])
            for k, v in to_set.items():
                payload[str(k)] = str(v)
            if is_lxc:
                thread_client.set_lxc_options(node=node, vmid=vmid, options=payload)
            else:
                thread_client.set_qemu_options(node=node, vmid=vmid, options=payload)
            return ('ok', { 'index': idx, 'name': gen_name, 'vmid': vmid, 'node': node, 'changed': changed, 'deleted': delete_keys })
        except Exception as e:
            return ('error', { 'index': idx, 'name': gen_name, 'reason': f'set nets failed: {e}' })

    pool_workers = _pool_workers_for(proj, len(mapped))
    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
        future_map = { pool.submit(do_apply, m): m for m in mapped }
        for fut in as_completed(future_map):
            try:
                kind, payload = fut.result()
                if kind == 'ok':
                    updated.append(payload)
                    try:
                        node_name = str(payload.get('node') or '')
                        if node_name:
                            nodes_with_vm_changes.add(node_name)
                    except Exception:
                        pass
                elif kind == 'skipped':
                    skipped.append(payload)
                else:
                    errors.append(payload)
            except Exception as e:
                errors.append({ 'reason': f'network assign failed: {e}' })

    # 2) Apply node network reload once after the batch.
    # We reload if either:
    #   - we created bridges on the node, or
    #   - we changed VM netX config on the node (per user request to "apply" after enable/disable).
    nodes_to_reload = set(bridges_to_reload) | set(nodes_with_vm_changes)
    for node in sorted(nodes_to_reload):
        try:
            client.reload_network(node)
            network_applied_nodes.append(node)
        except Exception as e:
            network_apply_errors.append({ 'node': node, 'reason': f'network reload failed: {e}' })

    # Invalidate cached configs for VMs we changed so the post-action refresh reflects new adaptors.
    try:
        changed_entries = []
        for u in (updated or []):
            try:
                n = str((u or {}).get('node') or '')
                v = (u or {}).get('vmid')
                if n and v is not None:
                    changed_entries.append((n, int(v)))
            except Exception:
                continue
        _invalidate_vm_config_cache_entries(changed_entries)
    except Exception:
        pass

    _end_job(pid)
    return jsonify({ 'updated': updated, 'skipped': skipped, 'errors': errors, 'notices': notices, 'network_applied_nodes': network_applied_nodes, 'network_apply_errors': network_apply_errors })


@api_bp.route("/projects/<pid>/instances/actions/nets_remove", methods=["POST"])
@api_bp.route("/projects/<pid>/instances/actions/nets_clear", methods=["POST"])
def instances_nets_remove(pid: str):
    """Remove all configured network adaptors (netX entries) from selected VMs."""
    _start_job(pid, 'nets_remove')
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
    network_applied_nodes: List[str] = []
    network_apply_errors: List[Dict[str, Any]] = []
    nodes_with_vm_changes: Set[str] = set()

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
            # Remove all netX entries in one call.
            client.delete_qemu_options(node=node, vmid=vmid, keys=delete_keys)
            return ('cleared', { 'index': idx, 'name': gen_name, 'vmid': vmid, 'node': node, 'removed': delete_keys })
        except Exception as e:
            return ('error', { 'index': idx, 'name': gen_name, 'reason': f'clear nets failed: {e}' })

    pool_workers = _pool_workers_for(proj, len(mapped))
    with ThreadPoolExecutor(max_workers=pool_workers) as pool:
        future_map = { pool.submit(do_clear, m): m for m in mapped }
        for fut in as_completed(future_map):
            m = future_map[fut]
            try:
                kind, payload = fut.result()
                if kind == 'cleared':
                    cleared.append(payload)
                    try:
                        node_name = str(payload.get('node') or '')
                        if node_name:
                            nodes_with_vm_changes.add(node_name)
                    except Exception:
                        pass
                elif kind == 'skipped':
                    skipped.append(payload)
                else:
                    errors.append(payload)
            except Exception as e:
                if str(e) == 'cancelled':
                    errors.append({ 'reason': 'cancelled' })
                else:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'network clear failed: {e}' })

    # Apply network reload once per affected node when we actually removed interfaces.
    for node in sorted(nodes_with_vm_changes):
        try:
            client.reload_network(node)
            network_applied_nodes.append(node)
        except Exception as e:
            network_apply_errors.append({ 'node': node, 'reason': f'network reload failed: {e}' })

    # Invalidate cached configs for VMs we changed so the post-action refresh reflects new adaptors.
    try:
        changed_entries = []
        for c in (cleared or []):
            try:
                n = str((c or {}).get('node') or '')
                v = (c or {}).get('vmid')
                if n and v is not None:
                    changed_entries.append((n, int(v)))
            except Exception:
                continue
        _invalidate_vm_config_cache_entries(changed_entries)
    except Exception:
        pass

    _end_job(pid)
    return jsonify({ 'cleared': cleared, 'skipped': skipped, 'errors': errors, 'network_applied_nodes': network_applied_nodes, 'network_apply_errors': network_apply_errors })


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
                        existing_vms_by_name.setdefault(nm.lower(), []).append({ 'node': node_name, 'vmid': q.get('vmid'), 'name': nm, 'type': 'qemu' })
                    except Exception:
                        continue
                for c in client.list_lxc_vms(node_name) or []:
                    try:
                        nm = str(c.get('name') or c.get('hostname') or '')
                        if not nm:
                            continue
                        existing_vms_by_name.setdefault(nm.lower(), []).append({ 'node': node_name, 'vmid': c.get('vmid'), 'name': nm, 'type': 'lxc' })
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
    def _is_vm_in_project_notes(node_str: str, vmid_int: int) -> bool:
        return _vm_is_in_project_notes(client, proj, node_str, vmid_int)

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
            
            # Ensure AcostaPowerRollback role exists and assign it to the user on the POOL
            try:
                # Create role if missing (idempotent-ish)
                try:
                     # Privileges: Power mgmt + Rollback
                     client.create_role('AcostaPowerRollback', ['VM.Power.Start', 'VM.Power.Stop', 'VM.Power.Reset', 'VM.Power.Shutdown', 'VM.Snapshot.Rollback'])
                except Exception:
                     pass
                # Assign to pool
                if poolid:
                    if client.get_role('AcostaPowerRollback'):
                        client.set_acl_user_pool(userid, poolid, roles='AcostaPowerRollback', propagate=True)
            except Exception as e:
                # Log but don't fail the whole batch, it's an enhancement
                try:
                    current_app.logger.warning(f"Failed to set pool-level power permissions for {userid} on {poolid}: {e}")
                except Exception:
                    pass

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
                                    if not base_v:
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
                                if not _is_in_scenario(base_name) or not _is_vm_in_project_notes(m.get('node'), m.get('vmid')):
                                    continue
                                is_accessible = _is_user_accessible(base_name)
                                try:
                                    if current_app.config.get('ACL_DEBUG'):
                                        current_app.logger.info(f"[users_create][ACL] applying user={userid} vmid={m.get('vmid')} name={gen_name}")
                                except Exception:
                                    pass
                                try:
                                    # Ensure AcostaRollback role exists (Legacy but kept for direct VM assignment if needed)
                                    try:
                                        if not client.get_role('AcostaRollback'):
                                             client.create_role('AcostaRollback', ['VM.Snapshot.Rollback', 'VM.Audit', 'VM.PowerMgmt'])
                                    except Exception:
                                         pass  # Best effort
                                    
                                    # Ensure AcostaPowerRollback role exists for pool-wide operations (Power + Rollback)
                                    # We do this once per user/pool creation but also here to ensure it's available.
                                    try:
                                        if not client.get_role('AcostaPowerRollback'):
                                             client.create_role('AcostaPowerRollback', ['VM.Power.Start', 'VM.Power.Stop', 'VM.Power.Reset', 'VM.Power.Shutdown', 'VM.Snapshot.Rollback'])
                                    except Exception:
                                         pass

                                    # Grant AcostaPowerRollback on the POOL if not already done (idempotent driven by loop/check irrelevant)
                                    # Actually, do this once per USER/POOL creation block above, but we can do it here to be safe or just rely on the block below.
                                    # Let's add it to the initial pool creation block instead to be cleaner.
                                    
                                    # Remove conflicting roles explicitly to avoid wiping unrelated roles
                                    if is_accessible:
                                        roles_to_set = 'PVEUser'
                                        try:
                                             client.set_acl_user_vm(userid, int(m['vmid']), roles=roles_to_set, propagate=True)
                                        except Exception as e:
                                            msg_low = str(e).lower()
                                            if 'role' in msg_low and ('not found' in msg_low or 'no such' in msg_low or 'does not exist' in msg_low):
                                                 client.set_acl_user_vm(userid, int(m['vmid']), roles='PVEVMUser', propagate=True)
                                            else:
                                                raise
                                        # Delete the contrasting role explicitly
                                        for crole in ['AcostaRollback']:
                                            try:
                                                client.delete_acl_user_vm(userid, int(m['vmid']), roles=crole, propagate=True)
                                            except Exception:
                                                pass
                                    else:
                                        client.set_acl_user_vm(userid, int(m['vmid']), roles='AcostaRollback', propagate=True)
                                        # Delete the contrasting roles explicitly
                                        for crole in ['PVEUser', 'PVEVMUser']:
                                            try:
                                                client.delete_acl_user_vm(userid, int(m['vmid']), roles=crole, propagate=True)
                                            except Exception:
                                                pass

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
                            except Exception as e_outer:
                                errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'ACL processing failed: {e_outer}' })
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


@api_bp.route("/projects/<pid>/instances/actions/users_perms", methods=["POST"])
def instances_users_perms(pid: str):
    """Update Proxmox user permissions for selected instance credential usernames and VMs."""
    _start_job(pid, 'users_perms')
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
    
    by_index = {}
    for m in mapped:
        by_index.setdefault(int(m['index']), []).append(m)
    indices = sorted({ int((t or {}).get('index', 0)) for t in (targets or []) if (t or {}).get('index') })
    
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
                        existing_vms_by_name.setdefault(nm.lower(), []).append({ 'node': node_name, 'vmid': q.get('vmid'), 'name': nm, 'type': 'qemu' })
                    except Exception:
                        continue
                for c in client.list_lxc_vms(node_name) or []:
                    try:
                        nm = str(c.get('name') or c.get('hostname') or '')
                        if not nm:
                            continue
                        existing_vms_by_name.setdefault(nm.lower(), []).append({ 'node': node_name, 'vmid': c.get('vmid'), 'name': nm, 'type': 'lxc' })
                    except Exception:
                        continue
            except Exception:
                continue
    except Exception:
        pass
        
    updated_users = []
    added_members = []
    notices = []
    rollback_for_non_viewable = bool(getattr(proj, 'proxmox_assign_rollback_on_non_viewable', True))
    notice_keys = set()
    def _add_notice_once(item):
        try:
            key = str((item or {}).get('reason', '') or item)
            if key not in notice_keys:
                notices.append(item)
                notice_keys.add(key)
        except Exception:
            notices.append(item)
            
    tag_local = str(proj.tag or '').strip()
    def _base_from_generated(gen_name: str, idx: int) -> str:
        try:
            suf = f"{tag_local}{idx}"
            if gen_name and gen_name.endswith(suf):
                return gen_name[:len(gen_name)-len(suf)]
        except Exception:
            pass
        return gen_name
        
    def _is_in_scenario(base_name: str) -> bool:
        try:
            for v in (proj.vms or []):
                if isinstance(v, dict):
                    if str(v.get('name') or '') == str(base_name or ''):
                        return True
                else:
                    if str(getattr(v, 'name', '') or '') == str(base_name or ''):
                        return True
        except Exception:
            return False
        return False
        
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
        
    def _is_vm_in_project_notes(node_str: str, vmid_int: int) -> bool:
        return _vm_is_in_project_notes(client, proj, node_str, vmid_int)
        
    for idx in indices:
        mlist = by_index.get(idx, [])
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
            
            # Check user
            existing_user = None
            try:
                existing_user = client.get_user(userid)
            except Exception:
                pass
                
            if existing_user is None:
                errors.append({ 'index': idx, 'reason': f'User {userid} does not exist, cannot set perms' })
                continue
                
            updated_users.append({ 'index': idx, 'userid': userid })
            
            # Ensure AcostaPowerRollback role exists and assign it to the user on the POOL
            try:
                try:
                    client.create_role('AcostaPowerRollback', ['VM.Power.Start', 'VM.Power.Stop', 'VM.Power.Reset', 'VM.Power.Shutdown', 'VM.Snapshot.Rollback'])
                except Exception:
                    pass
                if poolid:
                    if client.get_role('AcostaPowerRollback'):
                        client.set_acl_user_pool(userid, poolid, roles='AcostaPowerRollback', propagate=True)
            except Exception as e:
                try:
                    current_app.logger.warning(f"Failed to set pool-level power permissions for {userid} on {poolid}: {e}")
                except Exception:
                    pass

            # Add members to pool
            if poolid:
                for m in (mlist or []):
                    dbg = []
                    try:
                        client.add_pool_member(poolid, int(m['vmid']))
                        added_members.append({ 'index': idx, 'pool': poolid, 'vmid': int(m['vmid']), 'name': m['name'], 'debug': dbg + [f"add_pool_member: success pool={poolid} vmid={int(m['vmid'])}"] })
                    except Exception as e:
                        msg = str(e)
                        if ' 501' in msg or 'not implemented' in msg.lower():
                            vm_node = None
                            try:
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
                                except Exception as e2:
                                    notices.append({ 'index': idx, 'reason': f'pool members endpoint unsupported; VM-config fallback failed for VM {m.get("vmid")}: {e2}' })
                            else:
                                notices.append({ 'index': idx, 'reason': 'pool members endpoint unsupported; unable to locate VM node for VM-config fallback' })
                        else:
                            errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'add member failed: {e}' })

            # Set VM-level permissions
            try:
                applied = 0
                unsupported = False
                acl_targets = list(mlist or [])
                try:
                    existing_names_set = { str(m.get('name') or '') for m in acl_targets }
                    for v in (proj.vms or []):
                        try:
                            if isinstance(v, dict):
                                viewable = bool(v.get('viewable_to_user'))
                                base_v = str(v.get('name') or '')
                            else:
                                viewable = bool(getattr(v, 'viewable_to_user', False))
                                base_v = str(getattr(v, 'name', '') or '')
                            if not base_v:
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
                        if not _is_in_scenario(base_name) or not _is_vm_in_project_notes(m.get('node'), m.get('vmid')):
                            continue
                        is_accessible = _is_user_accessible(base_name)
                        try:
                            _ensure_proxmox_role(client, 'AcostaPowerRollback', ['VM.Power.Start', 'VM.Power.Stop', 'VM.Power.Reset', 'VM.Power.Shutdown', 'VM.Snapshot.Rollback'])
                            _reconcile_vm_access_roles(
                                client,
                                userid,
                                int(m['vmid']),
                                accessible=is_accessible,
                                rollback_enabled=rollback_for_non_viewable,
                                current_roles=None,
                            )
                            applied += 1
                        except Exception as e2:
                            if '501' in str(e2) and 'not implemented' not in str(e2).lower():
                                errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'ACL permission issue (501) applying user {userid}: {e2}' })
                            elif 'not implemented' in str(e2).lower():
                                unsupported = True
                            else:
                                errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'per-VM ACL failed: {e2}' })
                    except Exception as e_outer:
                        errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'ACL processing failed: {e_outer}' })
                        
                if applied:
                    acl_mode = 'user-access/rollback' if rollback_for_non_viewable else 'user-access only'
                    _add_notice_once({ 'index': idx, 'reason': f'applied per-VM ACL to {applied} VM(s) ({acl_mode})' })
                if unsupported and applied == 0:
                    _add_notice_once({ 'index': idx, 'reason': 'ACL endpoints unsupported; skipped ACLs' })
            except Exception as e:
                errors.append({ 'index': idx, 'reason': f'ACL setup failed: {e}' })
        except Exception as e:
            errors.append({ 'index': idx, 'reason': f'users_perms failed: {e}' })
    _end_job(pid)
    return jsonify({ 'updated_users': updated_users, 'added_members': added_members, 'skipped': skipped, 'errors': errors, 'notices': notices })


@api_bp.route("/projects/<pid>/instances/actions/users_creds_check", methods=["POST"])
def instances_users_creds_check(pid: str):
    """Audit participant credential, pool, and VM access drift for selected rows."""
    _start_job(pid, 'users_creds_check')
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

    client = ProxmoxClient(base_url=base_url, token=getattr(proj, 'proxmox_api_token', '') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)

    rollback_for_non_viewable = bool(getattr(proj, 'proxmox_assign_rollback_on_non_viewable', True))
    tag_local = str(proj.tag or '').strip()
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

    vm_accessibility: Dict[str, bool] = {}
    try:
        for vm_cfg in (proj.vms or []):
            if isinstance(vm_cfg, dict):
                base_name = str(vm_cfg.get('name') or '').strip()
                viewable = bool(vm_cfg.get('viewable_to_user'))
            else:
                base_name = str(getattr(vm_cfg, 'name', '') or '').strip()
                viewable = bool(getattr(vm_cfg, 'viewable_to_user', False))
            if base_name:
                vm_accessibility[base_name] = viewable
    except Exception:
        vm_accessibility = {}

    def _base_from_generated(gen_name: str, idx: int) -> str:
        try:
            suffix = f"{tag_local}{idx}"
            if gen_name and suffix and gen_name.endswith(suffix):
                return gen_name[:len(gen_name) - len(suffix)]
        except Exception:
            pass
        return str(gen_name or '')

    acl_index: Dict[tuple, Set[str]] = {}
    acl_index_ok = False
    try:
        for entry in (client.list_acls() or []):
            try:
                ugid = str(entry.get('ugid') or '').strip()
                path = str(entry.get('path') or '').strip()
                roleid = str(entry.get('roleid') or '').strip()
                if not ugid or not path or not roleid:
                    continue
                if not path.startswith('/'):
                    path = f"/{path}"
                acl_index.setdefault((ugid, path), set()).add(roleid)
            except Exception:
                continue
        acl_index_ok = True
    except Exception as e:
        _add_notice_once({ 'reason': f'ACL audit unavailable: {e}' })

    user_exists_cache: Dict[str, bool] = {}
    password_check_cache: Dict[int, Dict[str, Any]] = {}
    pool_exists_cache: Dict[str, Optional[bool]] = {}
    pool_members_cache: Dict[str, Optional[Set[int]]] = {}
    checked = []

    for item in (mapped or []):
        try:
            idx = int(item.get('index') or 0)
            vmid = int(item.get('vmid'))
            node = str(item.get('node') or '')
            gen_name = str(item.get('name') or '')
        except Exception:
            continue

        cred = (proj.credentials or [])[idx - 1] if idx - 1 < len(proj.credentials or []) else None
        uname = str((cred or {}).get('username') or '').strip()
        upass = str((cred or {}).get('password') or '')
        if not uname:
            skipped.append({ 'index': idx, 'name': gen_name, 'reason': 'no credential username for instance' })
            continue

        userid = uname if '@' in uname else f"{uname}@pve"
        poolid = re.sub(r"[^A-Za-z0-9_-]+", "", str(uname).split('@', 1)[0])
        base_name = _base_from_generated(gen_name, idx)
        is_accessible = vm_accessibility.get(base_name, False)
        expected_access = 'user' if is_accessible else ('rollback' if rollback_for_non_viewable else 'none')
        issues = []

        try:
            if userid not in user_exists_cache:
                user_exists_cache[userid] = client.get_user(userid) is not None
            user_exists = user_exists_cache[userid]
            if not user_exists:
                issues.append('user missing')
        except Exception as e:
            errors.append({ 'index': idx, 'name': gen_name, 'reason': f'user lookup failed: {e}' })
            continue

        password_verified = None
        password_error = ''
        if upass:
            if idx not in password_check_cache:
                try:
                    verify_client = ProxmoxClient(base_url=base_url, username=userid, password=upass, verify=verify)
                    verify_client.list_nodes()
                    password_check_cache[idx] = { 'ok': True, 'error': '' }
                except Exception as e:
                    password_check_cache[idx] = { 'ok': False, 'error': str(e) }
            password_verified = bool(password_check_cache[idx].get('ok'))
            password_error = str(password_check_cache[idx].get('error') or '')
            if password_verified is False:
                issues.append('password login failed')
        else:
            issues.append('credential password missing')

        pool_exists = None
        pool_member = None
        if poolid:
            if poolid not in pool_exists_cache:
                try:
                    pool_exists_cache[poolid] = client.get_pool(poolid) is not None
                except Exception as e:
                    pool_exists_cache[poolid] = None
                    _add_notice_once({ 'index': idx, 'reason': f'pool lookup failed for {poolid}: {e}' })
            pool_exists = pool_exists_cache.get(poolid)
            if pool_exists is False:
                issues.append('pool missing')
            if pool_exists:
                if poolid not in pool_members_cache:
                    try:
                        vmids = set()
                        for member in (client.list_pool_members(poolid) or []):
                            try:
                                if str(member.get('type') or '').lower() == 'qemu' and member.get('vmid') is not None:
                                    vmids.add(int(member.get('vmid')))
                            except Exception:
                                continue
                        pool_members_cache[poolid] = vmids
                    except Exception as e:
                        pool_members_cache[poolid] = None
                        _add_notice_once({ 'index': idx, 'reason': f'pool member audit unavailable for {poolid}: {e}' })
                member_set = pool_members_cache.get(poolid)
                if member_set is not None:
                    pool_member = int(vmid) in member_set
                    if not pool_member:
                        issues.append('vm missing from pool')

        actual_roles = []
        if acl_index_ok:
            vm_path = f"/vms/{int(vmid)}"
            actual_roles = sorted(acl_index.get((userid, vm_path), set()))
            if expected_access == 'user':
                if not _has_user_access_role(actual_roles):
                    issues.append('missing user-access role')
                if 'AcostaRollback' in actual_roles:
                    issues.append('has rollback role unexpectedly')
            elif expected_access == 'rollback':
                if 'AcostaRollback' not in actual_roles:
                    issues.append('missing rollback role')
                if _has_user_access_role(actual_roles):
                    issues.append('has user-access role unexpectedly')
            else:
                if _has_user_access_role(actual_roles) or 'AcostaRollback' in actual_roles:
                    issues.append('has unexpected vm role')

        checked.append({
            'index': idx,
            'name': gen_name,
            'vmid': vmid,
            'node': node,
            'userid': userid,
            'pool': poolid,
            'user_exists': bool(user_exists),
            'password_verified': password_verified,
            'password_error': password_error,
            'pool_exists': pool_exists,
            'pool_member': pool_member,
            'expected_access': expected_access,
            'actual_roles': actual_roles,
            'status': 'ok' if not issues else 'drift',
            'reason': '; '.join(issues) if issues else 'in sync',
        })

    _end_job(pid)
    return jsonify({ 'checked': checked, 'skipped': skipped, 'errors': errors, 'notices': notices })


@api_bp.route("/projects/<pid>/instances/actions/users_creds_set", methods=["POST"])
def instances_users_creds_set(pid: str):
    """Explicitly sync Proxmox users, passwords, pool membership, and ACLs to the current credential list."""
    _start_job(pid, 'users_creds_set')
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

    client = ProxmoxClient(base_url=base_url, token=getattr(proj, 'proxmox_api_token', '') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)

    by_index = {}
    for item in mapped:
        by_index.setdefault(int(item['index']), []).append(item)
    indices = sorted({ int((t or {}).get('index', 0)) for t in (targets or []) if (t or {}).get('index') })

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
                        existing_vms_by_name.setdefault(nm.lower(), []).append({ 'node': node_name, 'vmid': q.get('vmid'), 'name': nm, 'type': 'qemu' })
                    except Exception:
                        continue
                for c in client.list_lxc_vms(node_name) or []:
                    try:
                        nm = str(c.get('name') or c.get('hostname') or '')
                        if not nm:
                            continue
                        existing_vms_by_name.setdefault(nm.lower(), []).append({ 'node': node_name, 'vmid': c.get('vmid'), 'name': nm, 'type': 'lxc' })
                    except Exception:
                        continue
            except Exception:
                continue
    except Exception:
        pass

    created_users = []
    updated_users = []
    created_pools = []
    added_members = []
    notices = []
    rollback_for_non_viewable = bool(getattr(proj, 'proxmox_assign_rollback_on_non_viewable', True))
    notice_keys = set()

    def _add_notice_once(item):
        try:
            key = str((item or {}).get('reason', '') or item)
            if key not in notice_keys:
                notices.append(item)
                notice_keys.add(key)
        except Exception:
            notices.append(item)

    tag_local = str(proj.tag or '').strip()

    def _base_from_generated(gen_name: str, idx: int) -> str:
        try:
            suffix = f"{tag_local}{idx}"
            if gen_name and gen_name.endswith(suffix):
                return gen_name[:len(gen_name) - len(suffix)]
        except Exception:
            pass
        return gen_name

    def _is_in_scenario(base_name: str) -> bool:
        try:
            for vm_cfg in (proj.vms or []):
                if isinstance(vm_cfg, dict):
                    if str(vm_cfg.get('name') or '') == str(base_name or ''):
                        return True
                else:
                    if str(getattr(vm_cfg, 'name', '') or '') == str(base_name or ''):
                        return True
        except Exception:
            return False
        return False

    def _is_user_accessible(base_name: str) -> bool:
        try:
            for vm_cfg in (proj.vms or []):
                if isinstance(vm_cfg, dict):
                    if str(vm_cfg.get('name') or '') == str(base_name or ''):
                        return bool(vm_cfg.get('viewable_to_user'))
                else:
                    if str(getattr(vm_cfg, 'name', '') or '') == str(base_name or ''):
                        return bool(getattr(vm_cfg, 'viewable_to_user', False))
        except Exception:
            return False
        return False

    def _is_vm_in_project_notes(node_str: str, vmid_int: int) -> bool:
        return _vm_is_in_project_notes(client, proj, node_str, vmid_int)

    for idx in indices:
        mlist = by_index.get(idx, [])
        if _is_cancelled(pid):
            errors.append({ 'reason': 'cancelled' })
            break
        try:
            cred = (proj.credentials or [])[idx - 1] if idx - 1 < len(proj.credentials or []) else None
            uname = (cred or {}).get('username') or ''
            upass = (cred or {}).get('password') or ''
            if not uname:
                errors.append({ 'index': idx, 'reason': 'no credential username for instance' })
                continue

            userid = f"{uname}@pve"
            poolid = re.sub(r"[^A-Za-z0-9_-]+", "", str(uname))

            existing_user = None
            try:
                existing_user = client.get_user(userid)
            except Exception as e:
                errors.append({ 'index': idx, 'reason': f'user lookup failed: {e}' })
                continue

            if existing_user is None:
                if not upass:
                    errors.append({ 'index': idx, 'reason': f'user {userid} is missing and credential password is empty' })
                    continue
                try:
                    client.create_user(userid, password=upass, enable=True, comment=f"Synced from project credentials for instance {idx}")
                    created_users.append({ 'index': idx, 'userid': userid })
                except Exception as e:
                    errors.append({ 'index': idx, 'reason': f'user create failed: {e}' })
                    continue
            else:
                try:
                    client.update_user(userid, password=upass or None, enable=True)
                    updated_users.append({ 'index': idx, 'userid': userid })
                except Exception as e:
                    errors.append({ 'index': idx, 'reason': f'user update failed: {e}' })
                    continue

            if not poolid:
                errors.append({ 'index': idx, 'reason': 'no pool id (credential username empty or invalid)' })
                continue

            try:
                existing_pool = client.get_pool(poolid)
                if existing_pool is None:
                    client.create_pool(poolid, comment=f"Synced from project credentials for {userid}")
                    created_pools.append({ 'index': idx, 'pool': poolid })
            except Exception as e:
                errors.append({ 'index': idx, 'reason': f'pool sync failed: {e}' })
                continue

            try:
                if poolid:
                    _ensure_proxmox_role(client, 'AcostaPowerRollback', ['VM.Power.Start', 'VM.Power.Stop', 'VM.Power.Reset', 'VM.Power.Shutdown', 'VM.Snapshot.Rollback'])
                    if client.get_role('AcostaPowerRollback'):
                        client.set_acl_user_pool(userid, poolid, roles='AcostaPowerRollback', propagate=True)
            except Exception as e:
                _add_notice_once({ 'index': idx, 'reason': f'pool power permissions sync failed for {userid}: {e}' })

            for m in (mlist or []):
                try:
                    client.add_pool_member(poolid, int(m['vmid']))
                    added_members.append({ 'index': idx, 'pool': poolid, 'vmid': int(m['vmid']), 'name': m['name'] })
                except Exception as e:
                    msg = str(e)
                    if ' 501' in msg or 'not implemented' in msg.lower():
                        vm_node = None
                        try:
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
                                added_members.append({ 'index': idx, 'pool': poolid, 'vmid': int(m['vmid']), 'name': m['name'], 'via': 'vm-config' })
                                _add_notice_once({ 'index': idx, 'reason': f'pool members endpoint unsupported; set VM {m.get("vmid")} pool via config' })
                            except Exception as e2:
                                notices.append({ 'index': idx, 'reason': f'pool members endpoint unsupported; VM-config fallback failed for VM {m.get("vmid")}: {e2}' })
                        else:
                            notices.append({ 'index': idx, 'reason': 'pool members endpoint unsupported; unable to locate VM node for VM-config fallback' })
                    else:
                        errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'add member failed: {e}' })

            try:
                applied = 0
                unsupported = False
                acl_targets = list(mlist or [])
                try:
                    existing_names_set = { str(m.get('name') or '') for m in acl_targets }
                    for vm_cfg in (proj.vms or []):
                        try:
                            if isinstance(vm_cfg, dict):
                                base_v = str(vm_cfg.get('name') or '')
                            else:
                                base_v = str(getattr(vm_cfg, 'name', '') or '')
                            if not base_v:
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
                        if not _is_in_scenario(base_name) or not _is_vm_in_project_notes(m.get('node'), m.get('vmid')):
                            continue
                        is_accessible = _is_user_accessible(base_name)
                        try:
                            _ensure_proxmox_role(client, 'AcostaPowerRollback', ['VM.Power.Start', 'VM.Power.Stop', 'VM.Power.Reset', 'VM.Power.Shutdown', 'VM.Snapshot.Rollback'])
                            _reconcile_vm_access_roles(
                                client,
                                userid,
                                int(m['vmid']),
                                accessible=is_accessible,
                                rollback_enabled=rollback_for_non_viewable,
                                current_roles=None,
                            )
                            applied += 1
                        except Exception as e2:
                            if '501' in str(e2) and 'not implemented' not in str(e2).lower():
                                errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'ACL permission issue (501) applying user {userid}: {e2}' })
                            elif 'not implemented' in str(e2).lower():
                                unsupported = True
                            else:
                                errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'per-VM ACL failed: {e2}' })
                    except Exception as e_outer:
                        errors.append({ 'index': idx, 'name': m.get('name'), 'reason': f'ACL processing failed: {e_outer}' })

                if applied:
                    acl_mode = 'user-access/rollback' if rollback_for_non_viewable else 'user-access only'
                    _add_notice_once({ 'index': idx, 'reason': f'synced credentials and ACLs on {applied} VM(s) ({acl_mode})' })
                if unsupported and applied == 0:
                    _add_notice_once({ 'index': idx, 'reason': 'ACL endpoints unsupported; skipped ACLs' })
            except Exception as e:
                errors.append({ 'index': idx, 'reason': f'ACL setup failed: {e}' })
        except Exception as e:
            errors.append({ 'index': idx, 'reason': f'users_creds_set failed: {e}' })

    _end_job(pid)
    return jsonify({
        'created_users': created_users,
        'updated_users': updated_users,
        'created_pools': created_pools,
        'added_members': added_members,
        'skipped': skipped,
        'errors': errors,
        'notices': notices,
    })


def _delete_proxmox_users_and_pools_for_indices(proj: Project, client: ProxmoxClient, indices: Iterable[int]) -> Dict[str, Any]:
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

    safe_indices = []
    for raw_idx in indices or []:
        try:
            idx = int(raw_idx)
        except Exception:
            continue
        if idx > 0 and idx not in safe_indices:
            safe_indices.append(idx)

    for idx in safe_indices:
        try:
            cred = (proj.credentials or [])[idx - 1] if idx - 1 < len(proj.credentials or []) else None
            uname = (cred or {}).get('username') or ''
            if not uname:
                errors.append({ 'index': idx, 'reason': 'no credential username for instance' })
                continue
            userid = f"{uname}@pve"
            poolid = re.sub(r"[^A-Za-z0-9_-]+", "", str(uname))
            try:
                if poolid:
                    pool_exists = False
                    try:
                        pool_exists = bool(client.get_pool(poolid) is not None)
                    except Exception as ge:
                        msg = str(ge).lower()
                        if 'not found' in msg or 'no such' in msg or 'does not exist' in msg or ' 404' in msg:
                            pool_exists = False
                        else:
                            pool_exists = False
                    if not pool_exists:
                        _add_notice_once({ 'index': idx, 'reason': f'pool delete skipped: pool "{poolid}" does not exist' })
                    else:
                        try:
                            client.delete_all_acls_for_path(f"/pool/{poolid}")
                        except Exception:
                            pass
                        try:
                            client.delete_acl_user_pool(userid, poolid, roles='PVEVMUser', propagate=True)
                        except Exception as e:
                            if ' 501' in str(e) or 'not implemented' in str(e).lower():
                                _add_notice_once({ 'index': idx, 'reason': 'ACL delete unsupported; continuing' })
                            else:
                                _add_notice_once({ 'index': idx, 'reason': f'ACL delete failed: {e}' })
                        vm_refs = []
                        try:
                            current_members = list(client.list_pool_members(poolid) or [])
                            for m in current_members:
                                if str(m.get('type') or '').lower() != 'qemu' or m.get('vmid') is None:
                                    continue
                                vmid_int = int(m.get('vmid'))
                                try:
                                    client.remove_pool_member(poolid, vmid_int)
                                except Exception as me:
                                    if ' 501' in str(me) or 'not implemented' in str(me).lower():
                                        vm_refs.append(vmid_int)
                                    else:
                                        vm_refs.append(vmid_int)
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
                            pass
                        if vm_refs:
                            try:
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

    return { 'deleted_users': deleted_users, 'deleted_pools': deleted_pools, 'errors': errors, 'notices': notices }


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
    indices = sorted({ int((t or {}).get('index', 0)) for t in targets if (t or {}).get('index') })
    resp = _delete_proxmox_users_and_pools_for_indices(proj, client, indices)
    _end_job(pid)
    return jsonify(resp)


@api_bp.route("/projects/<pid>/instances/actions/users_access_sync", methods=["POST"])
def instances_users_access_sync(pid: str):
    """Sync per-VM ACLs to match the current user accessibility setting.

    This is used after toggling `viewable_to_user` so users immediately gain/lose
    access to affected VMs in Proxmox.

        Body:
            - templates: ["baseTemplateName", ...]
            - enable: bool
            - indices: [1, 2, ...] (optional; when provided, only sync those instance rows)
      - proxmox connection fields: baseUrl, apiPort, verifySSL, username/password (optional if API token configured)
    """
    _start_job(pid, 'users_access_sync')
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    body = request.get_json(force=True) or {}
    enable = bool(body.get('enable'))
    templates = body.get('templates') or []
    if not isinstance(templates, list) or not templates:
        return jsonify({"error": "No templates provided"}), 400
    # Normalize templates to non-empty strings
    norm_templates: List[str] = []
    for t in templates:
        try:
            name = str(t or '').strip()
        except Exception:
            name = ''
        if name:
            norm_templates.append(name)
    # De-dupe while preserving order
    seen_tpl = set()
    norm_templates = [t for t in norm_templates if not (t in seen_tpl or seen_tpl.add(t))]
    if not norm_templates:
        return jsonify({"error": "No templates provided"}), 400

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
    if not base_url or (not (username and password) and not getattr(proj, 'proxmox_api_token', '')):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400

    client = ProxmoxClient(
        base_url=base_url,
        token=getattr(proj, 'proxmox_api_token', '') or None,
        username=username,
        password=password,
        verify=verify,
    )

    def _norm_userid(uname: str) -> str:
        u = str(uname or '').strip()
        if not u:
            return ''
        return u if '@' in u else f"{u}@pve"

    def _poolid_from_uname(uname: str) -> str:
        base = str(uname or '').strip().split('@', 1)[0]
        return re.sub(r"[^A-Za-z0-9_-]+", "", base)

    tag_local = str(proj.tag or '').strip()
    total_instances = int(getattr(proj, 'instances', 0) or 0)
    if total_instances < 1:
        total_instances = 1

    vm_accessibility = {}
    try:
        for vm_cfg in (proj.vms or []):
            if isinstance(vm_cfg, dict):
                base_name = str(vm_cfg.get('name') or '').strip()
                viewable = bool(vm_cfg.get('viewable_to_user'))
            else:
                base_name = str(getattr(vm_cfg, 'name', '') or '').strip()
                viewable = bool(getattr(vm_cfg, 'viewable_to_user', False))
            if base_name:
                vm_accessibility[base_name] = viewable
    except Exception:
        vm_accessibility = {}

    def _base_from_generated(gen_name: str, idx: int) -> str:
        try:
            suffix = f"{tag_local}{idx}"
            if gen_name and suffix and gen_name.endswith(suffix):
                return gen_name[:len(gen_name) - len(suffix)]
        except Exception:
            pass
        return str(gen_name or '')

    # If indices were provided, only sync those instance rows; otherwise default to all.
    indices_in = body.get('indices')
    indices: List[int] = []
    if isinstance(indices_in, list) and indices_in:
        for raw in indices_in:
            try:
                idx = int(raw)
            except Exception:
                continue
            if 1 <= idx <= total_instances:
                indices.append(idx)
        # De-dupe while preserving order
        seen_idx = set()
        indices = [i for i in indices if not (i in seen_idx or seen_idx.add(i))]
    if not indices:
        indices = list(range(1, total_instances + 1))

    # Build target list: for each template, sync only the selected indices.
    targets = []
    for base in norm_templates:
        for idx in indices:
            targets.append({ 'index': idx, 'name': f"{base}{tag_local}{idx}" })

    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)

    applied: List[Dict[str, Any]] = []
    unchanged: List[Dict[str, Any]] = []
    infos: List[Dict[str, Any]] = []
    rollback_for_non_viewable = bool(getattr(proj, 'proxmox_assign_rollback_on_non_viewable', True))

    # Cache: userid -> exists?
    user_exists_cache: Dict[str, bool] = {}

    # Build an index of existing ACL roles so we can:
    # - avoid re-applying already-granted permissions (mark as unchanged)
    # - avoid slow per-VM calls when nothing needs changing
    existing_roles: Dict[tuple, set] = {}
    have_acl_index = False
    try:
        entries = client.list_acls() or []
        for e in entries:
            try:
                ugid = str(e.get('ugid') or '').strip()
                path = str(e.get('path') or '').strip()
                roleid = str(e.get('roleid') or '').strip()
                if not ugid or not path or not roleid:
                    continue
                if not path.startswith('/'):
                    path = f"/{path}"
                key = (ugid, path)
                if key not in existing_roles:
                    existing_roles[key] = set()
                existing_roles[key].add(roleid)
            except Exception:
                continue
        have_acl_index = True
    except Exception:
        have_acl_index = False

    # Sync permissions for each mapped VM
    for m in (mapped or []):
        try:
            idx = int(m.get('index') or 0)
            vmid = int(m.get('vmid'))
            name = str(m.get('name') or '')
        except Exception:
            continue
        # Find credential username for this instance index
        try:
            cred = (proj.credentials or [])[idx-1] if idx-1 < len(proj.credentials or []) else None
            uname = (cred or {}).get('username') or ''
        except Exception:
            uname = ''
        if not uname:
            skipped.append({ 'index': idx, 'name': name, 'reason': 'no credential username for instance' })
            continue
        userid = _norm_userid(uname)
        poolid = None
        try:
            poolid = _poolid_from_uname(uname)
        except Exception:
            poolid = None
        # Only update permissions if the user exists (cache result for speed)
        try:
            if userid in user_exists_cache:
                exists = user_exists_cache[userid]
            else:
                user_rec = client.get_user(userid)
                exists = user_rec is not None
                user_exists_cache[userid] = exists
            if not exists:
                skipped.append({ 'index': idx, 'name': name, 'reason': f'user {userid} not found; skipping permission update' })
                continue
        except Exception as e:
            errors.append({ 'index': idx, 'name': name, 'reason': f'user lookup failed: {e}' })
            continue

        vm_path = f"/vms/{int(vmid)}"
        current_roles = existing_roles.get((userid, vm_path), set()) if have_acl_index else None
        base_name = _base_from_generated(name, idx)
        accessible = vm_accessibility.get(base_name, enable)

        try:
            needs_change = True
            if current_roles is not None:
                if accessible:
                    needs_change = (not _has_user_access_role(current_roles)) or ('AcostaRollback' in current_roles)
                else:
                    if rollback_for_non_viewable:
                        needs_change = _has_user_access_role(current_roles) or ('AcostaRollback' not in current_roles)
                    else:
                        needs_change = _has_user_access_role(current_roles) or ('AcostaRollback' in current_roles)
            if not needs_change:
                unchanged.append({ 'index': idx, 'name': name, 'vmid': vmid, 'userid': userid, 'reason': 'permissions already synchronized' })
            else:
                result = _reconcile_vm_access_roles(
                    client,
                    userid,
                    vmid,
                    accessible=accessible,
                    rollback_enabled=rollback_for_non_viewable,
                    current_roles=current_roles,
                )
                if have_acl_index:
                    try:
                        existing_roles[(userid, vm_path)] = set(result.get('current_roles') or set())
                    except Exception:
                        pass
                if result.get('granted') or result.get('removed'):
                    applied.append({
                        'index': idx,
                        'name': name,
                        'vmid': vmid,
                        'userid': userid,
                        'action': 'grant' if accessible else 'reconcile',
                        'role': result.get('granted'),
                        'roles_removed': result.get('removed') or [],
                    })
                else:
                    unchanged.append({ 'index': idx, 'name': name, 'vmid': vmid, 'userid': userid, 'reason': 'permissions already synchronized' })

                # Legacy cleanup: older setups may grant access via pool ACLs.
                # Best-effort revoke on the pool path so disabled accessibility truly removes visibility.
                try:
                    if poolid:
                        for role in ('PVEUser', 'PVEVMUser'):
                            try:
                                client.delete_acl_user_pool(userid, poolid, roles=role, propagate=True)
                            except Exception:
                                continue
                except Exception:
                    pass
        except Exception as e:
            errors.append({ 'index': idx, 'name': name, 'vmid': vmid, 'reason': f'Permission update failed: {e}' })

    # Add an informational message to make result intent clear
    try:
        infos.append({
            'reason': f"Permissions synced for selected rows only ({len(indices)} row(s), {len(norm_templates)} template(s))."
        })
        infos.append({
            'reason': 'Non-viewable VM rollback ACLs are ' + ('enabled.' if rollback_for_non_viewable else 'disabled.')
        })
    except Exception:
        pass

    _end_job(pid)
    return jsonify({
        'templates': norm_templates,
        'indices': indices,
        'enable': enable,
        'applied': applied,
        'unchanged': unchanged,
        'skipped': skipped,
        'errors': errors,
        'infos': infos,
    })


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
    DEFAULT_CMD_TIMEOUT = 300
    MAX_CMD_TIMEOUT = 86400

    def _coerce_timeout(value: Any) -> int:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return DEFAULT_CMD_TIMEOUT
        if num <= 0:
            return DEFAULT_CMD_TIMEOUT
        try:
            num = int(round(num))
        except Exception:
            num = int(num)
        if num > MAX_CMD_TIMEOUT:
            num = MAX_CMD_TIMEOUT
        return num

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
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
            if norm in {'true', '1', 'yes', 'on', 'enabled', 'long', 'longrunning'}:
                return True
            if norm in {'false', '0', 'no', 'off', 'disabled', 'short', 'standard'}:
                return False
        return bool(value)

    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    ran = []
    zip_entries = []
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
        steps = sanitize_start_command_steps(getattr(vcfg, 'start_commands', [])) if vcfg else []

        def extract_enabled_commands(step_obj):
            commands_out = []
            for cmd_obj in getattr(step_obj, 'commands', []) or []:
                enabled = True
                command_text = ''
                long_running = False
                timeout_seconds = DEFAULT_CMD_TIMEOUT
                if hasattr(cmd_obj, 'command'):
                    command_text = getattr(cmd_obj, 'command', '')
                    enabled = getattr(cmd_obj, 'enabled', True)
                    long_running = _coerce_bool_flag(getattr(cmd_obj, 'long_running', False), False)
                    timeout_seconds = _coerce_timeout(getattr(cmd_obj, 'timeout_seconds', DEFAULT_CMD_TIMEOUT))
                elif isinstance(cmd_obj, dict):
                    command_text = cmd_obj.get('command') or cmd_obj.get('cmd') or ''
                    enabled = cmd_obj.get('enabled', True)
                    if enabled is None and cmd_obj.get('disabled') is not None:
                        enabled = not cmd_obj.get('disabled')
                    long_hint = cmd_obj.get('long_running')
                    if long_hint is None:
                        for key in ('longRunning', 'longrun', 'long', 'isLongRunning'):
                            if key in cmd_obj:
                                long_hint = cmd_obj.get(key)
                                break
                    timeout_hint = cmd_obj.get('timeout_seconds')
                    if timeout_hint is None:
                        for key in ('timeoutSeconds', 'timeout', 'timeout_sec', 'timeoutSec'):
                            if key in cmd_obj:
                                timeout_hint = cmd_obj.get(key)
                                break
                    long_running = _coerce_bool_flag(long_hint, False)
                    timeout_seconds = _coerce_timeout(timeout_hint)
                else:
                    command_text = cmd_obj
                try:
                    command_text = str(command_text).strip()
                except Exception:
                    command_text = ''
                if not command_text:
                    continue
                if enabled is False:
                    continue
                commands_out.append({
                    'text': command_text,
                    'long_running': bool(long_running),
                    'timeout_seconds': timeout_seconds,
                })
            return commands_out

        total_commands = sum(len(extract_enabled_commands(step)) for step in steps)
        if not total_commands:
            skipped.append({ 'index': m['index'], 'name': m['name'], 'reason': 'no startup commands configured' })
            continue

        LOG.info(
            "run_startup_cmds guest agent check project=%s node=%s vmid=%s index=%s name=%s",
            pid,
            m.get('node'),
            m.get('vmid'),
            m.get('index'),
            m.get('name'),
        )
        try:
            client.ensure_guest_agent_ready(node=m['node'], vmid=m['vmid'])
        except GuestAgentUnavailableError as exc:
            msg = str(exc).strip() or 'Guest agent is not available'
            errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'guest agent unavailable: {msg}' })
            continue
        except Exception as exc:
            errors.append({ 'index': m['index'], 'name': m['name'], 'reason': f'guest agent check failed: {exc}' })
            continue
        LOG.info(
            "run_startup_cmds guest agent ready project=%s node=%s vmid=%s index=%s name=%s",
            pid,
            m.get('node'),
            m.get('vmid'),
            m.get('index'),
            m.get('name'),
        )

        preview_limit = 1000

        def _make_preview(raw_value: Any):
            text = ''
            trimmed = False
            try:
                if raw_value is None:
                    text = ''
                elif isinstance(raw_value, str):
                    text = raw_value
                else:
                    text = str(raw_value)
            except Exception:
                text = ''
            if len(text) > preview_limit:
                trimmed = True
                text = text[:preview_limit] + f"... [trimmed to {preview_limit} chars; see ZIP for full output]"
            return text, trimmed

        def record_zip_entry(step_idx: int, cmd_idx: int, step_delay: float, result_dict: Dict[str, Any], err_msg: Optional[str]):
            stdout_full = result_dict.pop('stdout_full', '') if isinstance(result_dict, dict) else ''
            stderr_full = result_dict.pop('stderr_full', '') if isinstance(result_dict, dict) else ''
            if not isinstance(stdout_full, str):
                try:
                    stdout_full = str(stdout_full)
                except Exception:
                    stdout_full = ''
            if not isinstance(stderr_full, str):
                try:
                    stderr_full = str(stderr_full)
                except Exception:
                    stderr_full = ''
            try:
                command_text = str(result_dict.get('cmd', '') if isinstance(result_dict, dict) else '')
            except Exception:
                command_text = ''
            error_text = ''
            if err_msg:
                try:
                    error_text = str(err_msg).strip()
                except Exception:
                    error_text = str(err_msg)
            zip_entries.append({
                'vm_name': m.get('name'),
                'vm_index': m.get('index'),
                'node': m.get('node'),
                'vmid': m.get('vmid'),
                'step': int(step_idx) + 1,
                'command_index': int(cmd_idx) + 1,
                'delay': float(step_delay or 0.0),
                'command': command_text,
                'exitcode': result_dict.get('exitcode') if isinstance(result_dict, dict) else None,
                'stdout': stdout_full or '',
                'stderr': stderr_full or '',
                'error': error_text,
                'timeout_seconds': result_dict.get('timeout_seconds') if isinstance(result_dict, dict) else None,
                'long_running': bool(result_dict.get('long_running')) if isinstance(result_dict, dict) else False,
            })

        def execute_single(command_entry: Dict[str, Any], meta: Optional[Dict[str, Any]] = None):
            if meta:
                _job_emit_command_status(
                    pid,
                    entry=m,
                    step=meta.get('step'),
                    command_idx=meta.get('command_index'),
                    command_text=meta.get('command_text'),
                    command_number=meta.get('command_number'),
                    command_total=meta.get('command_total'),
                    step_command_total=meta.get('step_command_total'),
                )
            command_text = command_entry.get('text') if isinstance(command_entry, dict) else command_entry
            if command_text is None:
                command_text = ''
            timeout_override = command_entry.get('timeout_seconds') if isinstance(command_entry, dict) else None
            timeout_value = _coerce_timeout(timeout_override)
            long_running_flag = bool(command_entry.get('long_running')) if isinstance(command_entry, dict) else False
            try:
                res = client.agent_exec(node=m['node'], vmid=m['vmid'], command=str(command_text), timeout=timeout_value)
                exitcode = res.get('exitcode', 1)
                out = res.get('stdout', '') or ''
                err = res.get('stderr', '') or ''
                out_preview, out_trimmed = _make_preview(out)
                err_preview, err_trimmed = _make_preview(err)
                return {
                    'cmd': str(command_text),
                    'exitcode': exitcode,
                    'stdout_full': out,
                    'stderr_full': err,
                    'stdout_preview': out_preview,
                    'stderr_preview': err_preview,
                    'stdout_trimmed': out_trimmed,
                    'stderr_trimmed': err_trimmed,
                    'preview_limit': preview_limit,
                    'timeout_seconds': timeout_value,
                    'long_running': long_running_flag,
                }, None
            except Exception as exc:
                err_text = str(exc)
                err_preview, err_trimmed = _make_preview(err_text)
                return {
                    'cmd': str(command_text),
                    'exitcode': None,
                    'stdout_full': '',
                    'stderr_full': err_text,
                    'stdout_preview': '',
                    'stderr_preview': err_preview,
                    'stdout_trimmed': False,
                    'stderr_trimmed': err_trimmed,
                    'preview_limit': preview_limit,
                    'timeout_seconds': timeout_value,
                    'long_running': long_running_flag,
                }, f'cmd error ({command_text}): {exc}'

        cmd_results = []
        executed_commands = 0
        cancelled = False
        for step_idx, step in enumerate(steps):
            if _is_cancelled(pid):
                cancelled = True
                break
            delay = float(step.delay_seconds or 0.0)
            if delay > 0:
                _job_emit_delay_status(pid, m, step_idx + 1, delay)
                _safe_sleep(delay)
            commands = extract_enabled_commands(step)
            if not commands:
                continue
            if len(commands) == 1:
                cmd_meta = commands[0]
                meta_info = {
                    'step': step_idx + 1,
                    'command_index': 1,
                    'command_text': cmd_meta.get('text') if isinstance(cmd_meta, dict) else cmd_meta,
                    'command_number': executed_commands + 1,
                    'command_total': total_commands,
                    'step_command_total': len(commands),
                }
                result, err_msg = execute_single(cmd_meta, meta_info)
                result.update({
                    'step': step_idx + 1,
                    'delay': delay,
                    'normalized': cmd_meta.get('normalized'),
                    'long_running': bool(cmd_meta.get('long_running')),
                    'timeout_seconds': cmd_meta.get('timeout_seconds'),
                })
                record_zip_entry(step_idx, 0, delay, result, err_msg)
                cmd_results.append(result)
                cmd_label = result.get('cmd', str(cmd_meta.get('text', '')))
                if err_msg:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': err_msg })
                elif result.get('exitcode') not in (0, None):
                    reason = f"cmd failed ({cmd_label}): {result.get('stderr_preview','')}"
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': reason })
                executed_commands += 1
                continue

            parallel_results = []
            with ThreadPoolExecutor(max_workers=len(commands)) as pool:
                futures = []
                base_seq = executed_commands
                step_command_total = len(commands)
                for order, command_meta in enumerate(commands):
                    meta_info = {
                        'step': step_idx + 1,
                        'command_index': order + 1,
                        'command_text': command_meta.get('text') if isinstance(command_meta, dict) else command_meta,
                        'command_number': base_seq + order + 1,
                        'command_total': total_commands,
                        'step_command_total': step_command_total,
                    }
                    futures.append((order, command_meta, pool.submit(execute_single, command_meta, meta_info)))
                for order, command_meta, future in futures:
                    try:
                        res_data, err_msg = future.result()
                    except Exception as exc:
                        err_text = str(exc)
                        err_preview, err_trimmed = _make_preview(err_text)
                        res_data = {
                            'cmd': str(command_meta.get('text')),
                            'exitcode': None,
                            'stdout_full': '',
                            'stderr_full': err_text,
                            'stdout_preview': '',
                            'stderr_preview': err_preview,
                            'stdout_trimmed': False,
                            'stderr_trimmed': err_trimmed,
                            'preview_limit': preview_limit,
                            'timeout_seconds': command_meta.get('timeout_seconds'),
                            'long_running': bool(command_meta.get('long_running')),
                        }
                        err_msg = f"cmd error ({command_meta.get('text')}): {exc}"
                    res_data['order'] = order
                    parallel_results.append((res_data, err_msg))
            parallel_results.sort(key=lambda entry: entry[0]['order'])
            for res_data, err_msg in parallel_results:
                order_idx = res_data.pop('order', 0)
                res_data.update({
                    'step': step_idx + 1,
                    'delay': delay,
                })
                record_zip_entry(step_idx, order_idx, delay, res_data, err_msg)
                cmd_results.append(res_data)
                cmd_label = res_data.get('cmd') or ''
                if err_msg:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': err_msg })
                elif res_data.get('exitcode') not in (0, None):
                    reason = f"cmd failed ({cmd_label}): {res_data.get('stderr_preview','')}"
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': reason })
            executed_commands += len(commands)

        if cancelled:
            errors.append({ 'index': m['index'], 'name': m['name'], 'reason': 'cancelled' })
            break
        ran.append({
            'index': m['index'],
            'name': m['name'],
            'vmid': m['vmid'],
            'node': m['node'],
            'steps': len(steps),
            'count': len(cmd_results),
            'planned_count': total_commands,
            'cmds': cmd_results
        })
    zip_payload = None
    if zip_entries:
        now = datetime.now(timezone.utc)
        timestamp = _format_ymdhms(now)
        safe_proj = _safe_file_stem(getattr(proj, 'name', '') or proj.id)
        filename = f"startup_cmd_outputs_{safe_proj}_{timestamp}.zip"
        buf = io.BytesIO()
        summary_entries = []
        with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for entry in zip_entries:
                vm_label = entry.get('vm_name') or f"vm_{entry.get('vm_index')}"
                safe_vm = _safe_file_stem(vm_label) or f"vm_{entry.get('vm_index') or 'unknown'}"
                step_dir = f"step_{int(entry.get('step', 0)):02d}"
                cmd_file = f"cmd_{int(entry.get('command_index', 0)):02d}.txt"
                file_path = f"{safe_vm}/{step_dir}/{cmd_file}"
                exitcode = entry.get('exitcode')
                lines = [
                    f"VM Name: {vm_label}",
                    f"VM Index: {entry.get('vm_index')}",
                    f"Node: {entry.get('node')}",
                    f"VMID: {entry.get('vmid')}",
                    f"Step: {entry.get('step')}",
                    f"Command Index: {entry.get('command_index')}",
                    f"Delay Before Step: {entry.get('delay')}",
                    f"Command: {entry.get('command')}",
                    f"Exit Code: {'' if exitcode is None else exitcode}"
                ]
                if entry.get('error'):
                    lines.append(f"Error: {entry.get('error')}")
                lines.extend([
                    '',
                    'STDOUT:',
                    entry.get('stdout') or '',
                    '',
                    'STDERR:',
                    entry.get('stderr') or ''
                ])
                zf.writestr(file_path, "\n".join(lines))
                summary_entries.append({
                    'vm_name': vm_label,
                    'step': entry.get('step'),
                    'command_index': entry.get('command_index'),
                    'command': entry.get('command'),
                    'exitcode': exitcode,
                    'error': entry.get('error'),
                    'stdout_chars': len(entry.get('stdout') or ''),
                    'stderr_chars': len(entry.get('stderr') or ''),
                    'timeout_seconds': entry.get('timeout_seconds'),
                    'long_running': bool(entry.get('long_running')), 
                })
            summary_doc = {
                'project_id': proj.id,
                'project_name': getattr(proj, 'name', ''),
                'generated_at': now.replace(microsecond=0).isoformat() + 'Z',
                'ran_hosts': len(ran),
                'skipped': skipped,
                'errors': errors,
                'commands': summary_entries
            }
            zf.writestr('summary.json', json.dumps(summary_doc, indent=2))
        zip_bytes = buf.getvalue()
        zip_payload = {
            'filename': filename,
            'size': len(zip_bytes),
            'base64': base64.b64encode(zip_bytes).decode('ascii')
        }

    response_payload: Dict[str, Any] = { 'ran': ran, 'skipped': skipped, 'errors': errors }
    if zip_payload:
        response_payload['outputs_zip'] = zip_payload
    if not ran:
        summary_lines = []
        for err in errors:
            label = ''
            reason_text = ''
            reason_value = None
            if isinstance(err, dict):
                label = (err.get('name') or err.get('index') or '')
                if err.get('step'):
                    try:
                        label = f"{label} step {err.get('step')}" if label else f"Step {err.get('step')}"
                    except Exception:
                        pass
                reason_value = err.get('reason')
            else:
                reason_value = err
            try:
                reason_text = str(reason_value).strip() if reason_value is not None else ''
            except Exception:
                reason_text = ''
            entry_text = f"{label}: {reason_text}" if label else reason_text
            if entry_text:
                summary_lines.append(entry_text)
        if summary_lines:
            response_payload['error_summary'] = summary_lines

    _end_job(pid)
    return jsonify(response_payload)


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
    def _normalize_command_text(raw: Any) -> str:
        try:
            text = str(raw or '')
        except Exception:
            text = ''
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        return text.strip()
    def _canonical_pid(value: Any) -> str:
        try:
            return str(value or '').strip()
        except Exception:
            return ''
    def _make_template_key(project_obj, vm_cfg_obj, base_name: str, generated_name: str) -> str:
        tmpl_name = getattr(vm_cfg_obj, 'template_name', None) or getattr(vm_cfg_obj, 'template', None) or getattr(vm_cfg_obj, 'name', None) or base_name or generated_name
        tmpl_id = getattr(vm_cfg_obj, 'template_id', None) or getattr(vm_cfg_obj, 'templateId', None) or getattr(vm_cfg_obj, 'template_vmid', None)
        return f"{_canonical_pid(getattr(project_obj, 'id', ''))}|{tmpl_name or base_name or generated_name}|{tmpl_id or ''}"
    DEFAULT_CMD_TIMEOUT = 300
    DEFAULT_VALIDATION_TIMEOUT = 10
    MAX_CMD_TIMEOUT = 86400

    def _coerce_timeout(value: Any, default: int = DEFAULT_CMD_TIMEOUT) -> int:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return default
        if num <= 0:
            return default
        try:
            num = int(round(num))
        except Exception:
            num = int(num)
        if num > MAX_CMD_TIMEOUT:
            num = MAX_CMD_TIMEOUT
        return num

    def _coerce_bool_flag(value: Any, default: bool = False) -> bool:
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
            if norm in {'true', '1', 'yes', 'on', 'enabled', 'long', 'longrunning'}:
                return True
            if norm in {'false', '0', 'no', 'off', 'disabled', 'short', 'standard'}:
                return False
        return bool(value)

    def _compile_validation_regex(pattern: str) -> Tuple[Optional[re.Pattern], Optional[str]]:
        text = str(pattern or '').strip()
        if not text:
            return None, 'missing regular expression'
        body = text
        flags = 0
        if len(text) >= 2 and text.startswith('/'):
            slash_idx = text.rfind('/')
            if slash_idx > 0:
                body = text[1:slash_idx]
                flag_part = text[slash_idx + 1:]
                for ch in flag_part:
                    if ch == 'i':
                        flags |= re.IGNORECASE
                    elif ch == 'm':
                        flags |= re.MULTILINE
                    elif ch == 's':
                        flags |= re.DOTALL
                    elif ch == 'x':
                        flags |= re.VERBOSE
                    elif ch:
                        return None, f"unsupported regex flag: {ch}"
        try:
            return re.compile(body, flags), None
        except re.error as exc:
            return None, f"invalid regex: {exc}"

    def _extract_validation_commands(vcfg_obj: Any) -> List[Dict[str, Any]]:
        raw = sanitize_validation_commands(getattr(vcfg_obj, 'validation_commands', [])) if vcfg_obj else []
        out: List[Dict[str, Any]] = []
        for order, entry in enumerate(raw, start=1):
            if not isinstance(entry, dict):
                continue
            cmd_text = _normalize_command_text(entry.get('command'))
            if not cmd_text:
                continue
            enabled = _coerce_bool_flag(entry.get('enabled'), True)
            if not enabled:
                continue
            match_expr = str(entry.get('match') or '').strip()
            timeout_seconds = _coerce_timeout(entry.get('timeout_seconds'), default=DEFAULT_VALIDATION_TIMEOUT)
            out.append({
                'order': order,
                'command': cmd_text,
                'match': match_expr,
                'timeout_seconds': timeout_seconds,
            })
        return out
    raw_override_list = body.get('storedCommandOverrides')
    override_lookup: Dict[Tuple[str, int, int], str] = {}
    if isinstance(raw_override_list, list):
        for entry in raw_override_list:
            if not isinstance(entry, dict):
                continue
            template_key = _canonical_pid(entry.get('templateKey'))
            try:
                step_idx = int(entry.get('stepIndex'))
                cmd_idx = int(entry.get('commandIndex'))
            except (TypeError, ValueError):
                continue
            override_text = _normalize_command_text(entry.get('text') or entry.get('command') or entry.get('override'))
            if not override_text:
                continue
            override_lookup[(template_key, step_idx, cmd_idx)] = override_text
    if not base_url or not (username and password) and not getattr(proj, 'proxmox_api_token', ''):
        return jsonify({"error": "Missing Proxmox URL and credentials (username/password or API token)"}), 400
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "No targets provided"}), 400
    raw_commands = body.get('commands')
    selected_commands: List[str] = []

    def _append_selected(raw_value: Any):
        normalized = _normalize_command_text(raw_value)
        if normalized and normalized not in selected_commands:
            selected_commands.append(normalized)

    if isinstance(raw_commands, (list, tuple, set)):
        for entry in raw_commands:
            _append_selected(entry)
    elif raw_commands is not None:
        _append_selected(raw_commands)
    _append_selected(body.get('command'))
    validate_only = _coerce_bool_flag(body.get('validateOnly'), False)
    if validate_only:
        selected_commands = []
        override_lookup = {}
    selected_commands_filter: Optional[Set[str]] = set(selected_commands) if selected_commands else None
    client = ProxmoxClient(base_url=base_url, token=getattr(proj,'proxmox_api_token','') or None, username=username, password=password, verify=verify)
    runtime_store = _runtime_store()
    mapped, skipped, errors = _resolve_targets_to_vm_info(proj, client, targets)
    total_mapped_targets = len(mapped)
    ran = []
    zip_entries: List[Dict[str, Any]] = []
    if validate_only and mapped:
        preview_limit = 1000

        def _make_preview(raw_value: Any) -> Tuple[str, bool]:
            text = ''
            trimmed = False
            try:
                if raw_value is None:
                    text = ''
                elif isinstance(raw_value, str):
                    text = raw_value
                else:
                    text = str(raw_value)
            except Exception:
                text = ''
            if len(text) > preview_limit:
                trimmed = True
                text = text[:preview_limit] + f"... [trimmed to {preview_limit} chars; see ZIP for full output]"
            return text, trimmed

        def _validate_target(position: int, m: Dict[str, Any]) -> Dict[str, Any]:
            if _is_cancelled(pid):
                return {'position': position, 'cancelled': True, 'errors': [], 'zip_entries': []}

            local_errors: List[Dict[str, Any]] = []
            local_zip_entries: List[Dict[str, Any]] = []

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
            active_validation_commands = _extract_validation_commands(vcfg)
            if not active_validation_commands:
                return {
                    'position': position,
                    'cancelled': False,
                    'skipped': {'index': m['index'], 'name': m['name'], 'reason': 'no validation commands configured'},
                    'errors': local_errors,
                    'zip_entries': local_zip_entries,
                }

            validation_results: List[Dict[str, Any]] = []
            validation_all_passed = True

            for vpos, vcmd in enumerate(active_validation_commands, start=1):
                if _is_cancelled(pid):
                    return {'position': position, 'cancelled': True, 'errors': local_errors, 'zip_entries': local_zip_entries}

                v_command = str(vcmd.get('command') or '').strip()
                v_match = str(vcmd.get('match') or '').strip()
                v_timeout = _coerce_timeout(vcmd.get('timeout_seconds'))

                try:
                    _update_job_detail(
                        pid,
                        phase='validation',
                        current=_format_vm_label(m),
                        step=vpos,
                        total_steps=len(active_validation_commands),
                        message=(
                            f"Running on {position + 1}/{total_mapped_targets} VM(s): "
                            f"validating command {vpos}/{len(active_validation_commands)} on {_format_vm_label(m)}"
                        ),
                        detail={
                            'kind': 'validation',
                            'running_on': {'current': position + 1, 'total': total_mapped_targets},
                            'vm': _format_vm_label(m),
                            'step': vpos,
                            'command_number': vpos,
                            'command_total': len(active_validation_commands),
                            'command': _shorten_command_text(v_command),
                            'match': v_match,
                            'timeout_seconds': v_timeout,
                        },
                    )
                except Exception:
                    pass

                regex, compile_err = _compile_validation_regex(v_match)
                if compile_err:
                    validation_all_passed = False
                    reason = f"validation regex error ({v_command}): {compile_err}"
                    local_errors.append({
                        'index': m['index'],
                        'name': m['name'],
                        'command': v_command,
                        'reason': reason,
                    })
                    validation_results.append({
                        'order': vcmd.get('order'),
                        'command': v_command,
                        'match': v_match,
                        'timeout_seconds': v_timeout,
                        'passed': False,
                        'reason': compile_err,
                        'timed_out': False,
                        'exitcode': None,
                        'stdout_preview': '',
                        'stderr_preview': '',
                    })
                    local_zip_entries.append({
                        'vm_name': m.get('name'),
                        'vm_index': m.get('index'),
                        'node': m.get('node'),
                        'vmid': m.get('vmid'),
                        'step': 1,
                        'command_index': vpos,
                        'delay': 0.0,
                        'command': v_command,
                        'exitcode': None,
                        'stdout': '',
                        'stderr': compile_err,
                        'error': f"validation regex error: {compile_err}",
                        'timeout_seconds': v_timeout,
                        'long_running': False,
                    })
                    continue

                try:
                    res = client.agent_exec(
                        node=m['node'],
                        vmid=m['vmid'],
                        command=v_command,
                        timeout=v_timeout,
                        return_partial_on_timeout=True,
                    )
                except Exception as exc:
                    err_text = str(exc)
                    validation_all_passed = False
                    reason = f"validation command error ({v_command}): {exc}"
                    local_errors.append({
                        'index': m['index'],
                        'name': m['name'],
                        'command': v_command,
                        'reason': reason,
                    })
                    validation_results.append({
                        'order': vcmd.get('order'),
                        'command': v_command,
                        'match': v_match,
                        'timeout_seconds': v_timeout,
                        'passed': False,
                        'reason': err_text,
                        'timed_out': False,
                        'exitcode': None,
                        'stdout_preview': '',
                        'stderr_preview': err_text,
                    })
                    local_zip_entries.append({
                        'vm_name': m.get('name'),
                        'vm_index': m.get('index'),
                        'node': m.get('node'),
                        'vmid': m.get('vmid'),
                        'step': 1,
                        'command_index': vpos,
                        'delay': 0.0,
                        'command': v_command,
                        'exitcode': None,
                        'stdout': '',
                        'stderr': err_text,
                        'error': f"validation command error: {exc}",
                        'timeout_seconds': v_timeout,
                        'long_running': False,
                    })
                    continue

                stdout_text = res.get('stdout', '') or ''
                stderr_text = res.get('stderr', '') or ''
                merged = f"{stdout_text}\n{stderr_text}".strip('\n')
                matched = bool(regex.search(merged if isinstance(merged, str) else str(merged))) if regex else False
                timed_out = bool(res.get('timed_out'))
                out_preview, _ = _make_preview(stdout_text)
                err_preview, _ = _make_preview(stderr_text)
                if not matched:
                    validation_all_passed = False
                    if timed_out:
                        reason = f"validation regex did not match before timeout ({v_command})"
                    else:
                        reason = f"validation regex did not match output ({v_command})"
                    local_errors.append({
                        'index': m['index'],
                        'name': m['name'],
                        'command': v_command,
                        'reason': reason,
                    })
                validation_results.append({
                    'order': vcmd.get('order'),
                    'command': v_command,
                    'match': v_match,
                    'timeout_seconds': v_timeout,
                    'passed': matched,
                    'timed_out': timed_out,
                    'exitcode': res.get('exitcode'),
                    'stdout_preview': out_preview,
                    'stderr_preview': err_preview,
                })
                validation_err = None
                if not matched:
                    validation_err = 'validation regex did not match output'
                    if timed_out:
                        validation_err = 'validation regex did not match before timeout'
                local_zip_entries.append({
                    'vm_name': m.get('name'),
                    'vm_index': m.get('index'),
                    'node': m.get('node'),
                    'vmid': m.get('vmid'),
                    'step': 1,
                    'command_index': vpos,
                    'delay': 0.0,
                    'command': v_command,
                    'exitcode': res.get('exitcode'),
                    'stdout': stdout_text,
                    'stderr': stderr_text,
                    'error': validation_err,
                    'timeout_seconds': v_timeout,
                    'long_running': False,
                })

            try:
                runtime_store.set_vm_validation_state(
                    proj.id,
                    m.get('name'),
                    bool(validation_all_passed),
                    vmid=m.get('vmid'),
                    node=m.get('node'),
                )
            except Exception as exc:
                LOG.warning(
                    "Could not persist validation state for %s/%s (%s): %s",
                    m.get('node'),
                    m.get('vmid'),
                    m.get('name'),
                    exc,
                )

            ran_entry = {
                'index': m['index'],
                'name': m['name'],
                'vmid': m['vmid'],
                'node': m['node'],
                'steps': 0,
                'count': 0,
                'planned_count': 0,
                'cmds': [],
                'validation': {
                    'configured_count': len(active_validation_commands),
                    'all_passed': bool(validation_all_passed),
                    'results': validation_results,
                },
                'validate_only': True,
            }
            return {
                'position': position,
                'cancelled': False,
                'ran': ran_entry,
                'errors': local_errors,
                'zip_entries': local_zip_entries,
            }

        total_mapped = len(mapped)
        _job_emit_batch_progress(pid, 'validation', 'Validating', 0, total_mapped, message=f'Running on 0/{total_mapped} VM(s)')
        pool_workers = _pool_workers_for(proj, len(mapped))
        done_count = 0
        outcomes: List[Dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=pool_workers) as pool:
            future_map = {pool.submit(_validate_target, pos, m): (pos, m) for pos, m in enumerate(mapped)}
            for fut in as_completed(future_map):
                pos, m = future_map[fut]
                try:
                    outcome = fut.result()
                except Exception as exc:
                    outcome = {
                        'position': pos,
                        'cancelled': False,
                        'errors': [{
                            'index': m.get('index'),
                            'name': m.get('name'),
                            'reason': f'validation failed: {exc}',
                        }],
                        'zip_entries': [],
                    }
                outcomes.append(outcome)
                done_count += 1
                _job_emit_batch_progress(
                    pid,
                    'validation',
                    'Validating',
                    done_count,
                    total_mapped,
                    current=str(m.get('name') or ''),
                    message=f'Running on {done_count}/{total_mapped} VM(s)',
                )

        outcomes.sort(key=lambda item: int(item.get('position', 0)))
        for outcome in outcomes:
            if outcome.get('cancelled'):
                errors.append({'reason': 'cancelled'})
                break
            skipped_entry = outcome.get('skipped')
            if skipped_entry:
                skipped.append(skipped_entry)
            local_errors = outcome.get('errors') or []
            if local_errors:
                errors.extend(local_errors)
            local_zip_entries = outcome.get('zip_entries') or []
            if local_zip_entries:
                zip_entries.extend(local_zip_entries)
            ran_entry = outcome.get('ran')
            if ran_entry:
                ran.append(ran_entry)
        mapped = []

    for vm_position, m in enumerate(mapped, start=1):
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
        steps = sanitize_start_command_steps(getattr(vcfg, 'stored_commands', [])) if vcfg else []
        validation_commands = _extract_validation_commands(vcfg)
        template_key = _make_template_key(proj, vcfg, base, m.get('name'))

        def extract_enabled_commands(step_obj, match_commands: Optional[Set[str]] = None):
            commands_out = []
            for cmd_index, cmd_obj in enumerate(getattr(step_obj, 'commands', []) or [], start=1):
                enabled = True
                command_text = ''
                long_running = False
                timeout_seconds = DEFAULT_CMD_TIMEOUT
                if hasattr(cmd_obj, 'command'):
                    command_text = getattr(cmd_obj, 'command', '')
                    enabled = getattr(cmd_obj, 'enabled', True)
                    long_running = _coerce_bool_flag(getattr(cmd_obj, 'long_running', False), False)
                    timeout_seconds = _coerce_timeout(getattr(cmd_obj, 'timeout_seconds', DEFAULT_CMD_TIMEOUT))
                elif isinstance(cmd_obj, dict):
                    command_text = cmd_obj.get('command') or cmd_obj.get('cmd') or ''
                    enabled = cmd_obj.get('enabled', True)
                    if enabled is None and cmd_obj.get('disabled') is not None:
                        enabled = not cmd_obj.get('disabled')
                    long_hint = cmd_obj.get('long_running')
                    if long_hint is None:
                        for key in ('longRunning', 'longrun', 'long', 'isLongRunning'):
                            if key in cmd_obj:
                                long_hint = cmd_obj.get(key)
                                break
                    timeout_hint = cmd_obj.get('timeout_seconds')
                    if timeout_hint is None:
                        for key in ('timeoutSeconds', 'timeout', 'timeout_sec', 'timeoutSec'):
                            if key in cmd_obj:
                                timeout_hint = cmd_obj.get(key)
                                break
                    long_running = _coerce_bool_flag(long_hint, False)
                    timeout_seconds = _coerce_timeout(timeout_hint)
                else:
                    command_text = cmd_obj
                try:
                    command_text = str(command_text).strip()
                except Exception:
                    command_text = ''
                if not command_text:
                    continue
                if enabled is False:
                    continue
                normalized_text = _normalize_command_text(command_text)
                if not normalized_text:
                    continue
                if match_commands and normalized_text not in match_commands:
                    continue
                commands_out.append({
                    'text': command_text,
                    'normalized': normalized_text,
                    'long_running': bool(long_running),
                    'timeout_seconds': timeout_seconds,
                    'command_index': cmd_index,
                })
            return commands_out

        command_steps = [] if validate_only else steps
        active_validation_commands = validation_commands if validate_only else []
        total_commands = sum(len(extract_enabled_commands(step, selected_commands_filter)) for step in command_steps)
        if (validate_only and not active_validation_commands) or ((not validate_only) and total_commands == 0):
            reason = 'no validation commands configured' if validate_only else 'no stored commands configured'
            if (not validate_only) and selected_commands:
                joined = ', '.join(selected_commands)
                if len(selected_commands) == 1:
                    reason = f'stored command not configured: {joined}'
                else:
                    reason = f'stored commands not configured: {joined}'
            skipped.append({ 'index': m['index'], 'name': m['name'], 'reason': reason })
            continue
        preview_limit = 1000

        def _make_preview(raw_value: Any):
            text = ''
            trimmed = False
            try:
                if raw_value is None:
                    text = ''
                elif isinstance(raw_value, str):
                    text = raw_value
                else:
                    text = str(raw_value)
            except Exception:
                text = ''
            if len(text) > preview_limit:
                trimmed = True
                text = text[:preview_limit] + f"... [trimmed to {preview_limit} chars; see ZIP for full output]"
            return text, trimmed

        def record_zip_entry(step_idx: int, cmd_idx: int, step_delay: float, result_dict: Dict[str, Any], err_msg: Optional[str]):
            stdout_full = ''
            stderr_full = ''
            if isinstance(result_dict, dict):
                stdout_full = result_dict.pop('stdout_full', '')
                stderr_full = result_dict.pop('stderr_full', '')
            if not isinstance(stdout_full, str):
                try:
                    stdout_full = str(stdout_full)
                except Exception:
                    stdout_full = ''
            if not isinstance(stderr_full, str):
                try:
                    stderr_full = str(stderr_full)
                except Exception:
                    stderr_full = ''
            try:
                command_text = str(result_dict.get('cmd', '') if isinstance(result_dict, dict) else '')
            except Exception:
                command_text = ''
            error_text = ''
            if err_msg:
                try:
                    error_text = str(err_msg).strip()
                except Exception:
                    error_text = str(err_msg)
            zip_entries.append({
                'vm_name': m.get('name'),
                'vm_index': m.get('index'),
                'node': m.get('node'),
                'vmid': m.get('vmid'),
                'step': int(step_idx) + 1,
                'command_index': int(cmd_idx) + 1,
                'delay': float(step_delay or 0.0),
                'command': command_text,
                'exitcode': result_dict.get('exitcode') if isinstance(result_dict, dict) else None,
                'stdout': stdout_full or '',
                'stderr': stderr_full or '',
                'error': error_text,
                'timeout_seconds': result_dict.get('timeout_seconds') if isinstance(result_dict, dict) else None,
                'long_running': bool(result_dict.get('long_running')) if isinstance(result_dict, dict) else False,
            })

        def execute_single(command_entry: Dict[str, Any], meta: Optional[Dict[str, Any]] = None):
            if meta:
                _job_emit_command_status(
                    pid,
                    entry=m,
                    step=meta.get('step'),
                    command_idx=meta.get('command_index'),
                    command_text=meta.get('command_text'),
                    command_number=meta.get('command_number'),
                    command_total=meta.get('command_total'),
                    step_command_total=meta.get('step_command_total'),
                )
            command_text = command_entry.get('text') if isinstance(command_entry, dict) else command_entry
            if command_text is None:
                command_text = ''
            timeout_override = command_entry.get('timeout_seconds') if isinstance(command_entry, dict) else None
            timeout_value = _coerce_timeout(timeout_override)
            long_running_flag = bool(command_entry.get('long_running')) if isinstance(command_entry, dict) else False
            try:
                res = client.agent_exec(node=m['node'], vmid=m['vmid'], command=str(command_text), timeout=timeout_value)
                exitcode = res.get('exitcode', 1)
                out = res.get('stdout', '') or ''
                err = res.get('stderr', '') or ''
                out_preview, out_trimmed = _make_preview(out)
                err_preview, err_trimmed = _make_preview(err)
                return {
                    'cmd': str(command_text),
                    'exitcode': exitcode,
                    'stdout_full': out,
                    'stderr_full': err,
                    'stdout_preview': out_preview,
                    'stderr_preview': err_preview,
                    'stdout_trimmed': out_trimmed,
                    'stderr_trimmed': err_trimmed,
                    'preview_limit': preview_limit,
                    'timeout_seconds': timeout_value,
                    'long_running': long_running_flag,
                }, None
            except Exception as exc:
                err_text = str(exc)
                err_preview, err_trimmed = _make_preview(err_text)
                return {
                    'cmd': str(command_text),
                    'exitcode': None,
                    'stdout_full': '',
                    'stderr_full': err_text,
                    'stdout_preview': '',
                    'stderr_preview': err_preview,
                    'stdout_trimmed': False,
                    'stderr_trimmed': err_trimmed,
                    'preview_limit': preview_limit,
                    'timeout_seconds': timeout_value,
                    'long_running': long_running_flag,
                }, f'cmd error ({command_text}): {exc}'

        cmd_results = []
        executed_commands = 0
        cancelled = False
        for step_idx, step in enumerate(command_steps):
            if _is_cancelled(pid):
                cancelled = True
                break
            delay = float(step.delay_seconds or 0.0)
            if delay > 0:
                _job_emit_delay_status(pid, m, step_idx + 1, delay)
                _safe_sleep(delay)
            commands = extract_enabled_commands(step, selected_commands_filter)
            if commands and override_lookup:
                adjusted_commands = []
                for cmd_meta in commands:
                    cmd_entry = dict(cmd_meta)
                    cmd_idx_value = cmd_entry.get('command_index')
                    if isinstance(cmd_idx_value, int):
                        override_key = (template_key, step_idx + 1, cmd_idx_value)
                        if override_key in override_lookup:
                            cmd_entry['text'] = override_lookup[override_key]
                    adjusted_commands.append(cmd_entry)
                commands = adjusted_commands
            if not commands:
                continue
            if len(commands) == 1:
                cmd_meta = commands[0]
                meta_info = {
                    'step': step_idx + 1,
                    'command_index': 1,
                    'command_text': cmd_meta.get('text') if isinstance(cmd_meta, dict) else cmd_meta,
                    'command_number': executed_commands + 1,
                    'command_total': total_commands,
                    'step_command_total': len(commands),
                }
                result, err_msg = execute_single(cmd_meta, meta_info)
                result.update({
                    'step': step_idx + 1,
                    'delay': delay,
                    'long_running': bool(cmd_meta.get('long_running')),
                    'timeout_seconds': cmd_meta.get('timeout_seconds'),
                })
                record_zip_entry(step_idx, 0, delay, result, err_msg)
                cmd_results.append(result)
                cmd_label = result.get('cmd', str(cmd_meta.get('text', '')))
                if err_msg:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': err_msg })
                elif result.get('exitcode') not in (0, None):
                    reason = f"cmd failed ({cmd_label}): {result.get('stderr_preview','')}"
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': reason })
                executed_commands += 1
                continue

            parallel_results = []
            with ThreadPoolExecutor(max_workers=len(commands)) as pool:
                futures = []
                base_seq = executed_commands
                step_command_total = len(commands)
                for order, command_meta in enumerate(commands):
                    meta_info = {
                        'step': step_idx + 1,
                        'command_index': order + 1,
                        'command_text': command_meta.get('text') if isinstance(command_meta, dict) else command_meta,
                        'command_number': base_seq + order + 1,
                        'command_total': total_commands,
                        'step_command_total': step_command_total,
                    }
                    futures.append((order, command_meta, pool.submit(execute_single, command_meta, meta_info)))
                for order, command_meta, future in futures:
                    try:
                        res_data, err_msg = future.result()
                    except Exception as exc:
                        err_text = str(exc)
                        err_preview, err_trimmed = _make_preview(err_text)
                        res_data = {
                            'cmd': str(command_meta.get('text')),
                            'exitcode': None,
                            'stdout_full': '',
                            'stderr_full': err_text,
                            'stdout_preview': '',
                            'stderr_preview': err_preview,
                            'stdout_trimmed': False,
                            'stderr_trimmed': err_trimmed,
                            'preview_limit': preview_limit,
                            'timeout_seconds': command_meta.get('timeout_seconds'),
                            'long_running': bool(command_meta.get('long_running')),
                        }
                        err_msg = f"cmd error ({command_meta.get('text')}): {exc}"
                    res_data['order'] = order
                    parallel_results.append((res_data, err_msg))
            parallel_results.sort(key=lambda entry: entry[0]['order'])
            for res_data, err_msg in parallel_results:
                order_idx = res_data.pop('order', 0)
                res_data.update({'step': step_idx + 1, 'delay': delay})
                record_zip_entry(step_idx, order_idx, delay, res_data, err_msg)
                cmd_results.append(res_data)
                cmd_label = res_data.get('cmd') or ''
                if err_msg:
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': err_msg })
                elif res_data.get('exitcode') not in (0, None):
                    reason = f"cmd failed ({cmd_label}): {res_data.get('stderr_preview','')}"
                    errors.append({ 'index': m['index'], 'name': m['name'], 'step': step_idx + 1, 'command': cmd_label, 'reason': reason })
            executed_commands += len(commands)

        if cancelled:
            errors.append({ 'index': m['index'], 'name': m['name'], 'reason': 'cancelled' })
            break

        validation_results: List[Dict[str, Any]] = []
        validation_all_passed = True
        total_validation_commands = len(active_validation_commands)
        validation_step_idx = len(command_steps)
        for vpos, vcmd in enumerate(active_validation_commands, start=1):
            v_command = str(vcmd.get('command') or '').strip()
            v_match = str(vcmd.get('match') or '').strip()
            v_timeout = _coerce_timeout(vcmd.get('timeout_seconds'))
            try:
                _update_job_detail(
                    pid,
                    phase='validation',
                    current=_format_vm_label(m),
                    step=vpos,
                    total_steps=total_validation_commands,
                    message=(
                        f"Running on {vm_position}/{total_mapped_targets} VM(s) - "
                        f"validating command {vpos}/{total_validation_commands} on {_format_vm_label(m)}: "
                        f"{_shorten_command_text(v_command)} (timeout {v_timeout}s, match /{v_match or '.*'}/)"
                    ),
                    detail={
                        'kind': 'validation',
                        'running_on': {'current': vm_position, 'total': total_mapped_targets},
                        'vm': _format_vm_label(m),
                        'step': vpos,
                        'command_number': vpos,
                        'command_total': total_validation_commands,
                        'command': _shorten_command_text(v_command),
                        'match': v_match,
                        'timeout_seconds': v_timeout,
                    },
                )
            except Exception:
                pass
            regex, compile_err = _compile_validation_regex(v_match)
            if compile_err:
                validation_all_passed = False
                reason = f"validation regex error ({v_command}): {compile_err}"
                errors.append({ 'index': m['index'], 'name': m['name'], 'command': v_command, 'reason': reason })
                validation_results.append({
                    'order': vcmd.get('order'),
                    'command': v_command,
                    'match': v_match,
                    'timeout_seconds': v_timeout,
                    'passed': False,
                    'reason': compile_err,
                    'timed_out': False,
                    'exitcode': None,
                    'stdout_preview': '',
                    'stderr_preview': '',
                })
                record_zip_entry(
                    validation_step_idx,
                    vpos - 1,
                    0.0,
                    {
                        'cmd': v_command,
                        'exitcode': None,
                        'stdout_full': '',
                        'stderr_full': compile_err,
                        'timeout_seconds': v_timeout,
                        'long_running': False,
                    },
                    f"validation regex error: {compile_err}",
                )
                try:
                    _update_job_detail(
                        pid,
                        phase='validation',
                        current=_format_vm_label(m),
                        step=vpos,
                        total_steps=total_validation_commands,
                        message=(
                            f"Running on {vm_position}/{total_mapped_targets} VM(s) - "
                            f"validation {vpos}/{total_validation_commands} failed on {_format_vm_label(m)}: "
                            f"regex error - {compile_err}"
                        ),
                        detail={
                            'kind': 'validation',
                            'running_on': {'current': vm_position, 'total': total_mapped_targets},
                            'vm': _format_vm_label(m),
                            'step': vpos,
                            'command_number': vpos,
                            'command_total': total_validation_commands,
                            'command': _shorten_command_text(v_command),
                            'match': v_match,
                            'timeout_seconds': v_timeout,
                            'result': 'failed',
                            'reason': compile_err,
                            'timed_out': False,
                        },
                    )
                except Exception:
                    pass
                continue
            try:
                res = client.agent_exec(
                    node=m['node'],
                    vmid=m['vmid'],
                    command=v_command,
                    timeout=v_timeout,
                    return_partial_on_timeout=True,
                )
            except Exception as exc:
                validation_all_passed = False
                reason = f"validation command error ({v_command}): {exc}"
                errors.append({ 'index': m['index'], 'name': m['name'], 'command': v_command, 'reason': reason })
                validation_results.append({
                    'order': vcmd.get('order'),
                    'command': v_command,
                    'match': v_match,
                    'timeout_seconds': v_timeout,
                    'passed': False,
                    'reason': str(exc),
                    'timed_out': False,
                    'exitcode': None,
                    'stdout_preview': '',
                    'stderr_preview': str(exc),
                })
                record_zip_entry(
                    validation_step_idx,
                    vpos - 1,
                    0.0,
                    {
                        'cmd': v_command,
                        'exitcode': None,
                        'stdout_full': '',
                        'stderr_full': str(exc),
                        'timeout_seconds': v_timeout,
                        'long_running': False,
                    },
                    f"validation command error: {exc}",
                )
                try:
                    _update_job_detail(
                        pid,
                        phase='validation',
                        current=_format_vm_label(m),
                        step=vpos,
                        total_steps=total_validation_commands,
                        message=(
                            f"Running on {vm_position}/{total_mapped_targets} VM(s) - "
                            f"validation {vpos}/{total_validation_commands} failed on {_format_vm_label(m)}: "
                            f"command error - {exc}"
                        ),
                        detail={
                            'kind': 'validation',
                            'running_on': {'current': vm_position, 'total': total_mapped_targets},
                            'vm': _format_vm_label(m),
                            'step': vpos,
                            'command_number': vpos,
                            'command_total': total_validation_commands,
                            'command': _shorten_command_text(v_command),
                            'match': v_match,
                            'timeout_seconds': v_timeout,
                            'result': 'failed',
                            'reason': str(exc),
                            'timed_out': False,
                            'stderr_preview': err_preview,
                        },
                    )
                except Exception:
                    pass
                continue

            stdout_text = res.get('stdout', '') or ''
            stderr_text = res.get('stderr', '') or ''
            merged = f"{stdout_text}\n{stderr_text}".strip('\n')
            matched = bool(regex.search(merged if isinstance(merged, str) else str(merged))) if regex else False
            timed_out = bool(res.get('timed_out'))
            out_preview, _ = _make_preview(stdout_text)
            err_preview, _ = _make_preview(stderr_text)
            if not matched:
                validation_all_passed = False
                if timed_out:
                    reason = f"validation regex did not match before timeout ({v_command})"
                else:
                    reason = f"validation regex did not match output ({v_command})"
                errors.append({ 'index': m['index'], 'name': m['name'], 'command': v_command, 'reason': reason })
            validation_results.append({
                'order': vcmd.get('order'),
                'command': v_command,
                'match': v_match,
                'timeout_seconds': v_timeout,
                'passed': matched,
                'timed_out': timed_out,
                'exitcode': res.get('exitcode'),
                'stdout_preview': out_preview,
                'stderr_preview': err_preview,
            })
            validation_err = None
            if not matched:
                validation_err = 'validation regex did not match output'
                if timed_out:
                    validation_err = 'validation regex did not match before timeout'
            record_zip_entry(
                validation_step_idx,
                vpos - 1,
                0.0,
                {
                    'cmd': v_command,
                    'exitcode': res.get('exitcode'),
                    'stdout_full': stdout_text,
                    'stderr_full': stderr_text,
                    'timeout_seconds': v_timeout,
                    'long_running': False,
                },
                validation_err,
            )
            try:
                result_label = 'passed' if matched else 'failed'
                msg_bits = [
                    f"Running on {vm_position}/{total_mapped_targets} VM(s)",
                    f"Validation {vpos}/{total_validation_commands} {result_label} on {_format_vm_label(m)}",
                ]
                if timed_out:
                    msg_bits.append('(timed out)')
                preview_for_status = out_preview or err_preview
                if preview_for_status:
                    msg_bits.append(f"- {preview_for_status}")
                _update_job_detail(
                    pid,
                    phase='validation',
                    current=_format_vm_label(m),
                    step=vpos,
                    total_steps=total_validation_commands,
                    message=' '.join(msg_bits),
                    detail={
                        'kind': 'validation',
                        'running_on': {'current': vm_position, 'total': total_mapped_targets},
                        'vm': _format_vm_label(m),
                        'step': vpos,
                        'command_number': vpos,
                        'command_total': total_validation_commands,
                        'command': _shorten_command_text(v_command),
                        'match': v_match,
                        'timeout_seconds': v_timeout,
                        'result': result_label,
                        'timed_out': timed_out,
                        'exitcode': res.get('exitcode'),
                        'stdout_preview': out_preview,
                        'stderr_preview': err_preview,
                        'reason': '' if matched else ('regex did not match before timeout' if timed_out else 'regex did not match output'),
                    },
                )
            except Exception:
                pass

        if active_validation_commands:
            try:
                runtime_store.set_vm_validation_state(
                    proj.id,
                    m.get('name'),
                    bool(validation_all_passed),
                    vmid=m.get('vmid'),
                    node=m.get('node'),
                )
            except Exception as exc:
                LOG.warning(
                    "Could not persist validation state for %s/%s (%s): %s",
                    m.get('node'),
                    m.get('vmid'),
                    m.get('name'),
                    exc,
                )

        ran_entry = {
            'index': m['index'],
            'name': m['name'],
            'vmid': m['vmid'],
            'node': m['node'],
            'steps': len(command_steps),
            'count': len(cmd_results),
            'planned_count': total_commands,
            'cmds': cmd_results,
            'validation': {
                'configured_count': len(active_validation_commands),
                'all_passed': bool(validation_all_passed),
                'results': validation_results,
            },
        }
        if validate_only:
            ran_entry['validate_only'] = True
        if selected_commands:
            ran_entry['selected_commands'] = selected_commands
            if len(selected_commands) == 1:
                ran_entry['selected_command'] = selected_commands[0]
        ran.append(ran_entry)
    zip_payload: Optional[Dict[str, Any]] = None
    if zip_entries:
        now = datetime.now(timezone.utc)
        timestamp = _format_ymdhms(now)
        safe_proj = _safe_file_stem(getattr(proj, 'name', '') or proj.id)
        filename = f"stored_cmd_outputs_{safe_proj}_{timestamp}.zip"
        buf = io.BytesIO()
        summary_entries = []
        with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for entry in zip_entries:
                vm_label = entry.get('vm_name') or f"vm_{entry.get('vm_index')}"
                safe_vm = _safe_file_stem(vm_label) or f"vm_{entry.get('vm_index') or 'unknown'}"
                step_dir = f"step_{int(entry.get('step', 0)):02d}"
                cmd_file = f"cmd_{int(entry.get('command_index', 0)):02d}.txt"
                file_path = f"{safe_vm}/{step_dir}/{cmd_file}"
                exitcode = entry.get('exitcode')
                lines = [
                    f"VM Name: {vm_label}",
                    f"VM Index: {entry.get('vm_index')}",
                    f"Node: {entry.get('node')}",
                    f"VMID: {entry.get('vmid')}",
                    f"Step: {entry.get('step')}",
                    f"Command Index: {entry.get('command_index')}",
                    f"Delay Before Step: {entry.get('delay')}",
                    f"Command: {entry.get('command')}",
                    f"Timeout (s): {entry.get('timeout_seconds')}",
                    f"Long-running: {'yes' if entry.get('long_running') else 'no'}",
                    f"Exit Code: {'' if exitcode is None else exitcode}"
                ]
                if entry.get('error'):
                    lines.append(f"Error: {entry.get('error')}")
                lines.extend([
                    '',
                    'STDOUT:',
                    entry.get('stdout') or '',
                    '',
                    'STDERR:',
                    entry.get('stderr') or ''
                ])
                zf.writestr(file_path, "\n".join(lines))
                summary_entries.append({
                    'vm_name': vm_label,
                    'step': entry.get('step'),
                    'command_index': entry.get('command_index'),
                    'command': entry.get('command'),
                    'exitcode': exitcode,
                    'error': entry.get('error'),
                    'stdout_chars': len(entry.get('stdout') or ''),
                    'stderr_chars': len(entry.get('stderr') or '')
                })
            summary_doc = {
                'project_id': proj.id,
                'project_name': getattr(proj, 'name', ''),
                'generated_at': now.replace(microsecond=0).isoformat() + 'Z',
                'ran_hosts': len(ran),
                'skipped': skipped,
                'errors': errors,
                'commands': summary_entries
            }
            if selected_commands:
                summary_doc['requested_commands'] = selected_commands
                if len(selected_commands) == 1:
                    summary_doc['requested_command'] = selected_commands[0]
            zf.writestr('summary.json', json.dumps(summary_doc, indent=2))
        zip_bytes = buf.getvalue()
        zip_payload = {
            'filename': filename,
            'size': len(zip_bytes),
            'base64': base64.b64encode(zip_bytes).decode('ascii')
        }

    _end_job(pid)
    response_payload: Dict[str, Any] = { 'ran': ran, 'skipped': skipped, 'errors': errors }
    if zip_payload:
        response_payload['outputs_zip'] = zip_payload
    if selected_commands:
        response_payload['requested_commands'] = selected_commands
        if len(selected_commands) == 1:
            response_payload['requested_command'] = selected_commands[0]
    return jsonify(response_payload)


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
        'detail': rec.get('detail'),
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


def _runtime_store() -> RuntimeStore:
    return RuntimeStore(current_app.config["DATA_DIR"])


def _user_secrets_store() -> UserSecretsStore:
    return UserSecretsStore(current_app.config["DATA_DIR"])


def _acting_username() -> str:
    """Return the current authenticated username for per-user secret scoping.

    When AUTH is disabled, fall back to a stable pseudo-user.
    """
    try:
        app = current_app._get_current_object()
    except Exception:
        app = None
    user = None
    try:
        if app and hasattr(app, 'current_user'):
            user = app.current_user()
    except Exception:
        user = None
    try:
        if isinstance(user, dict) and user.get('username'):
            return str(user.get('username')).strip() or '__anonymous__'
    except Exception:
        pass
    return '__anonymous__'


def _migrate_project_level_secrets_if_any(pid: str, username: str) -> None:
    """One-way migration: project-level encrypted secrets -> per-user secrets.

    This is only used for backward compatibility with earlier builds.
    It migrates into the current user's secrets and then clears the project fields
    so secrets are no longer shared across users.
    """
    try:
        s = _store()
        proj = s.get(pid)
        if not proj:
            return
        old_u = getattr(proj, 'proxmox_username_enc', '') or ''
        old_p = getattr(proj, 'proxmox_password_enc', '') or ''
        old_t = getattr(proj, 'ctfd_token_enc', '') or ''
        if not (old_u or old_p or old_t):
            return
        ss = _user_secrets_store()
        existing = ss.get_enc(username, pid) or {}
        if not existing:
            ss.upsert_enc(username, pid,
                          proxmox_username_enc=old_u,
                          proxmox_password_enc=old_p,
                          ctfd_token_enc=old_t)
        # Clear project-level secrets regardless once a user has accessed migration.
        proj.proxmox_username_enc = ''
        proj.proxmox_password_enc = ''
        proj.ctfd_token_enc = ''
        s.upsert(proj)
    except Exception:
        return


def _effective_secrets_username(ss: UserSecretsStore, username: str, project_id: str) -> str:
    user = str(username or '').strip() or '__anonymous__'
    if user != '__anonymous__':
        return user
    try:
        existing = ss.get_enc(user, project_id) or {}
        if existing:
            return user
    except Exception:
        pass
    try:
        owner = ss.find_project_owner(project_id)
        if owner:
            return owner
    except Exception:
        pass
    return user


def _is_remote_mode() -> bool:
    try:
        return _runtime_store().get_run_mode() == 'remote'
    except Exception:
        return False


def _block_when_remote(feature: str):
    if _is_remote_mode():
        msg = f"{feature} is disabled when app is running in remote mode."
        return jsonify({"error": msg}), 403
    return None


@api_bp.get('/runtime')
def runtime_get():
    """Return the server-persisted runtime mode.

    Response: { ok: true, runMode: 'local'|'remote' }
    """
    try:
        mode = _runtime_store().get_run_mode()
    except Exception:
        mode = 'local'
    return jsonify({'ok': True, 'runMode': mode})


@api_bp.post('/runtime')
def runtime_set():
    """Persist runtime mode on the server so it survives restarts.

    Body: { runMode: 'local'|'remote' }
    Response: { ok: true, runMode: 'local'|'remote' }
    """
    body = request.get_json(silent=True) or {}
    mode = body.get('runMode') if isinstance(body, dict) else None
    try:
        normalized = _runtime_store().set_run_mode(mode)
    except Exception as exc:
        return jsonify({'ok': False, 'error': str(exc)}), 500
    return jsonify({'ok': True, 'runMode': normalized})

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
            'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
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

    user_obj_cache: Dict[int, Dict[str, Any]] = {}
    user_solves_cache: Dict[int, List[Dict[str, Any]]] = {}
    team_obj_cache: Dict[int, Dict[str, Any]] = {}
    team_members_cache: Dict[int, List[Dict[str, Any]]] = {}
    team_solves_cache: Dict[int, List[Dict[str, Any]]] = {}
    scoreboard_cache: Dict[str, Optional[Dict[int, Dict[str, Any]]]] = {
        'users': None,
        'teams': None,
        'members': None,
    }

    def _coerce_int(value):
        try:
            if value is None or value == '':
                return None
            return int(value)
        except Exception:
            try:
                return int(str(value))
            except Exception:
                return None

    def _extract_rank(obj):
        if not isinstance(obj, dict):
            return None
        try:
            for key in ('place', 'pos', 'rank', 'score_rank', 'overall_place'):
                val = obj.get(key)
                if isinstance(val, (int, float, str)) and str(val).strip():
                    return int(val) if str(val).isdigit() else str(val)
        except Exception:
            pass
        return None

    def _extract_points(obj):
        if not isinstance(obj, dict):
            return None
        try:
            for key in ('score', 'points', 'value', 'overall_score', 'sum'):
                val = obj.get(key)
                if val is None:
                    continue
                try:
                    return float(val)
                except Exception:
                    try:
                        return float(int(str(val)))
                    except Exception:
                        continue
        except Exception:
            pass
        return None

    def _cached_scoreboard_maps():
        users = scoreboard_cache.get('users')
        teams = scoreboard_cache.get('teams')
        members = scoreboard_cache.get('members')
        if users is not None and teams is not None and members is not None:
            return users, teams, members

        user_rows: Dict[int, Dict[str, Any]] = {}
        team_rows: Dict[int, Dict[str, Any]] = {}
        member_rows: Dict[int, Dict[str, Any]] = {}
        list_scoreboard = getattr(client, 'list_scoreboard', None)
        try:
            rows = list_scoreboard() if callable(list_scoreboard) else []
        except Exception:
            rows = []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                account_id = _coerce_int(row.get('account_id') if row.get('account_id') is not None else row.get('id'))
                row_members = row.get('members')
                if isinstance(row_members, list):
                    if account_id is not None:
                        team_rows[account_id] = row
                    for member in row_members:
                        if not isinstance(member, dict):
                            continue
                        member_id = _coerce_int(member.get('id') if member.get('id') is not None else member.get('user_id'))
                        if member_id is None or member_id in member_rows:
                            continue
                        member_rows[member_id] = {
                            **member,
                            'team_id': account_id,
                        }
                elif account_id is not None:
                    user_rows[account_id] = row
        scoreboard_cache['users'] = user_rows
        scoreboard_cache['teams'] = team_rows
        scoreboard_cache['members'] = member_rows
        return user_rows, team_rows, member_rows

    def _cached_user_obj(user_id):
        try:
            uid_i = int(user_id)
        except Exception:
            return {}
        if uid_i not in user_obj_cache:
            try:
                user_obj_cache[uid_i] = client.get_user(uid_i) or {}
            except Exception:
                user_obj_cache[uid_i] = {}
        return user_obj_cache.get(uid_i) or {}

    def _cached_user_solves(user_id):
        try:
            uid_i = int(user_id)
        except Exception:
            return []
        if uid_i not in user_solves_cache:
            try:
                solves = client.list_user_solves(uid_i)
                user_solves_cache[uid_i] = solves if isinstance(solves, list) else []
            except Exception:
                user_solves_cache[uid_i] = []
        return user_solves_cache.get(uid_i) or []

    def _cached_team_obj(team_id):
        try:
            tid_i = int(team_id)
        except Exception:
            return {}
        if tid_i not in team_obj_cache:
            try:
                team_obj_cache[tid_i] = client.get_team(tid_i) or {}
            except Exception:
                team_obj_cache[tid_i] = {}
        return team_obj_cache.get(tid_i) or {}

    def _cached_team_members(team_id):
        try:
            tid_i = int(team_id)
        except Exception:
            return []
        if tid_i not in team_members_cache:
            try:
                members = client.list_team_members(tid_i)
                team_members_cache[tid_i] = members if isinstance(members, list) else []
            except Exception:
                team_members_cache[tid_i] = []
        return team_members_cache.get(tid_i) or []

    def _cached_team_solves(team_id):
        try:
            tid_i = int(team_id)
        except Exception:
            return []
        if tid_i not in team_solves_cache:
            try:
                solves = client.list_team_solves(tid_i)
                team_solves_cache[tid_i] = solves if isinstance(solves, list) else []
            except Exception:
                team_solves_cache[tid_i] = []
        return team_solves_cache.get(tid_i) or []

    bulk_user_matches = {}
    def _index_bulk_users(users):
        for user in users:
            if not isinstance(user, dict):
                continue
            name_key = str(user.get('name') or user.get('username') or '').strip().lower()
            email_key = str(user.get('email') or '').strip().lower()
            if name_key and name_key not in bulk_user_matches:
                bulk_user_matches[name_key] = user
            if email_key and email_key not in bulk_user_matches:
                bulk_user_matches[email_key] = user

    if hasattr(client, 'list_all_users'):
        try:
            _index_bulk_users(client.list_all_users(view_admin=True) or [])
        except Exception:
            try:
                _index_bulk_users(client.list_all_users(view_admin=False) or [])
            except Exception:
                bulk_user_matches = {}

    out = []
    for uname in targets:
        exists = False
        uid = None
        tid = None
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
            expected_email = f"{uname}@example.com".strip().lower() if uname else ''
            bulk_user = bulk_user_matches.get(str(uname or '').strip().lower()) or (bulk_user_matches.get(expected_email) if expected_email else None)
            if isinstance(bulk_user, dict):
                try:
                    raw_uid = bulk_user.get('id')
                    if raw_uid is not None and raw_uid != '':
                        uid = int(raw_uid)
                except Exception:
                    uid = None
                exists = bool(uid is not None or bulk_user.get('name') or bulk_user.get('username') or bulk_user.get('email'))
            bulk_exists = bool(exists)
            if uid is None:
                uid = client.find_user_id_by_name(uname)
            exists = bool(uid is not None or bulk_exists)
            if uid:
                # Try to enrich with rank/team info
                uobj = _cached_user_obj(uid)
                user_rank = _extract_rank(uobj)
                user_points = _extract_points(uobj)
                if user_rank is None or user_points is None:
                    scoreboard_users, _, scoreboard_members = _cached_scoreboard_maps()
                    scoreboard_user = scoreboard_users.get(uid) or {}
                    if user_rank is None:
                        user_rank = _extract_rank(scoreboard_user)
                    if user_points is None:
                        user_points = _extract_points(scoreboard_user)
                    if user_points is None:
                        user_points = _extract_points(scoreboard_members.get(uid) or {})
                # User last solve info
                try:
                    solves = _cached_user_solves(uid)
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
                    if tid is None:
                        _, _, scoreboard_members = _cached_scoreboard_maps()
                        tid = _coerce_int((scoreboard_members.get(uid) or {}).get('team_id'))
                    if tid is not None:
                        tobj = _cached_team_obj(tid)
                        # Determine a team display name and rank from common keys
                        try:
                            for nk in ('name','team','display_name','title'):
                                tv = tobj.get(nk)
                                if isinstance(tv, str) and tv.strip():
                                    team_name = tv.strip()
                                    break
                        except Exception:
                            pass
                        team_rank = _extract_rank(tobj)
                        team_points = _extract_points(tobj)
                        if not team_name or team_rank is None or team_points is None or user_points is None:
                            _, scoreboard_teams, scoreboard_members = _cached_scoreboard_maps()
                            scoreboard_team = scoreboard_teams.get(tid) or {}
                            if not team_name:
                                try:
                                    for nk in ('name','team','display_name','title'):
                                        tv = scoreboard_team.get(nk)
                                        if isinstance(tv, str) and tv.strip():
                                            team_name = tv.strip()
                                            break
                                except Exception:
                                    pass
                            if team_rank is None:
                                team_rank = _extract_rank(scoreboard_team)
                            if team_points is None:
                                team_points = _extract_points(scoreboard_team)
                            if user_points is None:
                                user_points = _extract_points(scoreboard_members.get(uid) or {})
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
                            members = _cached_team_members(tid)
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
                                        ucap = _cached_user_obj(cap_id)
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
                            tsolves = _cached_team_solves(tid)
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
        cache_key = _make_ctfd_category_firsts_cache_key(pid, client, body)
        category_payload = _get_cached_ctfd_category_firsts(cache_key)
        if category_payload is None:
            try:
                category_payload = _build_category_firsts()
                _set_cached_ctfd_category_firsts(cache_key, category_payload)
            except Exception as exc:
                category_payload = {
                    'user': [],
                    'team': [],
                    'errors': [f'category_firsts: {exc}'],
                    'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
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


def _sanitize_import_vms(vms_value: object, keep_vmid: bool) -> list:
    """Sanitize VM entries from an imported manifest.
    When keep_vmid is False, vmid is dropped (config-only import).
    """
    if not isinstance(vms_value, list):
        return []
    allowed_keys = {
        'name',
        'vmid',
        'viewable_to_user',
        'start_commands',
        'stored_commands',
        'validation_commands',
        'internal_network_adaptors',
        'use_linked_clone',
        'clone_timeout_sec',
        'storage_volume',
        'skip_post_clone_snapshot',
        'vm_user',
        'vm_pass',
    }
    out = []
    for vm in vms_value:
        rec = {}
        if isinstance(vm, dict):
            rec = dict(vm)
        elif isinstance(vm, str):
            rec = {'name': vm}
        else:
            continue

        nm = _sanitize_vm_name(str(rec.get('name', '')).strip())
        if not nm:
            continue
        clean = {'name': nm}

        for k in allowed_keys:
            if k in ('name', 'vmid'):
                continue
            if k in rec:
                clean[k] = rec.get(k)

        if keep_vmid and ('vmid' in rec):
            clean['vmid'] = rec.get('vmid')

        # Adaptor names: keep only valid names
        try:
            if 'internal_network_adaptors' in clean:
                raw = clean.get('internal_network_adaptors')
                if not isinstance(raw, list):
                    raw = []
                clean['internal_network_adaptors'] = [
                    str(a).strip() for a in raw if _is_valid_adaptor_name(a)
                ]
        except Exception:
            clean['internal_network_adaptors'] = []

        out.append(clean)
    return out


def _default_import_name(source_name: str) -> str:
    try:
        base = os.path.basename(source_name or "").strip()
        stem, _ = os.path.splitext(base)
        stem = stem.strip()
        return stem or "Imported"
    except Exception:
        return "Imported"


def _infer_vms_from_backups(zf) -> list:
    inferred = []
    seen = set()
    try:
        names = zf.namelist()
    except Exception:
        return inferred
    for entry in names:
        if not (entry.startswith('backups/') and not entry.endswith('/')):
            continue
        if not entry.lower().endswith(('.vma.zst', '.vma.lzo', '.vma.gz')):
            continue
        parts = entry.split('/')
        vm_name = ''
        if len(parts) >= 3:
            vm_name = parts[1]
        if not vm_name:
            vm_name = os.path.splitext(os.path.basename(entry))[0]
        vm_clean = _sanitize_vm_name(vm_name)
        if vm_clean in seen:
            continue
        seen.add(vm_clean)
        inferred.append({'name': vm_clean})
    return inferred


def _load_import_manifest(zf, *, default_project_name: str = "Imported") -> tuple:
    try:
        with zf.open('project.json') as mf:
            return json.load(mf), False
    except KeyError:
        fallback = {
            'schemaVersion': 1,
            'project': {
                'name': default_project_name or "Imported",
                'vms': _infer_vms_from_backups(zf),
            },
        }
        return fallback, True


def _zip_has_manifest(path: str) -> bool:
    try:
        with zipfile.ZipFile(path) as zf:
            zf.getinfo('project.json')
        return True
    except KeyError:
        return False
    except Exception:
        return False


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
    d = asdict(p)
    # Never expose encrypted secret blobs in standard project payloads
    for k in (
        'proxmox_username_enc',
        'proxmox_password_enc',
        'ctfd_token_enc',
    ):
        try:
            d.pop(k, None)
        except Exception:
            pass
    try:
        assoc = list(d.get('associated_projects', []) or [])
        d['associated_projects'] = [str(x).strip() for x in assoc if str(x).strip()]
    except Exception:
        d['associated_projects'] = []
    return d


def _project_to_json_filtered(p: Project, include_creds: bool = True, include_vms: bool = True) -> dict:
    """Project to JSON with optional exclusion of credentials or VMs for export.
    When include_vms is False, we still include VM configurations (commands, adaptors, etc.)
    but drop node-specific VMIDs and disk images.
    """
    d = _project_to_json(p)
    # Always strip multi-project association metadata from export payloads
    try:
        d.pop('associated_projects', None)
    except Exception:
        pass

    if not include_creds:
        # Remove project-level credentials if present
        d.pop("credentials", None)

    # Process VMs list to apply selective stripping
    try:
        vms_list = d.get('vms') or []
        cleaned_vms = []
        for v in vms_list:
            if not isinstance(v, dict):
                continue

            # Create a copy to ensure we don't modify the source if it's shared/cached
            vm_cfg = dict(v)

            # If not including VMs (backups), strip the node-specific ID
            if not include_vms:
                vm_cfg.pop('vmid', None)

            # If not including credentials, strip VM-level secrets
            if not include_creds:
                vm_cfg.pop('vm_user', None)
                vm_cfg.pop('vm_pass', None)

            if vm_cfg.get('name'):
                cleaned_vms.append(vm_cfg)
        d['vms'] = cleaned_vms
    except Exception:
        d['vms'] = []

    return d


# Projects CRUD
@api_bp.route("/projects", methods=["GET"])
def list_projects():
    # Convert dataclasses to JSON-serializable dicts (including VMConfig)
    projects = [_project_to_json(p) for p in _store().list()]
    return jsonify({"projects": projects})


@api_bp.route("/projects/<pid>/secrets", methods=["GET"])
@_secure_route()
def get_project_secrets(pid: str):
    """Return project-scoped credentials (decrypted) for authenticated admin users."""
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    username = _acting_username()
    _migrate_project_level_secrets_if_any(pid, username)
    ss = _user_secrets_store()
    secrets_username = _effective_secrets_username(ss, username, pid)
    enc = ss.get_enc(secrets_username, pid) or {}
    sk = current_app.config.get('SECRET_KEY')
    prox_user = _dec_secret(sk, enc.get('proxmox_username_enc') or '')
    prox_pass = _dec_secret(sk, enc.get('proxmox_password_enc') or '')
    ctfd_token = _dec_secret(sk, enc.get('ctfd_token_enc') or '')
    return jsonify({
        "projectId": pid,
        "proxmox": {
            "username": prox_user,
            "password": prox_pass,
            "saved": bool(prox_user or prox_pass),
        },
        "ctfd": {
            "token": ctfd_token,
            "saved": bool(ctfd_token),
        }
    })


@api_bp.route("/projects/<pid>/secrets", methods=["PATCH", "PUT"])
@_secure_route()
def update_project_secrets(pid: str):
    """Set/clear project-scoped credentials.

    Accepts either nested objects:
      { proxmox: { username, password }, ctfd: { token } }
    or flat keys:
      { proxmox_username, proxmox_password, ctfd_token }

    Any provided secret field set to an empty string clears that secret.
    """
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    username = _acting_username()
    _migrate_project_level_secrets_if_any(pid, username)
    try:
        data = request.get_json(force=True) or {}
    except Exception:
        data = {}

    prox = data.get('proxmox') if isinstance(data.get('proxmox'), dict) else {}
    ctfd = data.get('ctfd') if isinstance(data.get('ctfd'), dict) else {}

    # Prefer nested, fall back to flat.
    prox_user_in = prox.get('username') if 'username' in prox else data.get('proxmox_username')
    prox_pass_in = prox.get('password') if 'password' in prox else data.get('proxmox_password')
    ctfd_token_in = ctfd.get('token') if 'token' in ctfd else data.get('ctfd_token')

    sk = current_app.config.get('SECRET_KEY')
    ss = _user_secrets_store()
    secrets_username = _effective_secrets_username(ss, username, pid)
    existing = ss.get_enc(secrets_username, pid) or {}
    changed = False

    if prox_user_in is not None or prox_pass_in is not None:
        cur_user = _dec_secret(sk, existing.get('proxmox_username_enc') or '')
        cur_pass = _dec_secret(sk, existing.get('proxmox_password_enc') or '')
        new_user = cur_user if prox_user_in is None else str(prox_user_in or '').strip()
        new_pass = cur_pass if prox_pass_in is None else str(prox_pass_in or '')
        if not new_user and not new_pass:
            ss.upsert_enc(secrets_username, pid, proxmox_username_enc='', proxmox_password_enc='')
        else:
            ss.upsert_enc(
                secrets_username,
                pid,
                proxmox_username_enc=_enc_secret(sk, new_user),
                proxmox_password_enc=_enc_secret(sk, new_pass),
            )
        changed = True

    if ctfd_token_in is not None:
        token = str(ctfd_token_in or '').strip()
        ss.upsert_enc(secrets_username, pid, ctfd_token_enc=_enc_secret(sk, token) if token else '')
        changed = True

    # Keep project record in sync: ensure project-level fields are cleared so secrets aren't shared.
    try:
        if getattr(proj, 'proxmox_username_enc', '') or getattr(proj, 'proxmox_password_enc', '') or getattr(proj, 'ctfd_token_enc', ''):
            proj.proxmox_username_enc = ''
            proj.proxmox_password_enc = ''
            proj.ctfd_token_enc = ''
            s.upsert(proj)
    except Exception:
        pass

    enc = ss.get_enc(secrets_username, pid) or {}
    prox_user = _dec_secret(sk, enc.get('proxmox_username_enc') or '')
    prox_pass = _dec_secret(sk, enc.get('proxmox_password_enc') or '')
    ctfd_token = _dec_secret(sk, enc.get('ctfd_token_enc') or '')
    return jsonify({
        "ok": True,
        "projectId": pid,
        "proxmox_saved": bool(prox_user or prox_pass),
        "ctfd_saved": bool(ctfd_token),
    })

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
    "proxmox_url", "proxmox_api_port", "proxmox_ssh_port", "proxmox_node", "proxmox_api_token", "proxmox_verify_ssl",
        "guacamole_url", "guacamole_port",
        "keycloak_url", "keycloak_port", "keycloak_nodename",
        "challenge_url", "challenge_port", "challenge_verify_ssl",
        "instances", "tag", "vnc_start_port", "credentials",
        # Advanced Proxmox
        "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
        "proxmox_qmrestore_path", "proxmox_storage_volume",
    "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
    "proxmox_use_linked_clones",
    "instance_statuses",
    "vms",
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
    "proxmox_url", "proxmox_api_port", "proxmox_ssh_port", "proxmox_node", "proxmox_api_token", "proxmox_verify_ssl",
        "guacamole_url", "guacamole_port",
        "keycloak_url", "keycloak_port", "keycloak_nodename",
        "challenge_url", "challenge_port", "challenge_verify_ssl",
        "instances", "tag", "vnc_start_port", "credentials", "vms",
        # Advanced Proxmox
        "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
        "proxmox_qmrestore_path", "proxmox_storage_volume",
    "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
    "proxmox_use_linked_clones", "proxmox_assign_rollback_on_non_viewable",
    "instance_statuses",
    ]:
        if key in data:
            if key == "vms" and isinstance(data[key], list):
                try:
                    proj.vms = [s._coerce_vm(x) for x in data[key]]
                except Exception as e:
                    LOG.error(f"Failed to coerce vms list: {e}")
                    setattr(proj, key, data[key])
            else:
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

    def _as_bool(v) -> bool:
        if v is None:
            return False
        s = str(v).strip().lower()
        return s in {"1", "true", "yes", "y", "on"}

    def _entry_meta(entry: Any) -> Any:
        if not isinstance(entry, dict):
            return {}
        out: Dict[str, Any] = {}
        for k, v in entry.items():
            if k in {"dataUrl", "sounds", "name", "size", "type", "updated"}:
                continue
            out[k] = v
        # Preserve speak templates (if present)
        if isinstance(entry.get("speakTemplates"), list):
            out["speakTemplates"] = entry.get("speakTemplates")
        # Preserve sounds but strip dataUrl
        sounds = entry.get("sounds")
        if isinstance(sounds, list):
            meta_sounds: list[dict[str, Any]] = []
            for s_obj in sounds:
                if not isinstance(s_obj, dict):
                    continue
                rec: Dict[str, Any] = {}
                for sk in ("name", "size", "type", "updated", "sha256"):
                    if sk in s_obj:
                        rec[sk] = s_obj.get(sk)
                meta_sounds.append(rec)
            if meta_sounds:
                out["sounds"] = meta_sounds
        return out

    prefix = request.args.get("prefix")
    meta = _as_bool(request.args.get("meta"))
    if prefix:
        try:
            pfx = str(prefix)
        except Exception:
            pfx = ""
        if pfx:
            audio = {k: v for k, v in audio.items() if str(k).startswith(pfx)}
    if meta:
        audio = {k: _entry_meta(v) for k, v in audio.items()}

    return jsonify({"audio": audio})


@api_bp.route("/projects/<pid>/audio_entry", methods=["GET"])
def get_project_audio_entry(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    key = request.args.get("key")
    if not key:
        return jsonify({"error": "key is required"}), 400
    audio = getattr(proj, 'audio', {}) or {}
    if not isinstance(audio, dict):
        audio = {}
    entry = audio.get(key)
    if entry is None:
        return jsonify({"error": "Audio entry not found"}), 404
    return jsonify({"key": key, "entry": entry})


@api_bp.route("/projects/<pid>/audio_entry", methods=["DELETE"])
@_secure_route()
def delete_project_audio_entry(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    key = request.args.get("key")
    if not key:
        return jsonify({"error": "key is required"}), 400
    audio = getattr(proj, 'audio', {}) or {}
    if not isinstance(audio, dict):
        audio = {}
    if key not in audio:
        return jsonify({"error": "Audio entry not found"}), 404
    try:
        del audio[key]
    except Exception:
        audio.pop(key, None)
    # Clear any per-event references to this media key
    try:
        for k, v in list(audio.items()):
            if not isinstance(k, str) or not k.startswith('event:'):
                continue
            if not isinstance(v, dict):
                continue
            if v.get('soundKey') == key:
                try:
                    del v['soundKey']
                except Exception:
                    v.pop('soundKey', None)
                audio[k] = v
    except Exception:
        pass

    sanitized = ProjectStore._sanitize_audio_map(audio)
    proj = s.update_audio(pid, sanitized)
    return jsonify({"ok": True, "audio": getattr(proj, 'audio', {}) or {}})


@api_bp.route("/projects/<pid>/audio_media", methods=["POST"])
@_secure_route()
def upload_project_audio_media(pid: str):
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Project not found"}), 404

    try:
        body = request.get_json(force=True) or {}
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    data_url = body.get('dataUrl')
    name = body.get('name')
    size = body.get('size')
    mime_type = body.get('type')

    try:
        data_url = str(data_url or '').strip()
    except Exception:
        data_url = ''
    if not data_url.startswith('data:'):
        return jsonify({"error": "dataUrl must be a base64 data URI"}), 400

    mime, raw_bytes = ProjectStore._decode_data_url(data_url)
    if raw_bytes is None or raw_bytes == b"":
        return jsonify({"error": "invalid audio data"}), 400
    if len(raw_bytes) > ProjectStore._MAX_AUDIO_BYTES:
        return jsonify({"error": f"exceeds {ProjectStore._MAX_AUDIO_BYTES // (1024 * 1024)} MB limit"}), 400

    try:
        import hashlib
        sha256_hex = hashlib.sha256(raw_bytes).hexdigest()
    except Exception:
        sha256_hex = ''

    audio = getattr(proj, 'audio', {}) or {}
    if not isinstance(audio, dict):
        audio = {}

    # Deduplicate against existing uploaded media
    if sha256_hex:
        for k, v in audio.items():
            try:
                key = str(k)
            except Exception:
                continue
            if not key.startswith('media:'):
                continue
            if not isinstance(v, dict):
                continue
            sounds = v.get('sounds')
            if not isinstance(sounds, list) or not sounds:
                continue
            s0 = sounds[0] if isinstance(sounds[0], dict) else None
            existing_hash = ''
            if s0 and isinstance(s0.get('sha256'), str):
                existing_hash = s0.get('sha256')
            if not existing_hash:
                # Backward compat: compute if missing
                existing_url = s0.get('dataUrl') if s0 else None
                if isinstance(existing_url, str) and existing_url.startswith('data:'):
                    _m, _b = ProjectStore._decode_data_url(existing_url)
                    if _b:
                        try:
                            existing_hash = hashlib.sha256(_b).hexdigest()
                        except Exception:
                            existing_hash = ''
            if existing_hash and existing_hash == sha256_hex:
                return jsonify({"ok": True, "duplicated": True, "key": key})

    # New media entry
    try:
        import uuid
        new_key = f"media:{uuid.uuid4()}"
    except Exception:
        new_key = f"media:{int(time.time())}"

    label = None
    try:
        label = str(name).strip() if name is not None else None
    except Exception:
        label = None
    if not label:
        label = 'Audio'

    try:
        mime_label = str(mime_type).strip() if mime_type is not None else ''
    except Exception:
        mime_label = ''
    if not mime_label:
        mime_label = mime or ''

    try:
        size_num = int(size) if size is not None else len(raw_bytes)
    except Exception:
        size_num = len(raw_bytes)

    audio[new_key] = {
        'sounds': [
            {
                'name': label,
                'size': size_num,
                'type': mime_label,
                'dataUrl': data_url,
                'updated': int(time.time() * 1000),
                'sha256': sha256_hex,
            }
        ]
    }

    sanitized = ProjectStore._sanitize_audio_map(audio)
    proj = s.update_audio(pid, sanitized)
    entry = (getattr(proj, 'audio', {}) or {}).get(new_key)
    return jsonify({"ok": True, "duplicated": False, "key": new_key, "entry": entry})


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
    # Note: update_audio calls _sanitize_audio_map internally, no need to sanitize here
    proj = s.update_audio(pid, payload)
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
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Not found"}), 404
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")

    include_creds = request.args.get("includeCreds", "true").lower() != "false"
    include_vms = request.args.get("includeVms", "true").lower() != "false"
    include_notify_audio = request.args.get("includeNotifyAudio", "true").lower() != "false"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        project_dict = _project_to_json_filtered(proj, include_creds=include_creds, include_vms=include_vms)
        # Notifications are always exported; this flag only controls whether uploaded notification audio (media:*) is included.
        if not include_notify_audio:
            try:
                audio_map = project_dict.get('audio')
                if isinstance(audio_map, dict):
                    project_dict['audio'] = {k: v for k, v in audio_map.items() if not str(k).startswith('media:')}
            except Exception:
                pass
        manifest = {
            "schemaVersion": 1,
            "project": project_dict,
        }
        zf.writestr("project.json", json.dumps(manifest, indent=2))
        if include_notify_audio:
            _write_project_audio_to_zip(zf, proj, include_prefixes=('media:',))
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
        stamp = _format_ymdhms(_dt.datetime.now(_dt.timezone.utc))
        fname = f"{stem}_{stamp}.zip"
    except Exception:
        fname = f"project_{pid}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


# Import project (zip) — synchronous legacy endpoint (kept for backward compatibility)
@api_bp.route("/projects/import", methods=["POST"])
def import_project():
    blocked = _block_when_remote('Import')
    if blocked:
        return blocked
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files['file']
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
    # Import selection flags (default true when not specified)
    try:
        include_creds = (request.form.get('includeCreds', 'true').lower() != 'false')
        include_vms = (request.form.get('includeVms', 'true').lower() != 'false')
        include_notify_audio = (request.form.get('includeNotifyAudio', 'true').lower() != 'false')
    except Exception:
        include_creds, include_vms, include_notify_audio = True, True, True
    try:
        allow_best_effort = (request.form.get('allowBestEffort', 'false').lower() == 'true')
    except Exception:
        allow_best_effort = False
    try:
        allow_best_effort = (request.form.get('allowBestEffort', 'false').lower() == 'true')
    except Exception:
        allow_best_effort = False
    try:
        import_as_templates = (request.form.get('importAsTemplates', 'false').lower() == 'true')
    except Exception:
        import_as_templates = False
    s = _store()
    mats_dir = os.path.join(current_app.config["DATA_DIR"], "materials")
    os.makedirs(mats_dir, exist_ok=True)

    # Save upload to a temporary file to avoid loading large archives into memory
    import tempfile
    import shutil
    uploads_dir = os.path.join(current_app.config["DATA_DIR"], "uploads")
    try:
        os.makedirs(uploads_dir, exist_ok=True)
    except Exception:
        uploads_dir = None  # fallback to system temp
    tmp_fd = None
    tmp_path = None
    work_dir = None
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
        if not allow_best_effort:
            has_manifest = _zip_has_manifest(tmp_path)
            if not has_manifest:
                return jsonify({"error": "Missing project.json in archive. Enable best-effort import to continue.", "code": "missing_manifest"}), 400

        # Stage extracted artifacts into a per-import work directory so we can
        # commit atomically (important when the client cancels/closes mid-import).
        try:
            if uploads_dir:
                work_dir = tempfile.mkdtemp(prefix="import_work_", dir=uploads_dir)
            else:
                work_dir = tempfile.mkdtemp(prefix="import_work_")
        except Exception:
            work_dir = None

        with zipfile.ZipFile(tmp_path) as zf:
            manifest, synthesized = _load_import_manifest(
                zf,
                default_project_name=_default_import_name(file.filename),
            )
            if synthesized:
                try:
                    current_app.logger.info("import: missing project.json; using synthesized manifest")
                except Exception:
                    pass

            # Atomic commit bookkeeping
            projects_to_commit: List[Project] = []
            projects_by_id: Dict[str, Project] = {}
            staged_materials: List[Tuple[str, str]] = []

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
                    # Always import VM configuration; when include_vms is False, drop vmid (config-only)
                    pdata2['vms'] = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
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
                        "proxmox_update_delay_seconds",
                    ]:
                        if key in pdata2:
                            setattr(proj, key, pdata2[key])
                    try:
                        proj.vms = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
                    except Exception:
                        proj.vms = []

                    # Notifications config is always imported; uploaded media audio (media:*) is optional.
                    try:
                        if 'audio' in pdata2 and isinstance(pdata2.get('audio'), dict):
                            audio_map = dict(pdata2.get('audio') or {})
                            if not include_notify_audio:
                                audio_map = {k: v for k, v in audio_map.items() if not str(k).startswith('media:')}
                            else:
                                audio_map = _dedupe_media_audio(audio_map)
                            proj.audio = ProjectStore._sanitize_audio_map(audio_map)
                    except Exception:
                        proj.audio = getattr(proj, 'audio', {}) or {}
                    # Defer persistence until the end (atomic import)
                    projects_to_commit.append(proj)
                    projects_by_id[new_id] = proj
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
                        tmp_out = os.path.join(work_dir, new_name) if work_dir else os.path.join(mats_dir, new_name)
                        with zf.open(zname) as src, open(tmp_out, 'wb') as dst:
                            shutil.copyfileobj(src, dst, length=1024 * 1024)
                        if work_dir:
                            staged_materials.append((tmp_out, os.path.join(mats_dir, new_name)))
                        # append to in-memory project
                        proj = projects_by_id.get(target)
                        if proj:
                            proj.materials.append(new_name)

                # Commit: materials first (to avoid projects referencing missing files), then projects.
                moved: List[str] = []
                try:
                    if work_dir:
                        for src_path, dst_path in staged_materials:
                            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
                            shutil.move(src_path, dst_path)
                            moved.append(dst_path)
                    for proj in projects_to_commit:
                        s.upsert(proj)
                except Exception:
                    # Best-effort rollback of any committed materials
                    for p in moved:
                        try:
                            if os.path.exists(p):
                                os.remove(p)
                        except Exception:
                            pass
                    raise

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
                # Always import VM configuration; when include_vms is False, drop vmid (config-only)
                pdata2['vms'] = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
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
                    "challenge_url", "challenge_port", "challenge_verify_ssl",
                    "instances", "tag", "vnc_start_port", "credentials",
                    "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
                    "proxmox_qmrestore_path", "proxmox_storage_volume",
                    "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
                    "proxmox_update_delay_seconds",
                ]:
                    if key in pdata2:
                        setattr(project, key, pdata2[key])
                try:
                    project.vms = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
                except Exception:
                    project.vms = []
                # For single-project import, drop associations (targets unknown)
                try:
                    project.associated_projects = []
                except Exception:
                    pass
                try:
                    if 'audio' in pdata2 and isinstance(pdata2.get('audio'), dict):
                        audio_map = dict(pdata2.get('audio') or {})
                        if not include_notify_audio:
                            audio_map = {k: v for k, v in audio_map.items() if not str(k).startswith('media:')}
                        else:
                            audio_map = _dedupe_media_audio(audio_map)
                        project.audio = ProjectStore._sanitize_audio_map(audio_map)
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
                    tmp_out = os.path.join(work_dir, new_name) if work_dir else os.path.join(mats_dir, new_name)
                    with zf.open(zname) as src, open(tmp_out, 'wb') as dst:
                        shutil.copyfileobj(src, dst, length=1024 * 1024)
                    if work_dir:
                        staged_materials.append((tmp_out, os.path.join(mats_dir, new_name)))
                    imported.append(new_name)
                project.materials = imported

                # Commit: move materials then upsert project.
                moved: List[str] = []
                try:
                    if work_dir:
                        for src_path, dst_path in staged_materials:
                            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
                            shutil.move(src_path, dst_path)
                            moved.append(dst_path)
                    s.upsert(project)
                except Exception:
                    for p in moved:
                        try:
                            if os.path.exists(p):
                                os.remove(p)
                        except Exception:
                            pass
                    raise
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
        try:
            if work_dir and os.path.isdir(work_dir):
                shutil.rmtree(work_dir, ignore_errors=True)
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
    'local_zip': '',
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
    blocked = _block_when_remote('Import')
    if blocked:
        return blocked
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
        include_notify_audio = (request.form.get('includeNotifyAudio', 'true').lower() != 'false')
    except Exception:
        include_creds, include_vms, include_notify_audio = True, True, True
    try:
        import_as_templates = (request.form.get('importAsTemplates', 'false').lower() == 'true')
    except Exception:
        import_as_templates = False
    try:
        allow_best_effort = (request.form.get('allowBestEffort', 'false').lower() == 'true')
    except Exception:
        allow_best_effort = False
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
    import shutil
    uploads_dir = os.path.join(current_app.config["DATA_DIR"], "uploads")
    os.makedirs(uploads_dir, exist_ok=True)
    tmp_fd = None
    tmp_path = None
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(prefix="import_", suffix=".zip", dir=uploads_dir)
        os.close(tmp_fd)
        file.save(tmp_path)
        if not allow_best_effort:
            has_manifest = _zip_has_manifest(tmp_path)
            if not has_manifest:
                try:
                    if tmp_path and os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass
                return jsonify({"error": "Missing project.json in archive. Enable best-effort import to continue.", "code": "missing_manifest"}), 400
    except Exception as e:
        try:
            if tmp_fd:
                os.close(tmp_fd)
        except Exception:
            pass
        return jsonify({"error": f"Failed to save upload: {e}"}), 400

    upload_name = file.filename

    # Create job record and spawn worker
    job_id = uuid.uuid4().hex
    rec = _import_job_record(job_id)
    try:
        rec['local_zip'] = tmp_path
        _ACTIVE_JOBS[_import_job_key(job_id)] = rec
    except Exception:
        pass
    app_obj = current_app._get_current_object()

    def worker(job: str, path: str, include_creds: bool, include_vms: bool, include_notify_audio: bool, import_as_templates: bool, upload_name: str):
        # Ensure app context in thread
        with app_obj.app_context():
            key = _import_job_key(job)
            local_work_dir = ''
            try:
                if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                    _ACTIVE_JOBS[key]['status'] = 'cancelled'
                    return
                _ACTIVE_JOBS[key]['status'] = 'processing'
                _ACTIVE_JOBS[key]['progress'] = 0
                _emit_import(job, f"[FILE] {os.path.basename(path)}")

                # Stage all imported artifacts into a per-job work directory.
                # This ensures that cancelled imports do not partially persist projects
                # or leave behind orphaned materials.
                try:
                    import tempfile
                    uploads_dir2 = os.path.join(app_obj.config["DATA_DIR"], "uploads")
                    os.makedirs(uploads_dir2, exist_ok=True)
                    local_work_dir = tempfile.mkdtemp(prefix=f"import_work_{job}_", dir=uploads_dir2)
                    _ACTIVE_JOBS[key]['local_tmp'] = local_work_dir
                except Exception:
                    import tempfile
                    local_work_dir = tempfile.mkdtemp(prefix=f"import_work_{job}_")
                    try:
                        _ACTIVE_JOBS[key]['local_tmp'] = local_work_dir
                    except Exception:
                        pass

                # Open ZIP and inspect manifest
                with zipfile.ZipFile(path) as zf:
                    manifest, synthesized = _load_import_manifest(
                        zf,
                        default_project_name=_default_import_name(upload_name or path),
                    )
                    if synthesized:
                        _emit_import(job, "[PARSE] project.json missing; synthesized manifest (backups-only)")
                    else:
                        _emit_import(job, "[PARSE] project.json loaded")

                    s = _store()
                    mats_dir = os.path.join(app_obj.config["DATA_DIR"], "materials")
                    os.makedirs(mats_dir, exist_ok=True)

                    # Commit bookkeeping (atomic persistence):
                    # - projects_to_commit holds Project objects created during import
                    # - staged_materials holds (tmp_path, final_path) to move on success
                    projects_to_commit: List[Project] = []
                    staged_materials: List[Tuple[str, str]] = []

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
                            # Always import VM configuration; when include_vms is False, drop vmid (config-only)
                            pdata2['vms'] = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
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
                                "guacamole_url", "guacamole_url",
                                "keycloak_url", "keycloak_port", "keycloak_nodename",
                                "challenge_url", "challenge_port", "challenge_verify_ssl",
                                "instances", "tag", "vnc_start_port", "credentials",
                                "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
                                "proxmox_qmrestore_path", "proxmox_storage_volume",
                                "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
                                "proxmox_update_delay_seconds",
                            ]:
                                if key_field in pdata2:
                                    setattr(proj, key_field, pdata2[key_field])
                            # Preserve VM entries from manifest (names, adaptors, commands, etc.)
                            try:
                                proj.vms = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
                            except Exception:
                                proj.vms = []
                            try:
                                if 'audio' in pdata2 and isinstance(pdata2.get('audio'), dict):
                                    audio_map = dict(pdata2.get('audio') or {})
                                    if not include_notify_audio:
                                        audio_map = {k: v for k, v in audio_map.items() if not str(k).startswith('media:')}
                                    else:
                                        # Dedupe duplicate uploaded sounds by hash (within this import).
                                        audio_map = _dedupe_media_audio(audio_map)
                                    proj.audio = ProjectStore._sanitize_audio_map(audio_map)
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
                            id_map[pdata2.get('id','')] = new_id
                            results.append(proj.__dict__)
                            _emit_import(job, f"[STAGE] project: {proj.name} ({new_id})")
                            done_steps += 1; _tick('processing')

                            # Defer persistence until job completion.
                            try:
                                projects_to_commit.append(proj)
                            except Exception:
                                pass

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
                                tmp_out = os.path.join(local_work_dir, new_name)
                                with zf.open(zname) as src, open(tmp_out, 'wb') as dst:
                                    shutil.copyfileobj(src, dst, length=1024 * 1024)
                                staged_materials.append((tmp_out, os.path.join(mats_dir, new_name)))
                                # Attach material name to the in-memory project for later persistence.
                                try:
                                    proj = next((p for p in projects_to_commit if getattr(p, 'id', None) == target), None)
                                    if proj:
                                        proj.materials.append(new_name)
                                except Exception:
                                    pass
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
                        # Always import VM configuration; when include_vms is False, drop vmid (config-only)
                        pdata2['vms'] = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
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
                            "challenge_url", "challenge_port", "challenge_verify_ssl",
                            "instances", "tag", "vnc_start_port", "credentials",
                            "proxmox_vm_config_path", "proxmox_qm_path", "proxmox_pvesh_path",
                            "proxmox_qmrestore_path", "proxmox_storage_volume",
                            "proxmox_max_create_jobs", "proxmox_snapshot_delay_seconds",
                            "proxmox_update_delay_seconds",
                        ]:
                            if key_field in pdata2:
                                setattr(project, key_field, pdata2[key_field])
                        # Preserve VM entries from manifest
                        try:
                            project.vms = _sanitize_import_vms(pdata2.get('vms') or [], keep_vmid=include_vms)
                        except Exception:
                            project.vms = []
                        try:
                            if 'audio' in pdata2 and isinstance(pdata2.get('audio'), dict):
                                audio_map = dict(pdata2.get('audio') or {})
                                if not include_notify_audio:
                                    audio_map = {k: v for k, v in audio_map.items() if not str(k).startswith('media:')}
                                else:
                                    audio_map = _dedupe_media_audio(audio_map)
                                project.audio = ProjectStore._sanitize_audio_map(audio_map)
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
                            tmp_out = os.path.join(local_work_dir, new_name)
                            with zf.open(zname) as src, open(tmp_out, 'wb') as dst:
                                shutil.copyfileobj(src, dst, length=1024 * 1024)
                            staged_materials.append((tmp_out, os.path.join(mats_dir, new_name)))
                            imported.append(new_name)
                            _emit_import(job, f"[WRITE] {zname} -> {new_name}")
                            done_steps += 1; _tick('materials')
                        project.materials = imported

                        # Defer persistence until job completion.
                        projects_to_commit.append(project)
                        results.append(project.__dict__)
                        _emit_import(job, f"[STAGE] project: {project.name} ({new_id})")
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

                                        # Ensure bridge-ageing 0 for any imported internal bridges (interfaces + interfaces.new)
                                        try:
                                            bridges_needed: Set[str] = set()
                                            for vm in (getattr(project, 'vms', None) or []):
                                                if isinstance(vm, dict):
                                                    raw = (
                                                        vm.get('internal_network_adaptors')
                                                        or vm.get('internal_network_adapters')
                                                        or vm.get('internalNetworkAdaptors')
                                                        or vm.get('internalNetworkAdapters')
                                                    )
                                                else:
                                                    raw = getattr(vm, 'internal_network_adaptors', None)
                                                if not raw:
                                                    continue
                                                if isinstance(raw, (list, tuple, set)):
                                                    for b in raw:
                                                        try:
                                                            bridges_needed.add(_validate_iface(str(b)))
                                                        except Exception:
                                                            continue
                                                else:
                                                    try:
                                                        bridges_needed.add(_validate_iface(str(raw)))
                                                    except Exception:
                                                        pass
                                            if bridges_needed:
                                                _emit_import(job, f"[AGEING] ensuring bridge-ageing 0 for {len(bridges_needed)} bridge(s): {', '.join(sorted(bridges_needed))}")
                                                iface_list = ' '.join(sorted(bridges_needed))
                                                # Keep it idempotent; create interfaces.new if missing.
                                                ageing_script = (
                                                    "set -e; "
                                                    "MAIN=/etc/network/interfaces; NEW=/etc/network/interfaces.new; "
                                                    "[ -f $NEW ] || cp $MAIN $NEW; "
                                                    f"for IFACE in {iface_list}; do "
                                                    "for F in $MAIN $NEW; do [ -f $F ] || continue; "
                                                    "grep -Eq \"^iface ${IFACE} \" $F || echo \"iface ${IFACE} inet manual\" >> $F; "
                                                    "awk -v IFACE=\"$IFACE\" 'BEGIN{in=0;have=0} $1==\"iface\" { if(in && $2!=IFACE) in=0; if($2==IFACE){in=1; next} } in && ($1==\"bridge-ageing\" || $1==\"bridge_ageing\") && $2==\"0\" {have=1} END{exit(have?0:1)}' $F >/dev/null 2>&1 "
                                                    "|| sed -i \"/^iface ${IFACE} /a\\\\    bridge-ageing 0\" $F; "
                                                    "done; done"
                                                )
                                                import shlex
                                                use_sudo_ageing = (str(ssh_user).strip().lower() != 'root')
                                                _ssh_run_cmd(c, f"sh -lc {shlex.quote(ageing_script)}", sudo=use_sudo_ageing, sudo_password=password)
                                                _emit_import(job, "[AGEING] bridge-ageing 0 ensured (interfaces + interfaces.new)")
                                            else:
                                                _emit_import(job, "[AGEING] no internal bridges listed; skipping ageing update")
                                        except Exception as e:
                                            _emit_import(job, f"[AGEING][WARN] failed to apply bridge-ageing 0: {e}")
                                        # Discover vzdump backup archives in zip (ignore .log and other non-archives)
                                        backups = [
                                            n for n in zf.namelist()
                                            if n.startswith('backups/')
                                            and not n.endswith('/')
                                            and n.lower().endswith(('.vma.zst', '.vma.lzo', '.vma.gz', '.tar.zst', '.tar.lzo', '.tar.gz', '.tar'))
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
                                                is_lxc = any(zname.lower().endswith(ext) for ext in ('.tar.zst', '.tar.lzo', '.tar.gz', '.tar'))
                                                if is_lxc:
                                                    cmd = f"{getattr(project, 'proxmox_pctrestore_path', 'pct restore')} {vmid} {remote_path} --unique 1"
                                                else:
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
                                                    if is_lxc:
                                                        setname = f"pct set {vmid} --hostname {vm_name}"
                                                    else:
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
                                                # Optionally convert restored VMs to templates
                                                if import_as_templates:
                                                    try:
                                                        _emit_import(job, f"[TEMPLATE] converting {vm_name} ({vmid}) to template")
                                                        if is_lxc:
                                                            tmpl = f"pct template {vmid} 2>/dev/null || true"
                                                        else:
                                                            tmpl = f"qm template {vmid} 2>/dev/null || true"
                                                        _ssh_run_stream(
                                                            c,
                                                            tmpl,
                                                            sudo=use_sudo,
                                                            sudo_password=password,
                                                            emit=lambda m: _emit_import(job, m),
                                                        )
                                                    except Exception as e:
                                                        _emit_import(job, f"[TEMPLATE][WARN] failed to convert {vm_name} ({vmid}) to template: {e}")
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
                                                # Defer persistence until commit (after cancellation check).
                                            except Exception:
                                                pass
                                    finally:
                                        try:
                                            c.close()
                                        except Exception:
                                            pass
                            except Exception as e:
                                _emit_import(job, f"[WARN] VM restore step failed: {e}")

                    _ACTIVE_JOBS[key]['errors'] = errors
                    if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                        _ACTIVE_JOBS[key]['imported'] = []
                        _ACTIVE_JOBS[key]['status'] = 'cancelled'
                        _emit_import(job, "[CANCELLED] import cancelled")
                    else:
                        # Commit staged materials then persist projects.
                        try:
                            # If cancelled just before committing, do not persist anything.
                            if _ACTIVE_JOBS.get(key, {}).get('cancel'):
                                _ACTIVE_JOBS[key]['imported'] = []
                                _ACTIVE_JOBS[key]['status'] = 'cancelled'
                                _emit_import(job, "[CANCELLED] import cancelled")
                                return
                            _ACTIVE_JOBS[key]['status'] = 'finalizing'
                        except Exception:
                            pass
                        try:
                            for tmp_src, final_dst in staged_materials:
                                try:
                                    os.makedirs(os.path.dirname(final_dst), exist_ok=True)
                                except Exception:
                                    pass
                                try:
                                    shutil.move(tmp_src, final_dst)
                                except Exception:
                                    # Fall back to copy+remove
                                    try:
                                        shutil.copyfile(tmp_src, final_dst)
                                        try:
                                            os.remove(tmp_src)
                                        except Exception:
                                            pass
                                    except Exception:
                                        raise
                        except Exception as e:
                            raise RuntimeError(f"Failed to commit materials: {e}")

                        for proj in projects_to_commit:
                            try:
                                s.upsert(proj)
                            except Exception as e:
                                raise RuntimeError(f"Failed to persist project {getattr(proj, 'id', '')}: {e}")

                        _ACTIVE_JOBS[key]['imported'] = results
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
                # Cleanup staged work dir (best-effort)
                try:
                    if local_work_dir and os.path.isdir(local_work_dir):
                        import shutil
                        shutil.rmtree(local_work_dir, ignore_errors=True)
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

    t = threading.Thread(target=worker, args=(job_id, tmp_path, include_creds, include_vms, include_notify_audio, import_as_templates, upload_name), daemon=True)
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

    # If a job is already finalizing or finished, treat cancel as a no-op.
    # (The worker commits atomically at the end; cancelling during finalization
    # risks leaving partial on-disk state.)
    try:
        st = str(rec.get('status') or '').strip().lower()
    except Exception:
        st = ''
    if st in {'finalizing', 'completed', 'error', 'cancelled'}:
        return ('', 204)

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
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
    s = _store()
    ids = request.args.get("ids")
    include_materials = request.args.get("includeMaterials", "true").lower() != "false"
    include_creds = request.args.get("includeCreds", "true").lower() != "false"
    include_vms = request.args.get("includeVms", "true").lower() != "false"
    include_notify_audio = request.args.get("includeNotifyAudio", "true").lower() != "false"
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
        project_dict = _project_to_json_filtered(proj, include_creds=include_creds, include_vms=include_vms)
        if not include_notify_audio:
            try:
                audio_map = project_dict.get('audio')
                if isinstance(audio_map, dict):
                    project_dict['audio'] = {k: v for k, v in audio_map.items() if not str(k).startswith('media:')}
            except Exception:
                pass
        manifest = {
            "schemaVersion": 1,
            # Backward-compat: keep top-level key as 'projects' but only include the single selected project
            "projects": [project_dict],
        }
        zf.writestr("project.json", json.dumps(manifest, indent=2))
        if include_materials:
            if include_notify_audio:
                _write_project_audio_to_zip(zf, proj, include_prefixes=('media:',))
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
        fname = f"{stem}_{_format_ymdhms(_dt.datetime.now(_dt.timezone.utc))}.zip"
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
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
    s = _store()
    proj = s.get(pid)
    if not proj:
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(force=True) or {}
    include_creds = bool(data.get("includeCreds", True))
    include_vms = bool(data.get("includeVms", True))
    include_notify_audio = bool(data.get("includeNotifyAudio", True))
    if not include_vms:
        return jsonify({"error": "VM export not requested"}), 400
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not username or not password:
        return jsonify({"error": "Missing Proxmox credentials"}), 400

    base_url = (data.get('baseUrl') or getattr(proj, 'proxmox_url', '') or '').strip()
    api_port = data.get('apiPort')
    if api_port is None:
        api_port = getattr(proj, 'proxmox_api_port', None)
    try:
        if api_port is not None:
            port_int = int(api_port)
            if port_int > 0 and base_url:
                parsed = urlparse(base_url)
                hostname = parsed.hostname or ''
                scheme = parsed.scheme or 'https'
                netloc = hostname
                if parsed.username:
                    auth = parsed.username
                    if parsed.password:
                        auth += f":{parsed.password}"
                    netloc = f"{auth}@{netloc}"
                if hostname:
                    netloc = f"{netloc}:{port_int}"
                base_url = urlunparse((scheme, netloc, '', '', '', ''))
    except Exception:
        pass
    # Use explicit node name if configured, otherwise extract from URL
    explicit_node = (getattr(proj, 'proxmox_node', '') or '').strip()
    prox_host = explicit_node if explicit_node else (_parse_host_from_url(base_url) or '')
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
                    vms = client.list_qemu_vms(node_name) or []
                except Exception:
                    vms = []
                try:
                    if hasattr(client, 'list_lxc_vms'):
                        vms.extend(client.list_lxc_vms(node_name) or [])
                except Exception:
                    pass
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

            def _extract_readonly_signal(*chunks) -> str:
                keywords = ('not a writable', 'not writable', 'read-only')
                for chunk in chunks:
                    if not chunk:
                        continue
                    try:
                        text = str(chunk)
                    except Exception:
                        text = ''
                    if not text:
                        continue
                    for line in text.splitlines() or [text]:
                        line_text = line.strip()
                        if not line_text:
                            continue
                        try:
                            lowered = line_text.lower()
                        except Exception:
                            lowered = line_text
                        if any(keyword in lowered for keyword in keywords):
                            return line_text
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
                                name_to_id[parts[1]] = int(parts[0])
                            except Exception:
                                pass
                except Exception:
                    pass
                try:
                    _emit("[CMD] pct list")
                    out, err = _ssh_run_cmd(c, "pct list", sudo=use_sudo, sudo_password=password)
                    lines = _to_text(out.read()).splitlines()
                    for ln in lines[1:]:
                        parts = [p for p in ln.split() if p]
                        if len(parts) >= 2:
                            try:
                                # pct list output format: VMID       STATUS     NAME
                                # We need to handle potential status column
                                vmid_val = int(parts[0])
                                # Usually Name is the last or 3rd column, but let's just grab the last string if there's a status
                                # Let's be safer, Proxmox `pct list` usually has 3 columns.
                                if len(parts) >= 3:
                                    name_to_id[parts[2]] = vmid_val
                                else:
                                    name_to_id[parts[1]] = vmid_val
                            except Exception:
                                pass
                    _emit(f"[OUT] list parsed {len(name_to_id)} entries total")
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
                    _ssh_run_cmd(c, f"chmod 777 {base_remote}/{vm_name}", sudo=use_sudo, sudo_password=password)
                    # Run vzdump with streaming; dumpdir is absolute
                    cmd = f"vzdump {int(vmid)} --compress zstd --mode snapshot --remove 0 --zstd 0 --tmpdir {base_remote}/{vm_name} --dumpdir {base_remote}/{vm_name}"
                    def _run_vzdump_operation():
                        def on_line(_txt):
                            try:
                                vmrec['progress'] = min(95, vmrec.get('progress', 0) + 1)
                                _ACTIVE_JOBS[key]['per_vm'][idx] = vmrec
                                _ACTIVE_JOBS[key]['progress'] = int(((idx + vmrec['progress']/100.0) / max(total, 1)) * 80)
                            except Exception:
                                pass
                        stdout_text, stderr_text = _ssh_run_stream(
                            c,
                            cmd,
                            sudo=use_sudo,
                            sudo_password=password,
                            emit=lambda m: _emit(f"[{vm_name}] {m}"),
                            on_stdout_line=on_line,
                            cmd_prefix="[CMD]",
                        )
                        readonly_line = _extract_readonly_signal(stdout_text, stderr_text)
                        if readonly_line:
                            raise RuntimeError(readonly_line)

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
                    project_dict = _project_to_json_filtered(proj, include_creds=include_creds, include_vms=True)
                    if not include_notify_audio:
                        try:
                            audio_map = project_dict.get('audio')
                            if isinstance(audio_map, dict):
                                project_dict['audio'] = {k: v for k, v in audio_map.items() if not str(k).startswith('media:')}
                        except Exception:
                            pass
                    manifest = {
                        "schemaVersion": 1,
                        "project": project_dict,
                    }
                    manifest_bytes = json.dumps(manifest, indent=2).encode('utf-8')
                    zf.writestr("project.json", manifest_bytes)
                    _emit(f"[PKG] wrote project.json ({len(manifest_bytes)} bytes)")
                    if include_notify_audio:
                        audio_written = _write_project_audio_to_zip(zf, proj, include_prefixes=('media:',))
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
                            'timestamp': datetime_module.datetime.now(datetime_module.timezone.utc).isoformat().replace('+00:00', 'Z'),
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
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
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
    fname = f"{stem}_{_format_ymdhms(_dt.datetime.now(_dt.timezone.utc))}.zip"
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
    vm_type = str(data.get("vm_type") or "").strip().lower()
    if vm_type not in ["qemu", "lxc"]:
        vm_type = "qemu"
    try:
        proj = _store().add_vm(pid, name, vm_type=vm_type)
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
    for k in ["start_commands", "stored_commands", "validation_commands", "internal_network_adaptors"]:
        if k in data and isinstance(data[k], str):
            data[k] = [s.strip() for s in data[k].splitlines() if s.strip()]
    if "validation_commands" in data:
        data["validation_commands"] = sanitize_validation_commands(data.get("validation_commands"))
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
    if "vm_type" in data:
        val = str(data.get("vm_type") or "").strip().lower()
        if val not in ["qemu", "lxc"]:
            val = "qemu"
        data["vm_type"] = val
    try:
        # Only update fields explicitly provided in the payload to avoid accidental clearing
        fields = {}
        if "vmid" in data:
            fields["vmid"] = data.get("vmid")
        if "viewable_to_user" in data:
            fields["viewable_to_user"] = _coerce_enabled(data.get("viewable_to_user"), True)
        if "start_commands" in data:
            fields["start_commands"] = data.get("start_commands")
        if "stored_commands" in data:
            fields["stored_commands"] = data.get("stored_commands")
        if "validation_commands" in data:
            fields["validation_commands"] = data.get("validation_commands")
        if "internal_network_adaptors" in data:
            fields["internal_network_adaptors"] = data.get("internal_network_adaptors")
        if "vm_user" in data:
            fields["vm_user"] = data.get("vm_user")
        if "vm_pass" in data:
            fields["vm_pass"] = data.get("vm_pass")
        if "vm_type" in data:
            fields["vm_type"] = data.get("vm_type")

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
    rel_path = request.form.get('relative_path')
    if rel_path:
        try:
            rel_norm = str(rel_path).replace('\\', '/').strip('/')
            if rel_norm:
                parts = []
                for segment in rel_norm.split('/'):
                    safe = secure_filename(segment)
                    if safe:
                        parts.append(safe)
                if parts:
                    original = "__".join(parts)
        except Exception:
            pass
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
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
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
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
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
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
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
        dt = _dt.datetime.now(_dt.timezone.utc)
    fname = f"{stem}_{_format_ymdhms(dt)}.zip"
    return send_file(lp, mimetype="application/zip", as_attachment=True, download_name=fname)


@api_bp.route("/projects/<pid>/exports/<export_id>/reveal", methods=["POST"])
@_secure_route()
def reveal_export_in_finder(pid: str, export_id: str):
    blocked = _block_when_remote('Export')
    if blocked:
        return blocked
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
    Returns: { templates: [ { node, vmid, name, bridges, qemu_agent_enabled } ] }
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

        def _qemu_agent_enabled(cfg: dict) -> bool:
            raw = (cfg or {}).get('agent')
            if raw is None:
                return False
            if isinstance(raw, bool):
                return raw
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                return int(raw) != 0
            text = str(raw).strip().lower()
            if not text:
                return False
            truthy = {'1', 'true', 'yes', 'on', 'enabled'}
            falsy = {'0', 'false', 'no', 'off', 'disabled'}
            head = text.split(',', 1)[0].strip()
            if head in truthy:
                return True
            if head in falsy:
                return False
            for part in [p.strip() for p in text.split(',') if p.strip()]:
                if '=' not in part:
                    continue
                key, val = [x.strip() for x in part.split('=', 1)]
                if key != 'enabled':
                    continue
                if val in truthy:
                    return True
                if val in falsy:
                    return False
            return False

        for n in nodes:
            try:
                node_name = n.get('node') or n.get('id') or n.get('name')
                if not node_name:
                    continue
                qemu_vms = client.list_qemu_vms(str(node_name)) or []
                lxc_vms = []
                try:
                    if hasattr(client, 'list_lxc_vms'):
                        lxc_vms = client.list_lxc_vms(str(node_name)) or []
                except Exception:
                    pass

                for vm_type, vms in [('qemu', qemu_vms), ('lxc', lxc_vms)]:
                    for vm in vms:
                        try:
                            is_tmpl = vm.get('template') in (1, True, '1', 'true')
                            if not is_tmpl:
                                continue
                            vmid = vm.get('vmid')
                            name = vm.get('name') or vm.get('vmname') or vm.get('hostname') or ''
                            if vmid is None:
                                continue
                            try:
                                vmid = int(vmid)
                            except Exception:
                                continue
                            # Best-effort: fetch config to discover assigned bridges for this template
                            bridges = []
                            cfg = {}
                            try:
                                if vm_type == 'qemu':
                                    cfg = client.get_qemu_config(str(node_name), int(vmid)) or {}
                                else:
                                    cfg = client.get_lxc_config(str(node_name), int(vmid)) or {}
                                bridges = _extract_bridges(cfg)
                            except Exception:
                                bridges = []
                            out.append({
                                'node': str(node_name),
                                'vmid': vmid,
                                'name': str(name),
                                'bridges': bridges,
                                'type': vm_type,
                                'qemu_agent_enabled': _qemu_agent_enabled(cfg) if vm_type == 'qemu' else False,
                            })
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
