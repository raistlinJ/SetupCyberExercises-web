# Configuration & Local Development

This file expands on the short README notes so you can keep the top-level guide compact.

## Local Development Options

### Flask Dev Server

Use Python 3.12 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DATA_DIR="$(pwd)/.data"
python -m app
```

### Waitress (production-like) Runner

```
python -m app
```

- Listens on `0.0.0.0:${PORT:-8080}`.
- Defaults: 50 GiB `max_request_body_size`, 512 MiB `inbuf_overflow`/`outbuf_overflow`.
- Override via env vars documented below.

### PORT Selection Logic

`python -m app` picks the first available port from `[PORT env, 8080, 8081, 5000, 5001]`. Set `PORT` when you need a predictable value.

### DATA_DIR Selection Logic

1. Use `DATA_DIR` if set and writable.
2. Otherwise fall back to `./data` under the repo.
3. As a last resort, use a temp directory such as `/tmp/toolhub-data`.

### VS Code Task Example

```jsonc
{
  "label": "Run Flask dev server (fixed port)",
  "type": "shell",
  "command": "PORT=8081 DATA_DIR=\"${workspaceFolder}/data\" python -m app",
  "isBackground": false,
  "group": "build"
}
```

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `/data` (Docker) or auto-picked | Storage for JSON state, materials, uploads. |
| `PORT` | auto-picked | Port used by `python -m app`. |
| `WAITRESS_MAX_REQUEST_BODY` | `50 * 1024 * 1024 * 1024` | Request body cap in bytes. Increase for huge imports or lower for memory safety. |
| `WAITRESS_INBUF_OVERFLOW` | `512 * 1024 * 1024` | Bytes buffered before Waitress spools request bodies to disk. |
| `WAITRESS_OUTBUF_OVERFLOW` | `512 * 1024 * 1024` | Bytes buffered before responses spool to disk. |
| `AUTH_ENABLE` | `1` | Toggle session auth (see `auth.md`). |
| `SECRET_KEY` | auto-generated | Flask secret for sessions; set in production. |
| `SEED_ADMIN_USER` / `SEED_ADMIN_PASS` | `setupadmin` | Seed admin credentials on first boot. |
| `ADMIN_USERS` | none | Comma-separated list of usernames treated as admins. |
| `USERS_FILE` | `users.json` under `DATA_DIR` | Custom path to the JSON user store. |

## Docker Compose Notes

- Service: `toolhub` exposed on `8080`.
- Volume: named `toolhub-data` mounted at `/data` (persists JSON/materials).
- Env: `PORT=8080`, `DATA_DIR=/data`.

## Tips

- Always run the app via `python -m app` (never `python app/__init__.py`) so package-relative imports work.
- Keep `DATA_DIR` writable when running locally; Docker handles this by mounting a volume.
