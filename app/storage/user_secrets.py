import json
import os
import threading
from typing import Dict, Optional


class UserSecretsStore:
    """Persist per-user, per-project encrypted secrets.

    Data is stored as encrypted strings (the API layer is responsible for
    encryption/decryption).
    """

    def __init__(self, data_dir: str, filename: str = "user_secrets.json"):
        self._data_dir = data_dir
        self._path = os.path.join(data_dir, filename)
        self._lock = threading.Lock()

    def _load(self) -> Dict:
        if not os.path.exists(self._path):
            return {"users": {}}
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return {"users": {}}
            if not isinstance(data.get("users"), dict):
                data["users"] = {}
            return data
        except Exception:
            return {"users": {}}

    def _save(self, data: Dict) -> None:
        os.makedirs(self._data_dir, exist_ok=True)
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self._path)

    def get_enc(self, username: str, project_id: str) -> Dict[str, str]:
        user = (username or "").strip() or "__anonymous__"
        pid = (project_id or "").strip()
        if not pid:
            return {}
        with self._lock:
            data = self._load()
            rec = (data.get("users") or {}).get(user) or {}
            projects = rec.get("projects") if isinstance(rec, dict) else None
            if not isinstance(projects, dict):
                return {}
            entry = projects.get(pid) or {}
            if not isinstance(entry, dict):
                return {}
            out: Dict[str, str] = {}
            for k in ("proxmox_username_enc", "proxmox_password_enc", "ctfd_token_enc"):
                v = entry.get(k)
                if isinstance(v, str) and v:
                    out[k] = v
            return out

    def upsert_enc(
        self,
        username: str,
        project_id: str,
        proxmox_username_enc: Optional[str] = None,
        proxmox_password_enc: Optional[str] = None,
        ctfd_token_enc: Optional[str] = None,
    ) -> None:
        user = (username or "").strip() or "__anonymous__"
        pid = (project_id or "").strip()
        if not pid:
            return
        with self._lock:
            data = self._load()
            users = data.setdefault("users", {})
            rec = users.get(user)
            if not isinstance(rec, dict):
                rec = {}
                users[user] = rec
            projects = rec.get("projects")
            if not isinstance(projects, dict):
                projects = {}
                rec["projects"] = projects
            entry = projects.get(pid)
            if not isinstance(entry, dict):
                entry = {}
                projects[pid] = entry

            if proxmox_username_enc is not None:
                entry["proxmox_username_enc"] = str(proxmox_username_enc or "")
            if proxmox_password_enc is not None:
                entry["proxmox_password_enc"] = str(proxmox_password_enc or "")
            if ctfd_token_enc is not None:
                entry["ctfd_token_enc"] = str(ctfd_token_enc or "")

            # If everything is empty, drop the project entry
            if not (entry.get("proxmox_username_enc") or entry.get("proxmox_password_enc") or entry.get("ctfd_token_enc")):
                try:
                    projects.pop(pid, None)
                except Exception:
                    pass

            # If user has no projects, drop the user entry
            if not projects:
                try:
                    users.pop(user, None)
                except Exception:
                    pass

            self._save(data)
