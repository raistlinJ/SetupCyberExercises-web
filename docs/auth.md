# Authentication & Authorization

Session-based auth complements the existing API key guard for mutating routes.

## Environment Variables

- `AUTH_ENABLE` (default `1`): set to `0` to disable auth (all `/auth` endpoints return errors and checks are skipped).
- `SECRET_KEY`: Flask session secret. Auto-generated if unset (ephemeral) – set it for production.
- `SEED_ADMIN_USER` / `SEED_ADMIN_PASS`: seed an initial admin user (e.g., `admin` / `changeme123`). Overrides the fallback `setupadmin` account.
- `ADMIN_USERS`: comma-separated usernames treated as admins (must exist in the store to log in).
- `USERS_FILE`: optional path (absolute or relative to `DATA_DIR`) for the users JSON file (default `users.json`).

## First-Run Behavior

If no users exist and no seed credentials are supplied:

- Username: `setupadmin`
- Password: `setupadmin`
- Flag: `must_change=true`

Change this password immediately; the UI surfaces an alert until the flag is cleared.

## Auth Endpoints

- `POST /auth/login` `{ username, password }`
- `POST /auth/logout`
- `GET /auth/me` → current user (or null), includes `must_change` flag.
- `POST /auth/users` (admin) create user `{ username, password, roles[], must_change? }`
- `GET /auth/users` (admin) list users (password hashes omitted).
- `PATCH /auth/users/{username}` self-service password changes or admin role updates.
- `DELETE /auth/users/{username}` (admin) remove user (cannot delete last admin).

Roles are arbitrary strings; `admin` grants elevated permissions. Decorators `app.login_required` and `app.roles_required('admin')` are available.

## User Administration UI

`static/admin_users.html` provides a management panel that can:

- List existing users and their roles.
- Create/update/delete accounts.
- Reset passwords and `must_change` flags.
- Display a prominent warning for the default `setupadmin` account until the password changes.

## Password Change Enforcement

- Backend tracks a per-user `must_change` boolean.
- Newly created default admins have the flag set.
- Sending `PATCH /auth/users/{username}` with a new password clears the flag.

## Security Notes

- The default credential is for first-run convenience only; treat it as compromised until changed.
- API key protection (if configured) still applies to mutating routes.
- Replace the JSON store with a persistent DB or external IdP for production deployments.
