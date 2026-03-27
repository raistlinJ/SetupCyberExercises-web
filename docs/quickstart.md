# Quickstart

This guide covers the most common ways to run DeployForge.

## Docker (recommended)

Prereqs: Docker + Docker Compose.

```bash
docker compose up --build
```

Open:

- http://localhost
- https://localhost (self-signed)

### Data persistence

- Local folder `./data` is mounted into the container as `/data`.
- If you want a fresh start, stop containers and remove `./data/*` (or move the folder aside).

### TLS certificate DNS name

The compose stack generates a self-signed cert via the `certs` service.

- Default CN/SAN uses `localhost`.
- Override with:

```bash
CERT_DNS=your-hostname docker compose up --build
```

### Using your own (signed) certificate

The active Nginx config expects these filenames inside the certs mount:

- `cert.pem`
- `key.pem`

See `docs/tls.md` for the two supported ways to provide them.

## Local development (Python)

Prereqs: Python 3.12+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export DATA_DIR="$(pwd)/data"
python -m app
```

Notes:

- Always run as `python -m app` (not `python app/__init__.py`).
- `PORT` can be set if you need a fixed port.

## Local development with uv

If you prefer `uv`, see `UV_USAGE.md`.
