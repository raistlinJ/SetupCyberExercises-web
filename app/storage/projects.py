import json
import os
import base64
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional, Any


@dataclass
class VMConfig:
    name: str
    vmid: Optional[int] = None
    viewable_to_user: bool = True
    start_commands: Optional[List[str]] = None
    stored_commands: Optional[List[str]] = None
    internal_network_adaptors: Optional[List[str]] = None
    # Advanced per-VM clone options
    use_linked_clone: Optional[bool] = None  # override project default
    clone_timeout_sec: Optional[int] = None  # override project timeout
    storage_volume: Optional[str] = None     # override project storage for full clone
    skip_post_clone_snapshot: Optional[bool] = None  # skip snapshot for this VM


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
    proxmox_api_token: str = ""
    proxmox_verify_ssl: bool = True
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
    proxmox_max_create_jobs: int = 20
    proxmox_snapshot_delay_seconds: float = 5.0
    proxmox_use_linked_clones: bool = True
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

    _MAX_AUDIO_BYTES = 600 * 1024  # 600 KB, matches front-end limit per clip

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
            templates: List[str] = []
            raw_templates = raw_entry.get('speakTemplates')
            if isinstance(raw_templates, list):
                for tpl in raw_templates:
                    try:
                        text = str(tpl or '').strip()
                    except Exception:
                        text = ''
                    if text:
                        templates.append(text)
            raw_single_tpl = raw_entry.get('speakTemplate')
            if raw_single_tpl is not None:
                try:
                    text = str(raw_single_tpl).strip()
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
                enc = base64.b64encode(raw_bytes).decode('ascii') if raw_bytes else ''
                if not enc:
                    return
                mime_type = mime or 'application/octet-stream'
                normalized_url = f"data:{mime_type};base64,{enc}"
                sound_rec: Dict[str, Any] = {'dataUrl': normalized_url}
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
        tmp = self.db_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, self.db_path)

    def _coerce_vm(self, v: Any) -> VMConfig:
        if isinstance(v, str):
            return VMConfig(name=v)
        if isinstance(v, dict):
            base = asdict(VMConfig(name=v.get("name", "")))
            for k, val in v.items():
                if k in base:
                    base[k] = val
            # Normalize vmid to int if present
            if base.get("vmid") is not None:
                try:
                    base["vmid"] = int(base["vmid"]) if str(base["vmid"]).strip() != "" else None
                except Exception:
                    base["vmid"] = None
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
                ]:
                    if k in fields:
                        vm_data[k] = fields[k]
                # Coerce vmid to int or None
                if "vmid" in vm_data:
                    try:
                        vm_data["vmid"] = int(vm_data["vmid"]) if str(vm_data["vmid"]).strip() != "" else None
                    except Exception:
                        vm_data["vmid"] = None
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
                                       start_commands=vm.start_commands,
                                       stored_commands=vm.stored_commands,
                                       internal_network_adaptors=vm.internal_network_adaptors)
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
