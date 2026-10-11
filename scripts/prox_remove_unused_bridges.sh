#!/bin/bash
set -euo pipefail

# Configuration files and backup names
CONFIG_FILE="/etc/network/interfaces"
BACKUP_FILE="/etc/network/interfaces.bak.$(date +%F-%H%M%S)"

echo "[*] Backing up network config to $BACKUP_FILE"
cp "$CONFIG_FILE" "$BACKUP_FILE"

# Get all interfaces defined with auto
BRIDGES=$(grep -E '^auto' "$CONFIG_FILE" | awk '{print $2}')
echo "[*] Found interfaces:"
echo "$BRIDGES"
echo

# Build a list of all bridges actually in use (FAST)
USED_BRIDGES=$(grep -rhoE 'bridge=[a-zA-Z0-9_-]+' /etc/pve/qemu-server /etc/pve/lxc 2>/dev/null | cut -d= -f2 | sort -u)
echo "[*] Bridges currently in use:"
echo "$USED_BRIDGES"
echo

UNUSED_NON_VMBR=()
for br in $BRIDGES; do
    # Skip vmbr* 
    if [[ $br == vmbr* ]]; then
        echo "[!] Skipping $br (protected vmbr*)"
        continue
    fi
    
    if [[ $br == lo* ]]; then
        echo "[!] Skipping $br (protected lo*)"
        continue
    fi
    
    # Safe matching using quotes to prevent syntax breakdown
    if echo "$USED_BRIDGES" | grep -qw "$br" ; then
        echo "[+] $br is in use"
    else
        echo "[-] $br is UNUSED and eligible for removal"
        UNUSED_NON_VMBR+=("$br")
    fi
done

echo
echo "[*] Interfaces to remove:"
printf "%s\n" "${UNUSED_NON_VMBR[@]:-<none>}"
echo

# Optional confirmation
read -p "Proceed with deletion? (y/N): " confirm
[[ $confirm != "y" ]] && echo "Aborted." && exit 0

for br in "${UNUSED_NON_VMBR[@]}" ; do
    echo "Removing $br"
    # Double quotes allow variable expansion inside the sed pattern
    sed -i "/auto $br/,/^$/d" "$CONFIG_FILE"
done

echo
echo "[*] Reloading networking..."

# Replaced the ifreload block to bypass the broken Python systemd module environment
systemctl restart networking

echo
echo "[✓] Done."
