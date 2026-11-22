# CORE router uplink for SCE-web

Dr. Jaime C. Acosta

Use this sequence to deploy the same scenario to the PROXY/CORE VMs and give
each one its own uplink IP, MAC and backend port. Run the configuration scripts
on the PROXY hosts. Test the translated student endpoints from the student VMs.

SCE-web can now store this as a **CORE Gateway** VM policy. Select the QEMU
template in the wizard, enter the CORE router node name, and connect its
internal `net0`. The wizard starts with the Internet uplink on `net1`. Drag any
row in **Configuration → Network Interfaces** to match the gateway VM's NIC
order. Apply the saved order to existing VMs through
**VM Manager → State & Network → Set Network Interfaces**.
Edit the policy in Configuration to allow direct destinations, translate student
endpoints, or grant full IPv4 access for specified internal source IPs/CIDRs.
Then select the gateway VM rows and choose **VM Manager → State & Network →
Configure and Restart Proxy** to review and apply the policy for each selected
VM. The dialog starts with that VM's last successfully applied policy or the
Configuration defaults. **Select previous run config** recalls one of the ten
most recent unique successful policies for that VM. Enter translations as
`CLIENT_IP:CLIENT_PORT:BACKEND_IP_OR_HOST:BACKEND_PORT`,
with one client port and one backend port. Existing four-field ranges are
resolved in the dialog using the original instance-based rotation. Select
**Apply and Restart** to send the bundled setup script to the selected VMs. Each
proxy guest needs the configured XML, Python 3, and `core-cli`. Use **View
results** in VM Manager to inspect the guest output. The manual wrapper below
supports the original fixed endpoint list.

Before restarting CORE, the action saves the configured router uplink as
`11.0.0.<instance index>` in the XML and uses that same address for source NAT.
In `myscenario.xml`, this is `n3`'s `eth1` interface. The VM Manager action
checks CORE's session list for the configured scenario XML and refuses to
change the XML if other sessions exist but none match,
or if multiple sessions match. When no sessions exist, it starts the configured
XML. A matching session is stopped and replaced; connected scenario nodes are
interrupted while it restarts.

## Manual deployment sequence

### 1. Stop the running CORE scenarios

Stop the CORE scenario on each target PROXY VM before replacing its XML.

### 2. Push the scenario and both scripts

Copy these files to every target PROXY VM:

| Local file | Destination on each PROXY VM |
| --- | --- |
| `myscenario.xml` | `/root/myscenario.xml` |
| `setup_llm_proxy-v2.sh` | `/home/corevm/setup_llm_proxy-v2.sh` |
| `configure-proxy-sce-web.sh` | `/home/corevm/configure-proxy-sce-web.sh` |

`/root/myscenario.xml` is the scenario file, not a directory. Use the same base
XML and scripts on all hosts; the next step applies each host's instance index.

### 3. Customize each VM through SCE-web

Select the target PROXY hosts in SCE-web. Enable **Render template variables**
and run this Custom Command:

```bash
bash /home/corevm/configure-proxy-sce-web.sh "{{instance_index}}"
```

SCE-web substitutes each selected host's index into the command. The wrapper
passes that index to `setup_llm_proxy-v2.sh`, which edits the local XML. It updates
router `n3`'s external `eth1` IP/MAC and its IPForward startup configuration,
including routes, port translation, source NAT and firewall rules.

The wrapper runs directly as root or uses `sudo -n` for another account. That
account needs passwordless sudo; otherwise the command fails instead of waiting
for a password prompt. No Python packages or Internet downloads are required.

Check that **every selected host reports success** before continuing. Inspect
the printed router address and TCP conversion for each instance. Examples:

| Instance index | Router uplink and SNAT source | Model backend |
| --- | --- | --- |
| 48 | `11.0.0.48` | `129.108.156.63:11436` |
| 68 | `11.0.0.68` | `129.108.156.63:11435` |

Students use `100.100.100.100:8080` on both instances. The script chooses the real
model port with `11434 + ((instance_index - 1) % 3)`. The second translated
endpoint, `100.100.100.101:443`, maps to `129.108.4.46:443` on every instance.

