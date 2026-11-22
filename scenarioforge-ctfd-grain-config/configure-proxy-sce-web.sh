#!/usr/bin/env bash
# Dr. Jaime C. Acosta
# Upload this and setup_llm_proxy-v2.sh to /home/corevm/ on each PROXY host.
# In SCE-web, enable Render template variables and run:
#   bash /home/corevm/configure-proxy-sce-web.sh "{{instance_index}}"
# For a manual run, pass the actual index instead, for example: 48.
# You can also paste this entire script into SCE-web with rendering enabled.
# Updates /root/myscenario.xml. Stop, reload and restart CORE afterward.
set -euo pipefail

instance_index="{{instance_index}}"
instance_index="${1:-${INSTANCE_INDEX:-$instance_index}}"

# Fail rather than wait for a sudo password in an unattended SCE-web command.
runner=(bash)
if [[ "$EUID" -ne 0 ]]; then
  runner=(sudo -n bash)
fi

exec "${runner[@]}" /home/corevm/setup_llm_proxy-v2.sh \
  --instance-index "$instance_index" \
  --scenario-xml /root/myscenario.xml \
  --router-node n3 \
  --external-interface eth1 \
  --internal-ip 13.0.0.101 \
  --uplink-gateway 11.0.0.254 \
  --external-addresses \
    100.100.100.100:8080:129.108.156.63:11434-11436 \
    100.100.100.101:443:129.108.4.46:443
