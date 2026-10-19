# API Overview

Base path: `/api`. The table below keeps the long-form reference out of the README.

## Core Project Endpoints

| Purpose | Method & Path |
| --- | --- |
| Health check | `GET /api/health` |
| List projects | `GET /api/projects` |
| Create project | `POST /api/projects` |
| Update project | `PATCH /api/projects/{id}` |
| Delete project | `DELETE /api/projects/{id}` |
| Export single project | `GET /api/projects/{id}/export` |
| Export multiple projects | `GET /api/projects/export?ids=a,b&includeMaterials=true` |
| Import (legacy sync) | `POST /api/projects/import` (multipart `file`) |

## VM & Materials Helpers

| Purpose | Method & Path |
| --- | --- |
| Add VM | `POST /api/projects/{id}/vms` |
| Rename VM | `POST /api/projects/{id}/vms/{name}/rename` |
| Update VM | `PATCH /api/projects/{id}/vms/{name}` |
| Delete VM | `DELETE /api/projects/{id}/vms/{name}` |
| List materials | `GET /api/projects/{id}/materials` |
| Upload material | `POST /api/projects/{id}/materials` |
| Download material | `GET /api/projects/{id}/materials/{fname}` |
| Delete material | `DELETE /api/projects/{id}/materials/{fname}` |

## Connectors

- Proxmox nodes lookup: `POST /api/proxmox/nodes` with `{ baseUrl, token, verifySSL }`.
- CTFd challenges (simple listing): `POST /api/ctfd/challenges` with `{ baseUrl, username, password }`.

## CTFd Project-Scoped Endpoints

| Purpose | Method & Path |
| --- | --- |
| Validate credentials | `POST /api/projects/{pid}/ctfd/login` |
| Fetch challenge stats/visibility | `POST /api/projects/{pid}/ctfd/stats/challenges` |
| Bulk update challenge visibility | `POST /api/projects/{pid}/ctfd/challenges/visibility` |
| Upload exported archive | `POST /api/projects/{pid}/ctfd/upload` |
| Manage CTFd settings | `POST /api/projects/{pid}/ctfd/settings`, `/ctfd/settings/update` |
| Manage credential-linked users | `/ctfd/users_create`, `/ctfd/users_delete`, `/ctfd/users_check` |

CTFd user actions use the same `only: ["username"]` selection rule as CTF-RPG: omit it to process all project credentials, or pass an empty list to process none. The manager asks for confirmation before acting on every configured account or deleting selected accounts.

## CTF-RPG Project-Scoped Endpoints

The [CTF-RPG Manager](/static/ctfrpg_manager.html) uses project credentials to manage accounts. Set the game URL (including any custom port) and TLS verification in the Configuration tab, or set `ctfrpg_url` and `ctfrpg_verify_ssl` on the project API. Store admin login credentials with `PATCH /api/projects/{pid}/secrets` using `{ "ctfrpg": { "username": "admin", "password": "..." } }`, or use the manager's Connection dialog. The credentials are encrypted per DeployForge user and project.
Existing CTF-RPG integration tokens are no longer used. Enter an administrator username and password for each project before using the manager.

| Action | Endpoint |
| --- | --- |
| Verify admin credentials and list characters | `POST /api/projects/{pid}/ctfrpg/login` |
| Check project users and read scores/teams | `POST /api/projects/{pid}/ctfrpg/users_check` |
| Create or update project users | `POST /api/projects/{pid}/ctfrpg/users_create` |
| Delete project users | `POST /api/projects/{pid}/ctfrpg/users_delete` |

The action requests accept optional `only: ["username"]` to select project credentials. Without `only`, they process all project credentials; an empty list processes none. Create also accepts an optional `hero` character ID. Per-user failures are returned in `results`. The connection routes accept `baseUrl`, `username`, `password`, and `verifySSL` in the request body for testing a connection before saving it; otherwise they use the saved project settings and credentials. A different `baseUrl` requires explicit credentials. All routes require DeployForge authentication.

The CTF-RPG Manager's Notifications tab configures SCE-web browser audio alerts for score and leaderboard changes. The first successful refresh establishes a silent baseline. Enabled alerts play one at a time, with each clip finishing before speech starts. **Stop audio** cancels active and queued alerts; Preview also toggles to Stop during playback. Settings use the existing project audio API, and playback is disabled in remote mode.
Its management table places each credential's team rank and points beside that user's rank and points. User and Team columns can sort by name or rank, with unavailable values last.

## Optional Agent Plugin

Set `AGENT_PLUGIN_ENABLE=1` to register these routes. The VM Manager submits them
through the server action queue.

| Purpose | Method & Path |
| --- | --- |
| Discover models and limits | `POST /api/plugins/agent/models` |
| Separate conversation for each selected guest | `POST /api/projects/{pid}/instances/actions/agent` |
| One conversation across selected guests and projects | `POST /api/plugins/agent/collective` |

Both run routes accept `llm`, `prompt`, and optional `assignment`. The per-guest
route accepts `targets` and the project's Proxmox connection fields. The shared
route accepts `groups: [{ projectId, targets, ...connectionFields }]`. Each target
is identified by its instance `index` and `name`; the server resolves its VMID
and node from inventory before allowing tools to run. Multipart requests put the
JSON body in `payload` and attachments in repeated `files` fields.

The agent already has `run_command`, `push_file`, and `pull_files` tools in both
modes. A prompt can ask it to pull absolute guest file or folder paths without an
additional option. Pull returns bounded text previews to the model; complete
files are retained in the result ZIP, available from the owner's completed queue
item. Existing guest transfer policy and connection requirements still apply.

## Credentials Payload Shape

```json
{
  "credentials": [
    { "username": "alice", "password": "PASSWORD123" },
    { "username": "bob",   "password": "" }
  ]
}
```

Rules: usernames must be non-empty, and passwords (if provided) must be at least 8 characters. The UI enforces count parity with `Instances` by padding or truncating rows automatically.

## Import/Export Schema

- Exported zips include `project.json` with `schemaVersion: 1` plus optional materials in `materials/`.
- Multi-project exports wrap projects under `projects[]` so associations can be remapped on import.
- Import sanitizes tags and VM names, reporting validation errors per project.
