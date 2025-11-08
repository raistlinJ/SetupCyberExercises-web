import os
import socket
from waitress import serve
from . import create_app

# Allow running `python -m app`
app = create_app()

def _is_port_free(p: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("0.0.0.0", p))
            return True
    except OSError:
        return False

def _pick_port():
    # Honor PORT env var if set and free, else try sensible defaults
    env = os.environ.get("PORT")
    candidates = []
    if env:
        try:
            candidates.append(int(env))
        except ValueError:
            pass
    candidates += [8080, 8081, 5000, 5001]
    for p in candidates:
        if _is_port_free(p):
            return p
    # If none free, return last and let it error
    return candidates[-1]

if __name__ == "__main__":
    p = _pick_port()
    app.logger.info("Starting Waitress on port %s", p)
    serve(app, host="0.0.0.0", port=p)
