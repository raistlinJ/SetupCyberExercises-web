# Features

AN3S focuses on fast project setup with an opinionated UI. The sections below capture the details that moved out of the compact README.

## Project Configuration & Credentials

- Collapsible project editor that remembers expansion state per project.
- Inline Virtual Machine editor with rename, per-VM collapsibles, template metadata, and adaptor listings.
- Materials manager for upload/download/delete backed by persistent storage under `DATA_DIR/materials`.
- Credentials editor enforces `Instances` parity: CSV upload/download, auto-generation of 8-character uppercase passwords, and button state tied to validation.
- Advanced Proxmox fields tucked at the bottom for quick access when tweaks are needed.

## CTFd Manager & Challenges Popup

- Token-first integration with session (cookie) fallback, surfacing upstream errors with actionable hints.
- Manager tab lets you update CTFd base URL/port and API token plus toggle global visibility (where the upstream supports it).
- Challenges popup (opened from the CTFd Manager) includes:
  - Column sorting with indicators and regex-capable filtering across every column (invalid regex strings auto-fallback to plain text).
  - Visibility badges, row selection with bulk Set Visible/Hidden, and per-row toggle buttons.
  - CSV export that preserves visibility state.
  - "Include Hidden" and "Detailed Solves" toggles, each persisted per project.
  - "Detailed Solves" off = fast mode (counts only, Teams/Users show `n/a`).
  - "Detailed Solves" on = single bulk stats request with automatic fallback to legacy per-challenge fetches if the endpoint is missing.
  - Teams/Users columns have session-persistent "expand/collapse" toggles.

## VM Manager Highlights

- Single row per VM with grouped credentials and state badges mapped from Proxmox power states.
- Shows VM ID, node, template name/id, and adaptor summary with sortable columns and regex-capable filtering.
- Refreshes display a smooth progress bar so operators know work is happening.

## Using the UI

- Projects list: create/rename/delete/export projects.
- Configuration section: set Instances, manage credentials, and tune advanced Proxmox settings.
- Virtual Machines: add/remove and edit metadata inline.
- Materials: upload/download/remove supporting files.
- State persistence keeps collapsibles where you left them per project.

## Import/Export Workflows

- Export a single project from its card or use the `/projects/export` endpoint for multi-project bundles.
- Import accepts a zip that contains `project.json` (schemaVersion = 1) plus optional materials under `materials/`.
- Input is sanitized (tags, VM names) and validation errors are reported per project.