SCE-web renders command text rather than the contents of uploaded files, so
pass `"{{instance_index}}"` as shown. Alternatively, paste the entire wrapper
script into a rendered command. A command-line index overrides `INSTANCE_INDEX`
and the embedded template placeholder. For a manual run on instance 48:

```bash
bash /home/corevm/configure-proxy-sce-web.sh 48
```

### 4. Reload the updated XML and start CORE

Load `/root/myscenario.xml` again on each PROXY VM, then start the scenario.
Starting a previously loaded scenario can retain its old configuration.

The customization script updates the XML only. The IPForward startup commands
apply the routes, NAT and firewall rules **inside router n3** when CORE starts
that updated scenario.

### 5. Verify each running router from the PROXY host

For hosts using the confirmed CORE session path `/tmp/pycore.1/n3`, run these
commands through SCE-web or in the PROXY host's terminal:

```bash
sudo -n vcmd -I -c /tmp/pycore.1/n3 -- ip -br -4 addr
sudo -n vcmd -I -c /tmp/pycore.1/n3 -- iptables -t nat -S SCE_UPLINK_DNAT
sudo -n vcmd -I -c /tmp/pycore.1/n3 -- iptables -t nat -S SCE_UPLINK_NAT
```

`vcmd -c` selects the running node's control socket. `-I` executes without an
interactive terminal; commands after `--` run inside that node. This inspects
the running router rather than the outer PROXY host's network namespace.

Check every host's output:

- `eth0` has `13.0.0.1/24`.
- `eth1` has `11.0.0.<instance_index>/24`.
- Every `--to-source` value matches that same uplink IP.
- The model DNAT destination uses the port selected for that instance.

For instance 48, `eth1` and SNAT must both use `11.0.0.48`, and model DNAT must
use `129.108.156.63:11436`. A running interface at `.48` with SNAT at `.68` is a
configuration mismatch; reapply step 3 and reload/start the updated scenario.

If another host uses a different CORE session ID, find its socket and substitute
the returned path in the commands above:

```bash
sudo -n find /tmp -maxdepth 2 -type s -path '/tmp/pycore.*/n3'
```

The number after `pycore.` is the CORE session ID, not the SCE instance index.
If multiple paths appear, use the one for the intended running scenario.

### 6. Test from the student VM

On each student VM, run:

```bash
ip -4 route get 100.100.100.100
wget --no-proxy -T 5 -t 1 -O - http://100.100.100.100:8080/health
```

The route should use `via 13.0.0.1 dev ens18 src 13.0.0.101`, and the HTTP request
should receive the model service's health response. The wget options bypass
configured HTTP proxies, bound the network wait to five seconds and one attempt,
and print the response to the terminal.

The proxy script does not configure student VM routes. An incorrect direct
default route such as `default dev ens18 scope link` requires a separate fix on
the affected student VM. A valid default route through `13.0.0.1` is sufficient;
individual routes to each translated endpoint are unnecessary when no competing
routes override that gateway.

## Full command and endpoint settings

For a script uploaded to `/home/corevm/setup_llm_proxy-v2.sh`, use this SCE-web
startup, stored or custom command with **Render template variables** enabled:

```bash
bash /home/corevm/setup_llm_proxy-v2.sh \
  --instance-index "{{instance_index}}" \
  --scenario-xml /root/myscenario.xml \
  --router-node n3 \
  --external-interface eth1 \
  --internal-ip 13.0.0.101 \
  --uplink-gateway 11.0.0.254 \
  --external-addresses \
    100.100.100.100:8080:129.108.156.63:11434-11436 \
    100.100.100.101:443:129.108.4.46:443-443
```

Replace the router name, interface, internal host, gateway and external endpoints
as needed. A numeric router node ID also works. SCE-web renders the command text;
pass the index explicitly when invoking an uploaded file. In a terminal without
SCE-web, replace `{{instance_index}}` with the actual instance number.

