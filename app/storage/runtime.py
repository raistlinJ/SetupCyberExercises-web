import json
import os
import tempfile
from typing import Any, Dict


class RuntimeStore:
    """Persist small runtime-wide settings under the shared data dir.

    Currently stores:
      - runMode: 'local' (default) or 'remote'
    """

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
        data = self._read_all()
        if normalized == "local":
            data.pop("runMode", None)
        else:
            data["runMode"] = "remote"
        self._write_all(data)
        return normalized
