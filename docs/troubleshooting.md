# Troubleshooting & Performance Notes

## Common Issues

- **Import errors when running `app/__init__.py`:** always run `python -m app` so package-relative imports resolve.
- **DATA_DIR permissions:** ensure the directory exists and is writable (Docker compose mounts `/data`).
- **Invalid credential uploads:** CSV must contain two columns (`username,password`). Passwords must be 8+ characters if provided.

## Guest file transfers

- **Student upload is missing or disabled.** Confirm the VM is open in the
  AccessForge SPICE console and its SPICE guest agent is connected. Check
  `ENABLE_VM_FILE_UPLOAD` in AccessForge and the VM's Upload policy in DeployForge.
  After enabling Upload, reconnect the console.
- **SPICE uploads are slower than Guest Files → Push.** SPICE shares the
  student's console connection and uses the guest agent's flow control.
  AccessForge batches packets to reduce overhead. Use **Guest Files → Push**
  for admin provisioning and bulk uploads. See the [transfer workflows](../README.md#guest-file-transfers).
- **Admin transfer shows compatible mode.** The Proxmox host could not use the
  streaming guest-agent file commands at preflight. Check host SSH access and
  the QEMU guest agent. The Queue gives the transfer mode and result.

## CTFd-Specific Tips

- Admin or Teacher tokens are required to include hidden challenges in listings. Use the "Include Hidden" toggle in the popup.
- The popup mirrors the token into a same-origin session cookie (keyed by project id) so it can operate in its own window. Tokens never persist on the server.
- Filtering supports regex mode. Invalid expressions automatically fall back to plain text so you don't get stuck.
- Disable "Detailed Solves" for faster counts-only mode (Teams/Users show `n/a`). The progress bar stays smooth and monotonic.
- Detailed mode issues one bulk stats call (`detail=true`). If the server lacks that endpoint or denies access, the UI falls back to per-challenge workers automatically.
- Teams/Users expansion state sticks per project for the current session.

## CTFd Manager Optimizations

- User existence/rank lookups now issue a single bulk `users_check` request; if it fails, the manager transparently falls back to per-user sequential calls.
- Inline progress bars cover both bulk and fallback paths so operators can see work happening.

## Performance Summary

- Challenges popup (Detailed Solves ON): 1 list request + 1 bulk stats request replaces N per-challenge stats calls.
- Challenges popup (Detailed Solves OFF): counts-only path skips Teams/Users payloads entirely.
- CTFd Manager credential enrichment: 1 bulk metadata call replaces up to N sequential calls.
- All optimizations preserve previous behavior and degrade gracefully when bulk endpoints error out.