Each external endpoint specifies all four fields, separated by colons:

```text
TRANSLATED_IP:TRANSLATED_PORT:REAL_EXTERNAL_IP:REAL_PORT_RANGE
```

The translated IP and port are the address students use. The real IP and selected
real port are the destination after TCP destination NAT. Each entry has its own
translated endpoint; multiple virtual IPs and multiple ports on one virtual IP
are supported. Identical entries are deduplicated. Two different destinations
for the same translated IP and port are rejected before writing.

For instance **68**, the example produces:

| Student endpoint | Real destination |
| --- | --- |
| `100.100.100.100:8080` | `129.108.156.63:11435` |
| `100.100.100.101:443` | `129.108.4.46:443` |

Students use `http://100.100.100.100:8080/v1` for the model API and
`https://100.100.100.101/` for the other server. A range is inclusive and must be
ascending within 1–65535. Port selection is
`START + ((instance_index - 1) % (END - START + 1))`.
For 11434–11436, instances 1, 2, 3 and 4 select 11434, 11435, 11436 and 11434.
Use `443-443` or just `443` for a fixed real port. The translated port is always
one port, rather than a range. The translated IP must be a unicast IPv4 literal;
the real destination can also be a hostname resolving to exactly one IPv4 address.

This format adds only the specified translated endpoints, without an automatic
LLM alias or direct backend access. Requests to real IPs and other ports are
blocked unless separately permitted. Only TCP connections from the authorized
internal host and their established replies are allowed through the external
interface. Source NAT uses the router uplink IP, `11.0.0.68` for instance 68;
connection tracking reverses both translations for replies.

Traffic for each translated IP must reach this router from the student VM,
including through intermediate lab routers. This script adds real-server host
routes on the proxy router; it does not install routes on the student VM or
advertise virtual prefixes through the lab routing protocol. It translates
outgoing student requests, rather than inbound connections to a student listener.

The same endpoint list works in the environment:

```bash
EXTERNAL_ADDRESSES='100.100.100.100:8080:129.108.156.63:11434-11436 100.100.100.101:443:129.108.4.46:443-443' \
bash /home/corevm/setup_llm_proxy-v2.sh \
  --instance-index "{{instance_index}}" \
  --scenario-xml /root/myscenario.xml \
  --router-node n3 \
  --external-interface eth1 \
  --internal-ip 13.0.0.101 \
  --uplink-gateway 11.0.0.254
```

| Option | Meaning | Environment fallback / default |
| --- | --- | --- |
| `--instance-index N` | Index 1–253; derives uplink IP, MAC and backend port selection | `INSTANCE_INDEX`, then inline SCE-web placeholder |
| `--scenario-xml PATH` | Scenario XML to update | `SCENARIO_XML`, then `/root/myscenario.xml` |
| `--router-node ID_OR_NAME` | Router whose interface and IPForward service are updated | `ROUTER_NODE`, then auto-detect |
| `--external-interface NAME` | External interface on that router | `EXTERNAL_INTERFACE`, then `eth1` |
| `--internal-ip IP` | Internal host permitted through the uplink | `INTERNAL_IP`, then `13.0.0.101` |
| `--internal-sources IP_OR_CIDR ...` | Permitted internal IPv4 hosts or networks; replaces `--internal-ip` | `--internal-ip` value |
| `--mode restricted\|full` | Address allowlist or full IPv4 access for the listed sources | `PROXY_MODE`, then `restricted` |
| `--uplink-gateway IP` or `--gateway IP` | Uplink next hop | `UPLINK_GATEWAY`, then `11.0.0.254` |
| `--external-addresses ENDPOINT ...` | Allowed endpoints and TCP port rules; may be repeated | `EXTERNAL_ADDRESSES` |
| `--clear-external-addresses` | Ignore any environment address list; useful with full access | Off |
| `--no-legacy-port-settings` | Ignore stale legacy global port environment values | Off |
| `--virtual-llm IP` | Legacy model alias; unused by four-field entries | `VIRTUAL_LLM`, then `100.100.100.100` |
| `--llm-address IP` | Legacy alias backend; unused by four-field entries | `LLM_ADDRESS`, then `129.108.156.63` |
| `--help` | Show usage without reading or editing XML | |

