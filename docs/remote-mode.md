# Remote mode

DeployForge supports a “Remote mode” intended for deployments where file transfer / import-export should be disabled.

## Behavior

When Remote mode is enabled:

- UI disables:
  - Import
  - Export
  - Audio upload/management
- Backend enforces the same policy and returns HTTP `403` with a JSON `{ "error": "..." }` message.

## Persistence

Remote mode is persisted under `DATA_DIR/runtime.json` so it survives restarts.

## API

- `GET /api/runtime` returns runtime flags (including remote mode).
- `POST /api/runtime` (or the equivalent update endpoint used by the UI) updates runtime flags.

If you want to lock remote mode on permanently, enforce it at deployment time (e.g., filesystem permissions on `DATA_DIR/runtime.json` or a wrapper that writes it on boot).
