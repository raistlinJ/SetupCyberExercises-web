#!/usr/bin/env bash

# Repair stale ifupdown2 bridge state on a Proxmox host.
#
# A stale bridge can make ifreload fail with an error such as:
#   No such file or directory: '/sys/class/net/default/brif/'
#
# Run normally for an interactive confirmation:
#   sudo ./fix_prox_bridges.sh
#
# Skip the confirmation (for an already-reviewed invocation):
#   sudo ./fix_prox_bridges.sh --yes
#
# Diagnose without changing anything:
#   sudo ./fix_prox_bridges.sh --check

set -Eeuo pipefail

script_name=${0##*/}
check_only=0
assume_yes=0
force_reset=0

usage() {
    printf 'Usage: %s [--check] [--yes] [--force]\n' "$script_name"
    printf '\n'
    printf '  --check  Diagnose only; do not rebuild state.\n'
    printf '  --yes    Do not ask for interactive confirmation.\n'
    printf '  --force  Rebuild state even if no missing stale bridge is detected.\n'
}

while (($#)); do
    case "$1" in
        --check)
            check_only=1
            ;;
        --yes|-y)
            assume_yes=1
            ;;
        --force)
            force_reset=1
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown option: %s\n\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if ((EUID != 0)); then
    printf 'Run this script as root, for example: sudo ./%s\n' "$script_name" >&2
    exit 1
fi

for required_command in awk date grep ifquery ifreload install mktemp mv rm sort tail; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$required_command" >&2
        exit 1
    fi
done

ifupdown_config=/etc/network/ifupdown2/ifupdown2.conf
state_dir=

if [[ -r "$ifupdown_config" ]]; then
    state_dir=$(
        awk -F= '
            /^[[:space:]]*state_dir[[:space:]]*=/ {
                value = $0
                sub(/^[^=]*=[[:space:]]*/, "", value)
                sub(/[[:space:]]*#.*/, "", value)
                sub(/[[:space:]]+$/, "", value)
                if (value != "") print value
            }
        ' "$ifupdown_config" | tail -n 1
    )
fi

if [[ -z "$state_dir" ]]; then
    state_dir=/var/tmp/network
fi

state_dir=${state_dir%/}
state_file=$state_dir/ifstatenew

work_dir=$(mktemp -d /tmp/fix-prox-bridges.XXXXXX)
cleanup() {
    rm -rf -- "$work_dir"
}
trap cleanup EXIT

saved_config=$work_dir/saved-config
current_config=$work_dir/current-config
saved_bridges=$work_dir/saved-bridges
current_ifaces=$work_dir/current-ifaces

printf 'Using ifupdown2 state file: %s\n' "$state_file"
printf 'Reading current and saved interface configuration...\n'

if ! ifquery -a --print-savedstate >"$saved_config"; then
    printf 'Unable to read ifupdown2 saved state. No changes were made.\n' >&2
    exit 1
fi

if ! ifquery -a >"$current_config"; then
    printf 'Unable to read the current interface configuration. No changes were made.\n' >&2
    exit 1
fi

awk '
    /^[[:space:]]*iface[[:space:]]+/ { iface_name = $2 }
    /^[[:space:]]+bridge-ports[[:space:]]+/ {
        if (iface_name != "") print iface_name
    }
' "$saved_config" | sort -u >"$saved_bridges"

awk '
    /^[[:space:]]*iface[[:space:]]+/ { print $2 }
' "$current_config" | sort -u >"$current_ifaces"

stale_bridges=()
while IFS= read -r bridge_name; do
    [[ -n "$bridge_name" ]] || continue

    if [[ ! "$bridge_name" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
        printf 'Ignoring an invalid interface name in saved state: %q\n' "$bridge_name" >&2
        continue
    fi

    if [[ ! -e "/sys/class/net/$bridge_name" ]] \
        && ! grep -Fxq -- "$bridge_name" "$current_ifaces"; then
        stale_bridges+=("$bridge_name")
    fi
done <"$saved_bridges"

if ((${#stale_bridges[@]})); then
    printf 'Detected stale bridge state for:'
    printf ' %s' "${stale_bridges[@]}"
    printf '\n'
else
    printf 'No missing stale bridges were detected.\n'
    if ((force_reset == 0)); then
        if ((check_only)); then
            exit 0
        fi
        printf 'No changes were made. Use --force only if you have independently confirmed stale state.\n'
        exit 0
    fi
fi

printf 'Checking whether the current configuration can be reloaded without saved state...\n'
if ! ifreload -a -u -n; then
    printf 'The dry run failed. The saved state was not changed.\n' >&2
    exit 1
fi

printf 'Dry run succeeded.\n'
if ((check_only)); then
    printf 'Check-only mode: no changes were made.\n'
    exit 0
fi

printf '\nWARNING: rebuilding network state runs ifreload on this host.\n'
printf 'Use a working Proxmox console or iDRAC session in case connectivity is interrupted.\n'

if ((assume_yes == 0)); then
    if [[ ! -t 0 ]]; then
        printf 'Interactive confirmation is unavailable. Re-run with --yes after reviewing the warning.\n' >&2
        exit 1
    fi

    read -r -p 'Rebuild ifupdown2 state now? [y/N] ' confirmation
    case "$confirmation" in
        y|Y|yes|YES)
            ;;
        *)
            printf 'Cancelled; no changes were made.\n'
            exit 0
            ;;
    esac
fi

backup_dir=/root/ifupdown2-state-backups
backup_file=

if [[ -e "$state_file" ]]; then
    install -d -m 0700 "$backup_dir"
    backup_file=$backup_dir/ifstatenew.stale-$(date +%Y%m%d-%H%M%S)-$$
    if [[ -e "$backup_file" ]]; then
        printf 'Refusing to overwrite an existing backup: %s\n' "$backup_file" >&2
        exit 1
    fi
    mv -- "$state_file" "$backup_file"
    printf 'Moved stale state to: %s\n' "$backup_file"
else
    printf 'The state file is already absent; it will be created during the reload.\n'
fi

printf 'Rebuilding state from the current configuration...\n'
if ! ifreload -a -u; then
    printf 'ifreload failed. Review the live network before taking further action.\n' >&2
    if [[ -n "$backup_file" ]]; then
        printf 'The previous saved state remains available at: %s\n' "$backup_file" >&2
    fi
    exit 1
fi

if ! ifquery -a --print-savedstate >"$saved_config"; then
    printf 'Reload succeeded, but the rebuilt state could not be read for verification.\n' >&2
    exit 1
fi

verification_failed=0
for bridge_name in "${stale_bridges[@]}"; do
    if awk -v wanted="$bridge_name" '
        /^[[:space:]]*iface[[:space:]]+/ && $2 == wanted { found = 1 }
        END { exit(found ? 0 : 1) }
    ' "$saved_config"; then
        printf 'Stale interface is still present after rebuilding state: %s\n' "$bridge_name" >&2
        verification_failed=1
    fi
done

if ((verification_failed)); then
    exit 1
fi

printf 'Running a normal no-action reload as the final verification...\n'
if ! ifreload -a -n; then
    printf 'State was rebuilt, but the normal dry reload still reports an error.\n' >&2
    exit 1
fi

printf 'Bridge state repair completed successfully.\n'
if [[ -n "$backup_file" ]]; then
    printf 'Backup: %s\n' "$backup_file"
fi