Options override environment values. `--external-addresses` replaces
`EXTERNAL_ADDRESSES`; quoted whitespace-separated lists and repeated flags work.
Legacy positional endpoints append to the list. Reapply and reload the scenario
after changing entries so students get the new mapping.

Older formats remain available for compatibility:

| Older format | Behavior |
| --- | --- |
| `IP:CLIENT_PORT:START-END` | Translate the port on that same real IP; the selected legacy LLM also gets its configured virtual alias |
| `IP:START-END` or `IP:PORT` | Direct TCP access to the range or single port |
| `IP` | Direct access to all ports/protocols on that destination |

For older three-field entries, `--llm-address` / `LLM_ADDRESS` chooses the backend
for the automatic alias and `--virtual-llm` / `VIRTUAL_LLM` sets that alias's IP.
Those options do not add aliases to four-field entries. Hostnames in older forms
can resolve to multiple IPv4 addresses. Conflicting or shadowed frontend rules,
and mixing bare-IP access with older port-specific forms for the same IP, are
rejected before writing. Explicit direct permissions can separately permit a
real backend when required.

The older global `--dest-port` / `DEST_PORT`, `--conversion-base-port` /
`CONVERSION_BASE_PORT` and `--backend-port-count` / `BACKEND_PORT_COUNT` options
remain supported only with bare-IP entries. Their aliases are `--virtual-port` /
`VIRTUAL_PORT` and `--llm-base-port` / `LLM_BASE_PORT`. Setting either global port
enables the old virtual-only mapping, with defaults 8080, 11434 and count 3;
bare-IP direct access stays unrestricted in that mode. Do not combine global
port settings with per-entry port settings. Unset stale global port environment
variables when using the four-field format.

Destinations must be individual IPv4 addresses or hostnames, without URLs, CIDRs
or IPv6. Hostnames resolve on the CORE VM at configuration time; rerun to refresh
their addresses. In restricted mode, other forwarding through the selected
external interface is blocked, including IPv6. DNS, redirects and additional
CDN destinations need their own permitted endpoints. The script installs only
external host routes in that mode. In full mode, it also installs a default
route and allows IPv4 forwarding with source NAT for the listed internal source
IPs/CIDRs; unsolicited inbound traffic and IPv6 forwarding remain blocked.
Full mode does not use a destination allowlist; SCE-web clears and disables
allowed destinations when full mode is selected. Translated endpoints remain
optional in full mode. The script rejects a full-mode command that supplies a
direct allowed destination, while accepting translated endpoints.
Student VMs still need routes through the CORE router and working DNS to use
hostnames. A source CIDR must be narrower than `0.0.0.0/0`.

Only the selected interface's IPv4 and MAC are replaced with
`11.0.0.<instance-index>` and `00:00:00:aa:00:<index-in-hex>`. Its subnet mask,
other interfaces, and other nodes' addresses/services are preserved. Identical
copies in directional link records are all updated; conflicting interface
copies are rejected with their attributes. Without `--router-node`, detection
requires exactly one router interface with the selected name and the original
IP/MAC (`11.0.0.2` / `00:00:00:aa:00:00`) or current instance values.

The script validates before writing, preserves existing IPForward service
settings (including exported startup commands, files and executables) and
template content, and saves the prior XML as `<scenario-xml>.bak`. That backup is
overwritten on each successful run. Specify `--router-node` when changing the
instance index on a rerun. Existing generated rules are replaced. If CORE is
running, stop it and reload the updated XML to apply the new startup configuration.
Other scenario services must not subsequently override these firewall rules.

`core-router-uplink-sce-web.sh` is the original IP/MAC substitution snippet.
It replaces `11.0.0.1` with `11.0.0.<instance-index>` throughout the XML.
The options and firewall settings above belong to `setup_llm_proxy-v2.sh`.
