import json
import os
import tempfile
import base64
import hashlib
import ast
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional, Any

DEFAULT_COMMAND_TIMEOUT_SECONDS = 300
MAX_COMMAND_TIMEOUT_SECONDS = 86400


@dataclass
class StartCommand:
    command: str
    enabled: bool = True
    long_running: bool = False
    timeout_seconds: int = DEFAULT_COMMAND_TIMEOUT_SECONDS


@dataclass
class StartCommandStep:
    delay_seconds: float = 0.0
    commands: List[StartCommand] = field(default_factory=list)


def _clean_start_command(value: Any) -> str:
    try:
        text = str(value or "").strip()
    except Exception:
        text = ""
    return text


def _coerce_enabled(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if not normalized:
            return default
        if normalized in {"false", "0", "no", "off", "disabled"}:
            return False
        if normalized in {"true", "1", "yes", "on", "enabled"}:
            return True
    return bool(value)


def _coerce_timeout(value: Any, default: int = DEFAULT_COMMAND_TIMEOUT_SECONDS) -> int:
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
    if num > MAX_COMMAND_TIMEOUT_SECONDS:
        num = MAX_COMMAND_TIMEOUT_SECONDS
    return num


def sanitize_start_command_steps(value: Any) -> List[StartCommandStep]:
    steps: List[StartCommandStep] = []

    def coerce_delay(raw: Any) -> float:
        try:
            delay = float(raw)
        except (TypeError, ValueError):
            delay = 0.0
        if delay < 0:
            delay = 0.0
        return round(delay, 3)

    def normalize_command_entry(entry: Any) -> List[StartCommand]:
        normalized: List[StartCommand] = []
        if isinstance(entry, StartCommand):
            text = _clean_start_command(entry.command)
            if text:
                normalized.append(StartCommand(
                    command=text,
                    enabled=_coerce_enabled(entry.enabled),
                    long_running=_coerce_enabled(getattr(entry, 'long_running', False), False),
                    timeout_seconds=_coerce_timeout(getattr(entry, 'timeout_seconds', DEFAULT_COMMAND_TIMEOUT_SECONDS)),
                ))
            return normalized
        if isinstance(entry, dict):
            nested = entry.get("commands") or entry.get("cmds") or entry.get("parallel")
            if isinstance(nested, (list, tuple, set)):
                for sub in nested:
                    normalized.extend(normalize_command_entry(sub))
                return normalized
            text_source = entry.get("command")
            if text_source is None:
                for key in ("cmd", "value", "text"):
                    if entry.get(key) is not None:
                        text_source = entry.get(key)
                        break
            if isinstance(text_source, (list, tuple, set)):
                for sub in text_source:
                    normalized.extend(normalize_command_entry(sub))
                return normalized
            text = _clean_start_command(text_source)
            if not text:
                return normalized
            enabled_hint = entry.get("enabled")
            if enabled_hint is None and entry.get("disabled") is not None:
                enabled_hint = not entry.get("disabled")
            long_hint = entry.get("long_running")
            if long_hint is None:
                for alt in ("longRunning", "longrun", "long", "isLongRunning"):
                    if entry.get(alt) is not None:
                        long_hint = entry.get(alt)
                        break
            timeout_hint = entry.get("timeout_seconds")
            if timeout_hint is None:
                for alt in ("timeoutSeconds", "timeout", "timeout_sec", "timeoutSec"):
                    if entry.get(alt) is not None:
                        timeout_hint = entry.get(alt)
                        break
            normalized.append(StartCommand(
                command=text,
                enabled=_coerce_enabled(enabled_hint),
                long_running=_coerce_enabled(long_hint, False),
                timeout_seconds=_coerce_timeout(timeout_hint),
            ))
            return normalized
        if isinstance(entry, (list, tuple, set)):
            for item in entry:
                normalized.extend(normalize_command_entry(item))
            return normalized
        text = _clean_start_command(entry)
        if text:
            normalized.append(StartCommand(command=text, enabled=True, long_running=False, timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS))
        return normalized

    def append_step(delay: Any, commands_source: Any):
        commands: List[StartCommand] = []
        if isinstance(commands_source, (list, tuple, set)):
            for cmd in commands_source:
                commands.extend(normalize_command_entry(cmd))
        else:
            commands.extend(normalize_command_entry(commands_source))
        if not commands:
            return
        delay_val = coerce_delay(delay)
        cleaned_commands: List[StartCommand] = []
        for cmd in commands:
            if isinstance(cmd, StartCommand):
                text = _clean_start_command(cmd.command)
                if not text:
                    continue
                cleaned_commands.append(StartCommand(
                    command=text,
                    enabled=_coerce_enabled(cmd.enabled),
                    long_running=_coerce_enabled(getattr(cmd, 'long_running', False), False),
                    timeout_seconds=_coerce_timeout(getattr(cmd, 'timeout_seconds', DEFAULT_COMMAND_TIMEOUT_SECONDS)),
                ))
                continue
            if isinstance(cmd, dict):
                text = _clean_start_command(cmd.get('command') or cmd.get('cmd') or cmd.get('value') or cmd.get('text'))
                if not text:
                    continue
                enabled_hint = cmd.get('enabled')
                if enabled_hint is None and cmd.get('disabled') is not None:
                    enabled_hint = not cmd.get('disabled')
                long_hint = cmd.get('long_running')
                if long_hint is None:
                    for alt in ("longRunning", "longrun", "long", "isLongRunning"):
                        if cmd.get(alt) is not None:
                            long_hint = cmd.get(alt)
                            break
                timeout_hint = cmd.get('timeout_seconds')
                if timeout_hint is None:
                    for alt in ("timeoutSeconds", "timeout", "timeout_sec", "timeoutSec"):
                        if cmd.get(alt) is not None:
                            timeout_hint = cmd.get(alt)
                            break
                cleaned_commands.append(StartCommand(
                    command=text,
                    enabled=_coerce_enabled(enabled_hint),
                    long_running=_coerce_enabled(long_hint, False),
                    timeout_seconds=_coerce_timeout(timeout_hint),
                ))
                continue
            text = _clean_start_command(cmd)
            if not text:
                continue
            cleaned_commands.append(StartCommand(
                command=text,
                enabled=True,
                long_running=False,
                timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS,
            ))
        if not cleaned_commands:
            return
        steps.append(StartCommandStep(delay_seconds=delay_val, commands=cleaned_commands))

    if isinstance(value, StartCommandStep):
        append_step(value.delay_seconds, value.commands)
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, StartCommandStep):
                append_step(item.delay_seconds, item.commands)
                continue
            if isinstance(item, dict):
                commands = item.get("commands")
                if commands is None:
                    commands = item.get("cmds")
                if commands is None:
                    commands = item.get("parallel")
                delay = (
                    item.get("delay_seconds")
                    if item.get("delay_seconds") is not None
                    else item.get("delaySeconds")
                )
                if delay is None:
                    for alt in ("delay", "wait", "pause"):
                        if item.get(alt) is not None:
                            delay = item.get(alt)
                            break
                if commands is not None:
                    append_step(delay, commands)
                    continue
                single = item.get("command")
                if single is None:
                    single = item.get("cmd")
                append_step(delay, single)
                continue
            if isinstance(item, (list, tuple)):
                append_step(0.0, item)
                continue
            append_step(0.0, item)
    elif isinstance(value, (tuple, set)):
        append_step(0.0, list(value))
    elif isinstance(value, str):
        lines = [line.strip() for line in value.splitlines() if line.strip()]
        for line in lines:
            append_step(0.0, line)
    elif value is not None:
        append_step(0.0, value)

    return steps


