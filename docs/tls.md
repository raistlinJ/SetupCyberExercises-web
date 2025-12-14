# TLS / HTTPS certificates

The Docker Compose deployment terminates TLS in the `nginx` container.

## What filenames does Nginx expect?

The active Nginx config is `deploy/sce.conf`, which expects:

- Certificate: `/etc/nginx/certs/cert.pem`
- Private key: `/etc/nginx/certs/key.pem`

## Where do those files come from?

In `docker-compose.yml`, both the `certs` service and `nginx` use the same named volume:

- volume name: `certs`
- mounted to:
  - `certs` service: `/out`
  - `nginx` service: `/etc/nginx/certs` (read-only)

So the TLS files live inside that Docker volume.

## Option A (recommended): mount your real certs from the host

This is the simplest way to use a real CA-signed certificate.

1) Create a folder in the repo (example): `./certs/`
2) Put these two files in it:

- `certs/cert.pem` (ideally full chain: server cert + intermediates)
- `certs/key.pem` (private key; usually unencrypted for unattended startup)

3) Change the `nginx` service volume in `docker-compose.yml` from:

- `certs:/etc/nginx/certs:ro`

to:

- `./certs:/etc/nginx/certs:ro`

Then restart:

```bash
docker compose down
docker compose up -d --build
```

## Option B: keep the named volume and copy files into it

If you don’t want to change Compose, copy your files into the `certs` volume as `cert.pem` and `key.pem`.

Example:

```bash
# from repo root

docker compose down

# copy into the volume using a temporary container
# replace /absolute/path/to/fullchain.pem and /absolute/path/to/privkey.pem

docker run --rm \
  -v sce-web_certs:/out \
  -v "/absolute/path/to":/src:ro \
  alpine sh -lc 'cp /src/fullchain.pem /out/cert.pem && cp /src/privkey.pem /out/key.pem && ls -l /out'

docker compose up -d
```

Note: the real volume name is usually `<composeProject>_certs` (you can see it via `docker volume ls`).

## Self-signed (default)

If you don’t provide your own cert/key, the `certs` service generates a self-signed certificate into the same volume.

- Default CN/SAN uses `localhost`
- Override with `CERT_DNS=your-hostname` when starting the stack
