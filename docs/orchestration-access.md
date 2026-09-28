# Orchestrator enrollment from SCE-web

The VM Manager's **Users & Access** menu includes:

- **Enable orchestration access (dangerous)**
- **Disable orchestration access**

Select VM rows, choose the operation, review the named PVE users in the
confirmation, then accept to queue it. Multiple rows for the same user are
combined. Selections spanning projects produce one queued step per project.
The result lists changed users, unchanged memberships and any failures.

## What this grants

Enable creates the dedicated PVE groups `caf-orchestration` and `caf-maintainers`
if needed and adds the selected rows' **existing** PVE users to both. This grants
orchestration and application update/rollback access. It matches the orchestrator
configuration:

```yaml
auth:
  provider: pve
  url: https://YOUR_PVE_HOST:8006
  ca_file: /etc/pve/pve-root-ca.pem
  required_group: caf-orchestration
  realms: [pve, pam]
updates:
  group: caf-maintainers
```

This snippet contains the authentication and maintenance settings in the orchestrator's web configuration,
not an SCE project configuration. Supply the rest of the orchestrator HTTPS
configuration as usual. Usernames without a realm in SCE credentials get `@pve`;
explicit realms are preserved. The operator's PVE administration credentials are
separate from these recipient accounts.

**Enrollment is user-level, not limited to the selected VM rows or their pool.**
Every orchestrator instance authenticating against this PVE environment and using
this group will accept the enrolled user. With orchestrator 0.6+, each user's VM
choices are restricted to their effective VM.Audit permissions (including pool
and group ACLs) on the orchestrator's node. Enrollment authorizes host-mediated
guest operations on that entire eligible set, not just the rows selected in SCE.
Maintenance membership permits updating and rolling back Cyber-agent-flow and
ScenarioForge in the selected eligible VMs. These changes affect everyone using
those applications; guest idle checks and other updater safeguards still apply.
Results and VM role selections are private to the user. Older orchestrator
versions do not provide this per-user isolation; upgrade the orchestrator too.

This operation does not grant native Proxmox Administrator/VM.Monitor privileges
or a host shell. It changes no VM/pool ACLs, VM visibility settings, passwords,
account enabled flags, or VM role assignments. It rejects enrollment if either group
already has native PVE ACL grants, avoiding unintended extra privileges. Keep
these groups dedicated to application enrollment. Group membership deliberately
allows additional guest control through the orchestrator within the visible VM set.

SCE does not decide which VM is ScenarioForge, CoreVM or the participant. Users
assign those roles from their available VMs in the orchestrator WebUI. Current
ACLs are checked before host operations; role selection is not a permanent grant.

## Revocation and existing permissions

Disable removes `caf-orchestration`, `caf-maintainers`, and legacy `caf-orchestrator`
membership, preserving all other groups. It does not delete users or pools,
disable the PVE account, or stop jobs.
Removal revokes access across all orchestrator instances using those groups, even
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

### Existing installations

The enrollment group was previously named `caf-orchestrator`. Re-run **Enable
orchestration access (dangerous)** for existing users to add both new memberships;
it is safe to repeat. Enable preserves legacy membership so existing orchestrator
instances continue working during migration. It does not create new legacy memberships.
In each existing orchestrator's `web.yaml`, change `auth.required_group` to
`caf-orchestration`, keep `updates.group: caf-maintainers` (or its default), and
restart the orchestrator. New installations use the new enrollment name by default;
existing configuration files are not overwritten. Once all instances have migrated,
an administrator can remove the old membership. Disable handles both names during
the transition. Custom group names must be aligned with these SCE enrollment groups.

## Authorization and failures

When SCE authentication is enabled, only SCE administrators can invoke these two
endpoints, including through the server queue. Deployments with `AUTH_ENABLE=0`
retain SCE's existing local/no-login policy. The configured SCE API key, if any,
is also required. The operator's PVE credentials/token must be able to inspect
ACLs, manage the affected users' groups and create the enrollment groups if absent.
PVE enforces those privileges; the recipient does not need them.

The queue retains the reviewed username for each selected instance. If project
credentials change before execution, the API rejects the stale selection and
requires a fresh confirmation. New enrollments preflight recipient existence;
missing users are not silently created. Other memberships are appended rather
than overwritten when enabling, and both operations verify the resulting state.
Failures are reported per user with `failed_groups` and `changed_groups`, without
echoing upstream secrets. Membership changes are not a single transaction: earlier
successes remain applied, including within a partially updated user. Retrying
completes missing changes. Revocation attempts all three groups even when one fails.
Cancellation stops before the next user; completed changes remain.

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