@dataclass
class VMConfig:
    name: str
    vmid: Optional[int] = None
    viewable_to_user: bool = True
    start_commands: List[StartCommandStep] = field(default_factory=list)
    stored_commands: List[StartCommandStep] = field(default_factory=list)
    internal_network_adaptors: Optional[List[str]] = None
    # Advanced per-VM clone options
    use_linked_clone: Optional[bool] = None  # override project default
    clone_timeout_sec: Optional[int] = None  # override project timeout
    storage_volume: Optional[str] = None     # override project storage for full clone
    skip_post_clone_snapshot: Optional[bool] = None  # skip snapshot for this VM
    # Instance credentials
    vm_user: Optional[str] = None
    vm_pass: Optional[str] = None


@dataclass
class Project:
    id: str
    name: str
    # collections
    vms: List[VMConfig] = field(default_factory=list)
    materials: List[str] = field(default_factory=list)  # filenames under materials dir
    exports: List[Dict[str, Any]] = field(default_factory=list)  # export records: {id,timestamp,include_creds,include_vms,remote_path,host}
    audio: Dict[str, Any] = field(default_factory=dict)  # notification audio configuration (data URLs + metadata)
    # Per-project associations (other project IDs logically linked to this one)
    associated_projects: List[str] = field(default_factory=list)
    # configuration with defaults
    proxmox_url: str = "https://proxmox.localhost"
    proxmox_api_port: int = 8006
    proxmox_ssh_port: int = 22
    proxmox_node: str = ""  # explicit Proxmox node name (if empty, derived from URL hostname)
    proxmox_api_token: str = ""
    proxmox_verify_ssl: bool = True
    # Persisted project-scoped secrets (encrypted at rest by API helpers)
    proxmox_username_enc: str = ""
    proxmox_password_enc: str = ""
    ctfd_token_enc: str = ""
    guacamole_url: str = "https://guacamole.localhost"
    guacamole_port: int = 443
    keycloak_url: str = "https://keycloak.localhost"
    keycloak_port: int = 443
    keycloak_nodename: str = "node"
    challenge_url: str = "https://challenges.localhost"
    challenge_port: int = 443
    instances: int = 10
    tag: str = "-set-"
    vnc_start_port: int = 6000
    # List of credential objects: {"username": str, "password": str}
    credentials: List[Dict[str, str]] = field(default_factory=list)
    # Advanced: Proxmox Configuration
    proxmox_vm_config_path: str = "/etc/pve/qemu-server"
    proxmox_qm_path: str = "qm"
    proxmox_pvesh_path: str = "pvesh"
    proxmox_qmrestore_path: str = "qmrestore"
    proxmox_storage_volume: str = "local-lvm"
    proxmox_max_create_jobs: int = 5
    proxmox_snapshot_delay_seconds: float = 5.0
    proxmox_update_delay_seconds: float = 0.5
    proxmox_use_linked_clones: bool = True
    proxmox_assign_rollback_on_non_viewable: bool = True
    proxmox_clone_timeout_seconds: int = 1800
    proxmox_skip_post_clone_snapshot: bool = False
    # SSH overrides: resolve node names that aren't DNS-resolvable
    proxmox_ssh_host: str = ""  # global override for SSH host (use this instead of node name)
    proxmox_node_host_map: Dict[str, str] = field(default_factory=dict)  # map proxmox node name -> SSH hostname/IP
    # Per-instance statuses: [{ index:int, created:bool, managers:{ vm:str, guacamole:str, pools:str, keycloak:str, rocketchat:str, ctfd:str } }]
    instance_statuses: List[Dict[str, Any]] = field(default_factory=list)


