# Import / Export

DeployForge supports exporting Projects to a ZIP bundle and importing them back later.

## Export

- Export a single project from the project card in the UI, or via the API.
- Exports include `project.json` plus optional materials under `materials/`.

See also: `docs/api.md`.

## Import

### What’s inside an import ZIP

- `project.json` with `schemaVersion: 1`
- Optional materials under `materials/…`
- Optional Proxmox backups under `backups/<vm_name>/...` when VM restore is included

### UI options

The Import Options dialog controls what is applied:

- **Credentials**: include credentials from the bundle.
- **VMs**:
  - When enabled, import includes VM config and can optionally restore VM backups to Proxmox.
  - When disabled, VM configuration is imported but VMIDs are treated as config-only.
- **Import VMs as templates**:
  - Only applies when importing VMs.
  - After each VM restore, DeployForge will attempt to run `qm template <vmid>` on the target Proxmox node (best-effort).

### Legacy vs async import endpoints

- Legacy (sync): `POST /api/projects/import`
- Async (VM restore flow): `POST /api/projects/import/start` then poll `GET /api/projects/import/status?id=...`

The UI will automatically use the async flow when VM restore is requested.

### Proxmox VM restore

When VM restore is enabled, the UI prompts for Proxmox API + SSH details and the server will:

- Upload the backup archive(s) to the Proxmox node over SFTP
- Run `qmrestore ...` to restore each VM
- Apply `bridge-ageing 0` to both `/etc/network/interfaces` and `/etc/network/interfaces.new` (best-effort, logged)
- Optionally convert restored VMs to templates (`qm template <vmid>`) when requested

## Upload size limits

- By default, the app is configured to allow very large imports.
- If you want a cap when running with Waitress, set `WAITRESS_MAX_REQUEST_BODY` to a positive byte value.

See: `docs/configuration.md`.
