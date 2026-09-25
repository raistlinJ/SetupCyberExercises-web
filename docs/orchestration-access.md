# Orchestrator enrollment from SCE-web

The VM Manager's **Users & Access** menu includes:

- **Enable orchestration access (dangerous)**
- **Disable orchestration access**

Select VM rows, choose the operation, review the named PVE users in the
confirmation, then accept to queue it. Multiple rows for the same user are
combined. Selections spanning projects produce one queued step per project.
The result lists changed users, unchanged memberships and any failures.

## What this grants

Enable creates the dedicated PVE group `caf-orchestrator` if needed and adds the
selected rows' **existing** PVE users. It matches the orchestrator configuration:

```yaml
auth:
  provider: pve
  url: https://YOUR_PVE_HOST:8006
  ca_file: /etc/pve/pve-root-ca.pem
  required_group: caf-orchestrator
  realms: [pve, pam]
```

This snippet is the authentication block in the orchestrator's web configuration,
not an SCE project configuration. Supply the rest of the orchestrator HTTPS
configuration as usual. Usernames without a realm in SCE credentials get `@pve`;
explicit realms are preserved. The operator's PVE administration credentials are
separate from these recipient accounts.

**Enrollment is user-level, not limited to the selected VM rows or their pool.**
Every orchestrator instance authenticating against this PVE environment and using
this group will accept the enrolled user. The current orchestrator lets members
see its configured lab dashboard and saved run summaries. Its WebUI remains
read-only; future orchestration execution will allow host-mediated operations
such as pushing/pulling files and running guest commands. That is why enrollment
is explicitly labeled dangerous and requires confirmation.

This operation does not grant Proxmox Administrator, guest-exec privileges or a
host shell. It changes no VM/pool ACLs, VM visibility settings, passwords, account
enabled flags, or VM role assignments. It rejects enrollment if the group already
has native PVE ACL grants, to avoid unintentionally inheriting extra privileges.
Keep this group dedicated to application enrollment.

SCE does not decide which VM is ScenarioForge, CoreVM or the participant. The
planned orchestrator UI will list authorized VMs and let the user assign those
roles, updating the dashboard. Per-user VM/pool scoping and interactive role
assignment are separate work and are not implemented by this enrollment operation.
Do not interpret successful enrollment as per-user isolation in the current
orchestrator instance.

## Revocation and existing permissions

Disable removes only `caf-orchestrator` membership and preserves the user's other
groups. It does not delete users or pools, disable the PVE account, or stop jobs.
Removal revokes access across all orchestrator instances using that group, even
when another SCE project previously enrolled the same user. The current
orchestrator checks membership on each protected request.

Existing **Enable/Disable User Accessibility**, **Set User Perms**, user creation,
and credential synchronization do not automatically enable or disable orchestration.
Use the explicit orchestration operations for enrollment changes. They are never
added to clone or create-user follow-up steps automatically.

PVE supports atomic group append for enabling membership. Removing one group
requires submitting the remaining membership list; the connector reads it just
before the change and verifies the result afterwards. Coordinate simultaneous
administrative edits to the same user's groups when revoking access.

## Authorization and failures

When SCE authentication is enabled, only SCE administrators can invoke these two
endpoints, including through the server queue. Deployments with `AUTH_ENABLE=0`
retain SCE's existing local/no-login policy. The configured SCE API key, if any,
is also required. The operator's PVE credentials/token must be able to inspect
ACLs, manage the affected users' groups and create the enrollment group if absent.
PVE enforces those privileges; the recipient does not need them.

The queue retains the reviewed username for each selected instance. If project
credentials change before execution, the API rejects the stale selection and
requires a fresh confirmation. New enrollments preflight recipient existence;
missing users are not silently created. Other memberships are appended rather
than overwritten when enabling, and both operations verify the resulting state.
Failures are reported per user without echoing upstream secrets. Earlier successes
in a partially failed batch remain applied; inspect the result before retrying.
Cancellation stops before the next membership change; completed changes remain.

Endpoints (JSON POST):

```text
/api/projects/{pid}/instances/actions/users_orchestration_enable
/api/projects/{pid}/instances/actions/users_orchestration_disable
```

Both require `confirmed: true`, `targets: [{index, name}]`, and
`expectedUsers: {"1": "alice@pve"}` matching the selected project rows. They accept
the same Proxmox connection fields used by other user operations. Successful or
partially successful batches return `updated_users`, `skipped`, `errors`, and
`notices`. The server records successful changes with the SCE actor, project,
recipient and enabled/disabled state; no passwords are included in that log.

## Validation

```bash
.venv/bin/python -m pytest -o addopts='' -q tests/test_orchestration_access_api.py tests/test_orchestration_groups.py tests/test_proxmox_users.py
node --test tests/orchestration_access_client.test.cjs tests/server_queue_client.test.cjs
```

Tests use mocked PVE responses. No live Proxmox accounts or permissions are changed
by the tests. Coverage includes administrator authorization, explicit confirmation,
stale identities, selected-user deduplication, multi-project queue plans, preserving
other memberships, revocation, existing ACL conflicts and partial failures.