class ProjectStore:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.db_path = os.path.join(self.data_dir, "projects.json")
        os.makedirs(self.data_dir, exist_ok=True)
        if not os.path.exists(self.db_path):
            self._write_all({})

        # One-time migration: clean up legacy/incorrectly persisted notification templates
        # so they show exactly what the user typed (plain strings).
        try:
            self._migrate_notify_templates_on_disk_once()
        except Exception:
            pass

    _NOTIFY_TPL_MIGRATION_FLAG = ".notify_templates_migrated_v1"

    def _notify_tpl_migration_flag_path(self) -> str:
        return os.path.join(self.data_dir, self._NOTIFY_TPL_MIGRATION_FLAG)

    @staticmethod
    def _normalize_notify_template_value(value: Any) -> str:
        """Best-effort normalize a notify template to a plain string.

        Supports:
        - string templates
        - dict templates with keys: text/tpl/template
        - legacy stringified Python dict repr (via ast.literal_eval)
        """
        tpl = value
        # Recover accidental Python dict reprs persisted as strings.
        if isinstance(tpl, str):
            s = tpl.strip()
            # If it looks like someone persisted a Python dict repr as a string,
            # attempt to recover it; otherwise treat unrecoverable forms as corrupted.
            if s.startswith('{') and len(s) <= 4096 and ("'text'" in s or '"text"' in s or "'template'" in s or '"template"' in s or "'tpl'" in s or '"tpl"' in s):
                try:
                    parsed = ast.literal_eval(s)
                except Exception:
                    parsed = None
                if isinstance(parsed, dict):
                    tpl = parsed
                else:
                    # Looks like a legacy-bad dict repr, but we can't recover it.
                    return ''
            else:
                return s

        if isinstance(tpl, dict):
            raw = tpl.get('text')
            if raw is None:
                raw = tpl.get('tpl')
            if raw is None:
                raw = tpl.get('template')
            try:
                return str(raw or '').strip()
            except Exception:
                return ''

        return ''

    def _migrate_notify_templates_on_disk_once(self) -> None:
        flag_path = self._notify_tpl_migration_flag_path()
        if os.path.exists(flag_path):
            return

        try:
            data = self._read_all()
        except Exception:
            return

        changed = False
        if isinstance(data, dict):
            for _pid, pdata in data.items():
                if not isinstance(pdata, dict):
                    continue
                audio = pdata.get('audio')
                if not isinstance(audio, dict):
                    continue

                audio_changed = False
                for raw_key, raw_entry in list(audio.items()):
                    try:
                        key = str(raw_key or '').strip()
                    except Exception:
                        key = ''
                    if not key.startswith('event:'):
                        continue
                    if not isinstance(raw_entry, dict):
                        continue

                    templates: List[Any] = []
                    had_any = ('speakTemplates' in raw_entry) or ('speakTemplate' in raw_entry)
                    raw_templates = raw_entry.get('speakTemplates')
                    if isinstance(raw_templates, list):
                        for tpl in raw_templates:
                            # Preserve dict templates with per-template soundKey when present.
                            if isinstance(tpl, dict):
                                text = self._normalize_notify_template_value(tpl)
                                if not text:
                                    continue
                                sound_key = tpl.get('soundKey')
                                enabled = tpl.get('enabled')
                                try:
                                    sound_key_str = str(sound_key or '').strip() if sound_key is not None else ''
                                except Exception:
                                    sound_key_str = ''
                                if sound_key_str:
                                    item: Dict[str, Any] = {'text': text, 'soundKey': sound_key_str}
                                    if isinstance(enabled, bool) and enabled is False:
                                        item['enabled'] = False
                                    templates.append(item)  # type: ignore[list-item]
                                else:
                                    templates.append(text)  # type: ignore[list-item]
                            else:
                                text = self._normalize_notify_template_value(tpl)
                                if text:
                                    templates.append(text)  # type: ignore[list-item]

                    raw_single = raw_entry.get('speakTemplate')
                    if raw_single is not None:
                        text = self._normalize_notify_template_value(raw_single)
                        if text:
                            templates.append(text)  # type: ignore[list-item]

                    # Rewrite whenever the entry had templates fields, even if the result is empty
                    # (so corrupted templates get removed from disk).
                    if had_any:
                        current_list = raw_entry.get('speakTemplates') if isinstance(raw_entry.get('speakTemplates'), list) else None
                        if current_list != templates or ('speakTemplate' in raw_entry):
                            if templates:
                                raw_entry['speakTemplates'] = templates
                            else:
                                raw_entry.pop('speakTemplates', None)
                            raw_entry.pop('speakTemplate', None)
                            audio_changed = True

                if audio_changed:
                    pdata['audio'] = audio
                    changed = True

        if changed:
            self._write_all(data)

        # Mark migration complete (even if no changes were needed) to avoid
        # repeatedly scanning on each request.
        try:
            with open(flag_path, 'w', encoding='utf-8') as f:
                f.write('ok')
        except Exception:
            pass

    # Maximum decoded audio bytes per clip.
    # Note: stored as base64 data URLs inside projects.json, so large clips can grow the JSON file quickly.
    _MAX_AUDIO_BYTES = 10 * 1024 * 1024  # 10 MB

    @classmethod
    def _decode_data_url(cls, data_url: str):
        try:
            if not isinstance(data_url, str):
                return None, b""
            if not data_url.startswith('data:'):
                return None, b""
            header, payload = data_url.split(',', 1)
            if ';base64' not in header:
                return None, b""
            mime = header[5:].split(';')[0] or 'application/octet-stream'
            raw = base64.b64decode(payload, validate=True)
            return mime, raw
        except Exception:
            return None, b""

    @classmethod
    def _sanitize_audio_map(cls, value: Any) -> Dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        clean: Dict[str, Any] = {}
        for raw_key, raw_entry in value.items():
            try:
                key = str(raw_key or '').strip()
            except Exception:
                key = ''
            if not key:
                continue
            if not isinstance(raw_entry, dict):
                continue
            entry: Dict[str, Any] = {}
            # Preserve simple scalar fields (bool/int/float/short str)
            for scalar_key, scalar_val in raw_entry.items():
                if scalar_key in {'sounds', 'speakTemplates', 'speakTemplate', 'dataUrl', 'name', 'size', 'type', 'updated'}:
                    continue
                if isinstance(scalar_val, bool):
                    entry[scalar_key] = bool(scalar_val)
                elif isinstance(scalar_val, (int, float)) and not isinstance(scalar_val, bool):
                    entry[scalar_key] = scalar_val
                elif isinstance(scalar_val, str):
                    trimmed = scalar_val.strip()
                    if trimmed:
                        entry[scalar_key] = trimmed
            # Normalize speak templates
            # Allow per-template dict format: {text: str, enabled?: bool, soundKey?: str}
            templates: List[Any] = []
            raw_templates = raw_entry.get('speakTemplates')
            if isinstance(raw_templates, list):
                for tpl in raw_templates:
                    # Preserve dict templates (for per-template audio selection).
                    if isinstance(tpl, dict):
                        try:
                            raw = tpl.get('text')
                            if raw is None:
                                raw = tpl.get('tpl')
                            if raw is None:
                                raw = tpl.get('template')
                            text = str(raw or '').strip()
                        except Exception:
                            text = ''
                        if not text:
                            continue
                        try:
                            sound_key = str(tpl.get('soundKey') or '').strip() if tpl.get('soundKey') is not None else ''
                        except Exception:
                            sound_key = ''
                        enabled = tpl.get('enabled')
                        if sound_key:
                            item: Dict[str, Any] = {'text': text, 'soundKey': sound_key}
                            if isinstance(enabled, bool) and enabled is False:
                                item['enabled'] = False
                            templates.append(item)
                        else:
                            templates.append(text)
                        continue

                    # Strings remain strings (including legacy stringified dict reprs).
                    if isinstance(tpl, str):
                        s = tpl.strip()
                        # Some legacy data was accidentally persisted as a Python dict repr;
                        # recover only the text content and persist as a plain string.
                        if s.startswith('{') and len(s) <= 4096 and ("'text'" in s or '"text"' in s or "'template'" in s or '"template"' in s):
                            try:
                                parsed = ast.literal_eval(s)
                            except Exception:
                                parsed = None
                            if isinstance(parsed, dict):
                                try:
                                    raw = parsed.get('text')
                                    if raw is None:
                                        raw = parsed.get('tpl')
                                    if raw is None:
                                        raw = parsed.get('template')
                                    text = str(raw or '').strip()
                                except Exception:
                                    text = ''
                                if text:
                                    templates.append(text)
                            # If unrecoverable, drop it.
                        else:
                            if s:
                                templates.append(s)
                        continue

                    # Ignore non-string/non-dict entries.
                    continue
            raw_single_tpl = raw_entry.get('speakTemplate')
            if raw_single_tpl is not None:
                try:
                    tpl_norm = raw_single_tpl
                    if isinstance(tpl_norm, str):
                        s = tpl_norm.strip()
                        if s.startswith('{') and len(s) <= 4096 and ("'text'" in s or '"text"' in s or "'template'" in s or '"template"' in s):
                            try:
                                parsed = ast.literal_eval(s)
                            except Exception:
                                parsed = None
                            if isinstance(parsed, dict):
                                tpl_norm = parsed
                            else:
                                text = ''
                        else:
                            text = s

                    if not text and isinstance(tpl_norm, dict):
                        raw = tpl_norm.get('text')
                        if raw is None:
                            raw = tpl_norm.get('tpl')
                        if raw is None:
                            raw = tpl_norm.get('template')
                        text = str(raw or '').strip()
                    elif not text and not isinstance(tpl_norm, str):
                        text = ''
                except Exception:
                    text = ''
                if text:
                    templates.append(text)
            if templates:
                entry['speakTemplates'] = templates

            sounds: List[Dict[str, Any]] = []

            def _ingest_sound(sound_obj: Dict[str, Any]):
                if not isinstance(sound_obj, dict):
                    return
                data_url = sound_obj.get('dataUrl')
                try:
                    data_url = str(data_url or '').strip()
                except Exception:
                    data_url = ''
                if not data_url.startswith('data:'):
                    return
                mime, raw_bytes = cls._decode_data_url(data_url)
                if raw_bytes and len(raw_bytes) > cls._MAX_AUDIO_BYTES:
                    return
                if not raw_bytes:
                    return
                sha256_hex = ''
                try:
                    sha256_hex = hashlib.sha256(raw_bytes).hexdigest()
                except Exception:
                    sha256_hex = ''
                enc = base64.b64encode(raw_bytes).decode('ascii') if raw_bytes else ''
                if not enc:
                    return
                mime_type = mime or 'application/octet-stream'
                normalized_url = f"data:{mime_type};base64,{enc}"
                sound_rec: Dict[str, Any] = {'dataUrl': normalized_url}
                if sha256_hex:
                    sound_rec['sha256'] = sha256_hex
                size_hint = sound_obj.get('size')
                if isinstance(size_hint, (int, float)) and size_hint >= 0:
                    sound_rec['size'] = int(size_hint)
                else:
                    sound_rec['size'] = len(raw_bytes)
                name = sound_obj.get('name')
                if name is not None:
                    try:
                        label = str(name).strip()
                    except Exception:
                        label = ''
                    if label:
                        sound_rec['name'] = label[:160]
                type_hint = sound_obj.get('type')
                if type_hint is not None:
                    try:
                        tlabel = str(type_hint).strip()
                    except Exception:
                        tlabel = ''
                    if tlabel:
                        sound_rec['type'] = tlabel[:160]
                updated_val = sound_obj.get('updated')
                try:
                    if isinstance(updated_val, (int, float)):
                        sound_rec['updated'] = int(updated_val)
                except Exception:
                    pass
                sounds.append(sound_rec)

            raw_sounds = raw_entry.get('sounds')
            if isinstance(raw_sounds, list):
                for sound in raw_sounds:
                    _ingest_sound(sound)

            # Legacy single sound fields
            legacy_sound = {
                'dataUrl': raw_entry.get('dataUrl'),
                'name': raw_entry.get('name'),
                'size': raw_entry.get('size'),
                'type': raw_entry.get('type'),
                'updated': raw_entry.get('updated'),
            }
            if legacy_sound.get('dataUrl'):
                _ingest_sound(legacy_sound)

            if sounds:
                entry['sounds'] = sounds

            clean[key] = entry
        return clean

    def _read_all(self) -> Dict[str, Dict]:
        with open(self.db_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_all(self, data: Dict[str, Dict]):
        # Use a unique tmp file per write to avoid collisions between concurrent writers
        os.makedirs(self.data_dir, exist_ok=True)
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(
                dir=os.path.dirname(self.db_path),
                prefix=os.path.basename(self.db_path) + ".",
                suffix=".tmp",
            )
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.db_path)
        except Exception:
            try:
                if tmp_path and os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            raise

    def _coerce_vm(self, v: Any) -> VMConfig:
        if isinstance(v, str):
            return VMConfig(name=v)
        if isinstance(v, dict):
            base = asdict(VMConfig(name=v.get("name", "")))
            for k, val in v.items():
                # Canonicalize spelling variant
                if k == "internal_network_adapters" and "internal_network_adaptors" not in v:
                    k = "internal_network_adaptors"
                if k in base:
                    base[k] = val
            # Ensure viewable_to_user is a real bool (older data may store strings)
            try:
                base["viewable_to_user"] = _coerce_enabled(base.get("viewable_to_user"), True)
            except Exception:
                base["viewable_to_user"] = True
            # Normalize vmid to int if present
            if base.get("vmid") is not None:
                try:
                    base["vmid"] = int(base["vmid"]) if str(base["vmid"]).strip() != "" else None
                except Exception:
                    base["vmid"] = None
            base["start_commands"] = sanitize_start_command_steps(base.get("start_commands"))
            base["stored_commands"] = sanitize_start_command_steps(base.get("stored_commands"))
            if base.get("vm_user") is not None:
                base["vm_user"] = str(base["vm_user"])
            if base.get("vm_pass") is not None:
                base["vm_pass"] = str(base["vm_pass"])
            return VMConfig(**base)
        # fallback
        return VMConfig(name=str(v))

    def _coerce(self, pdata: Dict) -> Project:
        # Backward-compatible: fill missing fields with defaults
        base = asdict(Project(id=pdata.get("id", ""), name=pdata.get("name", "")))
        for k, v in pdata.items():
            if k == "vms":
                try:
                    base["vms"] = [self._coerce_vm(x) for x in (v or [])]
                except Exception:
                    base["vms"] = []
            elif k == "credentials":
                coerced: List[Dict[str, str]] = []
                try:
                    if isinstance(v, list):
                        for item in v:
                            if isinstance(item, dict):
                                u = str(item.get("username", "")).strip()
                                p = str(item.get("password", "")).strip()
                                if u:
                                    coerced.append({"username": u, "password": p})
                            elif isinstance(item, str):
                                u = item.strip()
                                if u:
                                    coerced.append({"username": u, "password": ""})
                    base["credentials"] = coerced
                except Exception:
                    base["credentials"] = []
            elif k == "proxmox_assign_rollback_on_non_viewable":
                try:
                    base[k] = _coerce_enabled(v, True)
                except Exception:
                    base[k] = True
            elif k == "exports":
                try:
                    if isinstance(v, list):
                        # ensure dict items with minimum fields
                        out = []
                        for item in v:
                            if isinstance(item, dict):
                                rec = {
                                    "id": str(item.get("id", "")),
                                    "timestamp": str(item.get("timestamp", "")),
                                    "include_creds": bool(item.get("include_creds", False)),
                                    "include_vms": bool(item.get("include_vms", False)),
                                    # Legacy (remote-first exports)
                                    "remote_path": str(item.get("remote_path", "")),
                                    "host": str(item.get("host", "")),
                                }
                                # Preserve local-first export fields so UI can show existence/size
                                if "local_path" in item:
                                    rec["local_path"] = str(item.get("local_path", ""))
                                if "filename" in item:
                                    rec["filename"] = str(item.get("filename", ""))
                                if "size" in item:
                                    try:
                                        rec["size"] = int(item.get("size") or 0)
                                    except Exception:
                                        rec["size"] = 0
                                out.append(rec)
                        base["exports"] = out
                except Exception:
                    base["exports"] = []
            elif k == "associated_projects":
                try:
                    out: List[str] = []
                    if isinstance(v, list):
                        for item in v:
                            s = str(item).strip()
                            if s:
                                out.append(s)
                    # de-duplicate while preserving order
                    seen = set()
                    dedup: List[str] = []
                    for s in out:
                        if s not in seen:
                            seen.add(s)
                            dedup.append(s)
                    base["associated_projects"] = dedup
                except Exception:
                    base["associated_projects"] = []
            elif k == "audio":
                try:
                    base["audio"] = self._sanitize_audio_map(v)
                except Exception:
                    base["audio"] = {}
            elif k in base:
                base[k] = v
        return Project(**base)

    def list(self) -> List[Project]:
        # Load all raw, coerce to dataclasses
        raw = self._read_all()
        projects: Dict[str, Project] = {}
        for pid, pdata in raw.items():
            try:
                projects[pid] = self._coerce(pdata or {})
            except Exception:
                # Skip malformed entries
                continue
        # Sanitize associations: remove self, non-existent, and duplicates
        known_ids = set(projects.keys())
        changed = False
        for pid, proj in projects.items():
            try:
                assoc = list(proj.associated_projects or [])
            except Exception:
                assoc = []
            clean: List[str] = []
            seen = set()
            for a in assoc:
                try:
                    s = str(a).strip()
                except Exception:
                    s = ''
                if (not s) or (s == pid) or (s not in known_ids) or (s in seen):
                    continue
                seen.add(s)
                clean.append(s)
            if clean != (proj.associated_projects or []):
                proj.associated_projects = clean
                changed = True
        # Persist any sanitization changes back to disk
        if changed:
            out = { pid: asdict(p) for pid, p in projects.items() }
            self._write_all(out)
        return list(projects.values())

    def get(self, pid: str) -> Optional[Project]:
        allp = self._read_all()
        data = allp.get(pid)
        if not data:
            return None
        proj = self._coerce(data)
        # sanitize associations for this project with current known ids
        try:
            known_ids = set(allp.keys())
            assoc = list(proj.associated_projects or [])
        except Exception:
            assoc = []
            known_ids = set(allp.keys())
        clean: List[str] = []
        seen = set()
        for a in assoc:
            s = str(a).strip()
            if (not s) or (s == pid) or (s not in known_ids) or (s in seen):
                continue
            seen.add(s)
            clean.append(s)
        if clean != (proj.associated_projects or []):
            proj.associated_projects = clean
            # write back only this project
            allp[pid] = asdict(proj)
            self._write_all(allp)
        return proj

    def upsert(self, project: Project) -> Project:
        allp = self._read_all()
        allp[project.id] = asdict(project)
        self._write_all(allp)
        return project

    def update_audio(self, pid: str, audio: Dict[str, Any]) -> Project:
        proj = self.get(pid)
        if not proj:
            raise KeyError("Project not found")
        sanitized = self._sanitize_audio_map(audio)
        proj.audio = sanitized
        self.upsert(proj)
        return proj

    def delete(self, pid: str) -> bool:
        allp = self._read_all()
        if pid not in allp:
            return False
        # Remove the project itself
        del allp[pid]
        # Remove references to this pid from other projects' associations
        changed = True
        for k, pdata in list(allp.items()):
            try:
                assoc = pdata.get('associated_projects') or []
                if not isinstance(assoc, list):
                    continue
                new_assoc = [str(x) for x in assoc if str(x) != str(pid)]
                if new_assoc != assoc:
                    pdata['associated_projects'] = new_assoc
                    allp[k] = pdata
                    changed = True
            except Exception:
                continue
        self._write_all(allp)
        return True

    def add_vm(self, pid: str, vm_name: str) -> Project:
        proj = self.get(pid)
        if not proj:
            raise KeyError("Project not found")
        exists = any(vm.name == vm_name for vm in proj.vms)
        if not exists:
            proj.vms.append(VMConfig(name=vm_name))
            self.upsert(proj)
        return proj

    def remove_vm(self, pid: str, vm_name: str) -> Project:
        proj = self.get(pid)
        if not proj:
            raise KeyError("Project not found")
        proj.vms = [v for v in proj.vms if v.name != vm_name]
        self.upsert(proj)
        return proj

    def update_vm(self, pid: str, vm_name: str, **fields) -> Project:
        proj = self.get(pid)
        if not proj:
            raise KeyError("Project not found")
        found = False
        for i, vm in enumerate(proj.vms):
            if vm.name == vm_name:
                found = True
                vm_data = asdict(vm)
                for k in [
                    "vmid",
                    "viewable_to_user",
                    "start_commands",
                    "stored_commands",
                    "internal_network_adaptors",
                    "use_linked_clone",
                    "clone_timeout_sec",
                    "storage_volume",
                    "skip_post_clone_snapshot",
                    "vm_user",
                    "vm_pass",
                ]:
                    if k in fields:
                        if k == "start_commands":
                            vm_data[k] = sanitize_start_command_steps(fields[k])
                        elif k == "stored_commands":
                            vm_data[k] = sanitize_start_command_steps(fields[k])
                        else:
                            vm_data[k] = fields[k]
                # Coerce vmid to int or None
                if "vmid" in vm_data:
                    try:
                        vm_data["vmid"] = int(vm_data["vmid"]) if str(vm_data["vmid"]).strip() != "" else None
                    except Exception:
                        vm_data["vmid"] = None
                vm_data["start_commands"] = sanitize_start_command_steps(vm_data.get("start_commands"))
                vm_data["stored_commands"] = sanitize_start_command_steps(vm_data.get("stored_commands"))
                proj.vms[i] = VMConfig(**vm_data)
                break
        if not found:
            raise KeyError("VM not found")
        self.upsert(proj)
        return proj

    def rename_vm(self, pid: str, old_name: str, new_name: str) -> Project:
        proj = self.get(pid)
        if not proj:
            raise KeyError("Project not found")
        new_name = (new_name or "").strip()
        if not new_name:
            raise ValueError("New VM name must be non-empty")
        if any(vm.name == new_name for vm in proj.vms):
            raise ValueError("A VM with that name already exists")
        changed = False
        for i, vm in enumerate(proj.vms):
            if vm.name == old_name:
                proj.vms[i] = VMConfig(name=new_name,
                                       vmid=vm.vmid,
                                       viewable_to_user=vm.viewable_to_user,
                                       start_commands=sanitize_start_command_steps(vm.start_commands),
                                       stored_commands=sanitize_start_command_steps(vm.stored_commands),
                                       internal_network_adaptors=vm.internal_network_adaptors,
                                       use_linked_clone=vm.use_linked_clone,
                                       clone_timeout_sec=vm.clone_timeout_sec,
                                       storage_volume=vm.storage_volume,
                                       skip_post_clone_snapshot=vm.skip_post_clone_snapshot)
                changed = True
                break
        if not changed:
            raise KeyError("VM not found")
        self.upsert(proj)
        return proj

    def add_material(self, pid: str, filename: str) -> Project:
        proj = self.get(pid)
        if not proj:
            raise KeyError("Project not found")
        if filename not in proj.materials:
            proj.materials.append(filename)
            self.upsert(proj)
        return proj

    def remove_material(self, pid: str, filename: str) -> Project:
        proj = self.get(pid)
        if not proj:
            raise KeyError("Project not found")
        proj.materials = [m for m in proj.materials if m != filename]
        self.upsert(proj)
        return proj
