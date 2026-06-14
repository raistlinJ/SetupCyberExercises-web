import json
import os
import tempfile
import threading
from typing import Any, Dict, Optional


class RuntimeStore:
    """Persist small runtime-wide settings under the shared data dir.

    Currently stores:
      - runMode: 'local' (default) or 'remote'
            - vmValidation: { normalized_vm_key: bool }
    """
    _lock = threading.Lock()


    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.db_path = os.path.join(self.data_dir, "runtime.json")

    def _read_all(self) -> Dict[str, Any]:
        try:
            with open(self.db_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except Exception:
            return {}

    def _write_all(self, data: Dict[str, Any]):
        os.makedirs(self.data_dir, exist_ok=True)
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(
                dir=os.path.dirname(self.db_path),
                prefix=os.path.basename(self.db_path) + ".",
                suffix=".tmp",
            )
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data or {}, f, indent=2, sort_keys=True)
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

    @staticmethod
    def _normalize_run_mode(value: Any) -> str:
        try:
            text = str(value or "").strip().lower()
        except Exception:
            text = ""
        return "remote" if text == "remote" else "local"

    def get_run_mode(self) -> str:
        data = self._read_all()
        return self._normalize_run_mode(data.get("runMode"))

    def set_run_mode(self, mode: Any) -> str:
        normalized = self._normalize_run_mode(mode)
        with self._lock:
            data = self._read_all()
            if normalized == "local":
                data.pop("runMode", None)
            else:
                data["runMode"] = "remote"
            self._write_all(data)
        return normalized

    @staticmethod
    def _normalize_vm_validation_key(project_id: Any, vm_name: Any, vmid: Any = None, node: Any = None) -> str:
        try:
            pid = str(project_id or "").strip()
        except Exception:
            pid = ""
        try:
            name = str(vm_name or "").strip()
        except Exception:
            name = ""
        try:
            vmid_text = "" if vmid is None or str(vmid).strip() == "" else str(int(vmid))
        except Exception:
            try:
                vmid_text = str(vmid or "").strip()
            except Exception:
                vmid_text = ""
        try:
            node_text = str(node or "").strip()
        except Exception:
            node_text = ""
        return f"{pid}|{name}|{vmid_text}|{node_text}"

    def get_vm_validation_state(self, project_id: Any, vm_name: Any, vmid: Any = None, node: Any = None) -> bool:
        result = self.get_vm_validation_result(project_id, vm_name, vmid=vmid, node=node)
        return bool(result)

    def get_vm_validation_result(self, project_id: Any, vm_name: Any, vmid: Any = None, node: Any = None) -> Optional[bool]:
        data = self._read_all()
        try:
            validation_map = data.get("vmValidation") if isinstance(data, dict) else {}
        except Exception:
            validation_map = {}
        if not isinstance(validation_map, dict):
            return None
        key = self._normalize_vm_validation_key(project_id, vm_name, vmid, node)
        raw = validation_map.get(key)
        if raw is None and vmid is not None and str(vmid).strip() != "":
            try:
                pid_text = str(project_id or "").strip()
            except Exception:
                pid_text = ""
            try:
                vmid_text = str(int(vmid))
            except Exception:
                vmid_text = str(vmid or "").strip()
            try:
                node_text = str(node or "").strip()
            except Exception:
                node_text = ""
            fallback_suffix = f"|{vmid_text}|{node_text}"
            for existing_key, existing_raw in validation_map.items():
                try:
                    existing_key_text = str(existing_key)
                except Exception:
                    continue
                if not existing_key_text.startswith(f"{pid_text}|"):
                    continue
                if existing_key_text.endswith(fallback_suffix):
                    raw = existing_raw
                    break
        if raw is None:
            return None
        if isinstance(raw, dict):
            raw = raw.get("passed")
        if raw is None:
            return None
        return bool(raw)

    def set_vm_validation_state(self, project_id: Any, vm_name: Any, passed: Any, vmid: Any = None, node: Any = None) -> bool:
        with self._lock:
            data = self._read_all()
            validation_map = data.get("vmValidation") if isinstance(data.get("vmValidation"), dict) else {}
            key = self._normalize_vm_validation_key(project_id, vm_name, vmid, node)
            validation_map[key] = bool(passed)
            data["vmValidation"] = validation_map
            self._write_all(data)
            return bool(validation_map[key])

    def clear_vm_validation_state(self, project_id: Any, vm_name: Any, vmid: Any = None, node: Any = None) -> None:
        with self._lock:
            data = self._read_all()
            validation_map = data.get("vmValidation") if isinstance(data.get("vmValidation"), dict) else {}
            key = self._normalize_vm_validation_key(project_id, vm_name, vmid, node)
            if key in validation_map:
                validation_map.pop(key, None)
                if validation_map:
                    data["vmValidation"] = validation_map
                else:
                    data.pop("vmValidation", None)
                self._write_all(data)
