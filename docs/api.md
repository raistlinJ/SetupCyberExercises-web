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
- CTFd challenges (simple listing): `POST /api/ctfd/challenges` with `{ baseUrl, token }`.

## CTFd Project-Scoped Endpoints

| Purpose | Method & Path |
| --- | --- |
| Validate credentials | `POST /api/projects/{pid}/ctfd/login` |
| Fetch challenge stats/visibility | `POST /api/projects/{pid}/ctfd/stats/challenges` |
| Bulk update challenge visibility | `POST /api/projects/{pid}/ctfd/challenges/visibility` |
| Upload exported archive | `POST /api/projects/{pid}/ctfd/upload` |
| Manage CTFd settings | `POST /api/projects/{pid}/ctfd/settings`, `/ctfd/settings/update` |
| Manage credential-linked users | `/ctfd/users_create`, `/ctfd/users_delete`, `/ctfd/users_check` |

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
