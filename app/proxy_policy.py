"""Validation and command generation for CORE gateway VMs."""

from __future__ import annotations

import ipaddress
from pathlib import Path
import re
import shlex
from typing import Any


DEFAULT_PROXY_CONFIG = {
    "router_node": "",
    "scenario_xml": "/root/myscenario.xml",
    "external_interface": "eth1",
    "uplink_bridge": "vmbr0",
    "uplink_gateway": "11.0.0.254",
    "internal_sources": ["13.0.0.101/32"],
    "mode": "restricted",
    "external_addresses": [],
    "translations": [],
}

PROXY_POLICY_FIELDS = ("mode", "internal_sources", "external_addresses", "translations")


def fixed_proxy_translations(translations: list[str], *, instance_index: int | None = None) -> list[str]:
    """Validate explicit mappings, resolving saved legacy ranges only for a specific instance."""
    fixed = []
    destinations = {}
    for entry in translations:
        try:
            client, client_port, destination, backend_ports = entry.split(":")
            client = str(ipaddress.IPv4Address(client))
            if re.fullmatch(r"[0-9.]+", destination):
                destination = str(ipaddress.IPv4Address(destination))
            elif len(destination) > 253 or not all(
                re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                for label in destination.rstrip(".").split(".")
            ):
                raise ValueError("Invalid backend hostname")
            if not re.fullmatch(r"[0-9]{1,5}", client_port):
                raise ValueError("Invalid client port")
            if re.fullmatch(r"[0-9]{1,5}", backend_ports):
                low = high = int(backend_ports)
            elif instance_index is not None and re.fullmatch(r"[0-9]{1,5}-[0-9]{1,5}", backend_ports):
                low, high = map(int, backend_ports.split("-"))
            else:
                raise ValueError("Invalid backend port")
            if not 1 <= int(client_port) <= 65535 or not 1 <= low <= high <= 65535:
                raise ValueError("Port out of bounds")
        except ValueError as exc:
            raise ValueError(
                f"Invalid translation {entry!r}. Use CLIENT_IP:CLIENT_PORT:BACKEND_IP_OR_HOST:BACKEND_PORT "
                "with one TCP port (1–65535) on each side."
            ) from exc
        client_endpoint = f"{client}:{int(client_port)}"
        backend_port = low if instance_index is None else low + (instance_index - 1) % (high - low + 1)
        backend_endpoint = f"{destination}:{backend_port}"
        if client_endpoint in destinations:
            if destinations[client_endpoint] != backend_endpoint:
                raise ValueError(f"Enter only one backend for translated endpoint {client_endpoint}.")
            continue
        destinations[client_endpoint] = backend_endpoint
        fixed.append(f"{client_endpoint}:{backend_endpoint}")
    return fixed


def validate_default_proxy_translations(config: dict, previous: dict | None = None) -> dict:
    """Permit unrelated edits to configurations that still contain legacy mappings."""
    if config and config["translations"] != (previous or {}).get("translations", []):
        config["translations"] = fixed_proxy_translations(config["translations"])
    return config


def editable_proxy_policy(config: dict) -> dict:
    return {key: config[key] for key in PROXY_POLICY_FIELDS}


def proxy_restart_policy(defaults: dict, override: Any, instance_index: int) -> dict:
    if override is not None and (not isinstance(override, dict) or set(override) != set(PROXY_POLICY_FIELDS)):
        raise ValueError("Provide the access mode, internal sources, allowed destinations, and translated endpoints.")
    config = normalize_proxy_config({**defaults, **(override or {})})
    config["translations"] = fixed_proxy_translations(
        config["translations"], instance_index=instance_index if override is None else None,
    )
    return config


def normalize_proxy_config(value: Any) -> dict:
    """Return a validated policy. An empty dict means an ordinary VM."""
    if value is None or value == {}:
        return {}
    if not isinstance(value, dict):
        raise ValueError("proxy_config must be an object")
    config = {**DEFAULT_PROXY_CONFIG, **value}
    for key in ("router_node", "scenario_xml", "external_interface", "uplink_bridge", "uplink_gateway", "mode"):
        if not isinstance(config[key], str):
            raise ValueError(f"proxy_config.{key} must be a string")
        config[key] = config[key].strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", config["router_node"]):
        raise ValueError("CORE router node must be a name or numeric ID")
    if (not config["scenario_xml"].startswith("/") or "\n" in config["scenario_xml"]
            or "\r" in config["scenario_xml"] or len(config["scenario_xml"]) > 512):
        raise ValueError("CORE scenario XML must be an absolute path")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}", config["external_interface"]):
        raise ValueError("CORE external interface must be a Linux interface name")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,15}", config["uplink_bridge"]):
        raise ValueError("Proxy uplink bridge must be a Linux bridge name")
    try:
        config["uplink_gateway"] = str(ipaddress.IPv4Address(config["uplink_gateway"]))
    except ipaddress.AddressValueError as exc:
        raise ValueError("Proxy uplink gateway must be an IPv4 address") from exc
    if config["mode"] not in {"restricted", "full"}:
        raise ValueError("Proxy access mode must be restricted or full")
    sources = config["internal_sources"]
    if isinstance(sources, str):
        sources = sources.splitlines()
    if not isinstance(sources, list) or not sources:
        raise ValueError("Proxy requires at least one internal source IP or CIDR")
    normalized_sources = []
    for source in sources:
        try:
            network = ipaddress.IPv4Network(str(source).strip(), strict=False)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"Invalid proxy internal source: {source!r}") from exc
        if network.prefixlen == 0:
            raise ValueError("Proxy internal sources cannot include all IPv4 addresses")
        text = str(network)
        if text not in normalized_sources:
            normalized_sources.append(text)
    config["internal_sources"] = normalized_sources
    def entries(raw: Any, label: str) -> list[str]:
        if isinstance(raw, str):
            raw = raw.splitlines()
        if not isinstance(raw, list):
            raise ValueError(f"Proxy {label} must be a list")
        clean = []
        for entry in raw:
            text = str(entry).strip()
            if not text:
                continue
            if not re.fullmatch(r"[A-Za-z0-9.:-]+", text) or len(text) > 512:
                raise ValueError(f"Invalid proxy {label} entry: {text!r}")
            clean.append(text)
        return clean

    # Existing policies stored both kinds in external_addresses. Move mappings
    # into their own field without losing the user's current translations.
    combined = entries(config["external_addresses"], "external addresses")
    translations = entries(config["translations"], "translations")
    direct = []
    for entry in combined:
        (translations if entry.count(":") >= 2 else direct).append(entry)
    if any(entry.count(":") not in (2, 3) for entry in translations):
        raise ValueError("Translations must use CLIENT_IP:CLIENT_PORT:BACKEND_IP_OR_HOST:BACKEND_PORT")
    config["external_addresses"] = [] if config["mode"] == "full" else direct
    config["translations"] = list(dict.fromkeys(translations))
    return config


def validate_proxy_vm(vm: Any) -> dict:
    """Check a gateway VM's dedicated uplink and internal NIC placement."""
    field = lambda key, default=None: vm.get(key, default) if isinstance(vm, dict) else getattr(vm, key, default)
    config = normalize_proxy_config(field("proxy_config"))
    if not config:
        return {}
    if field("vm_type", "qemu") != "qemu":
        raise ValueError("A CORE gateway must be a QEMU VM")
    adaptors = field("internal_network_adaptors") or []
    internet = field("internet_connected_adaptors") or []
    if not isinstance(adaptors, list) or not isinstance(internet, list):
        raise ValueError("Proxy network interfaces must be lists")
    bridge = config["uplink_bridge"]
    if len(adaptors) < 2 or adaptors[1] != bridge:
        raise ValueError(f"CORE gateway needs an internal NIC at net0 and its fixed {bridge} uplink at net1")
    if internet != [bridge] or adaptors.count(bridge) != 1:
        raise ValueError("CORE gateway must have exactly one internet-connected uplink")
    return config


def proxy_setup_script() -> str:
    """Load the setup script bundled with DeployForge."""
    return (Path(__file__).with_name("guest_scripts") / "setup_llm_proxy-v2.sh").read_text(encoding="utf-8")


def proxy_setup_command(config: dict, *, restart_core: bool = False, script_from_stdin: bool = False) -> str:
    """Build the guest command for the supplied or installed setup script."""
    policy = normalize_proxy_config(config)
    if not policy:
        raise ValueError("A CORE gateway policy is required")
    if policy["mode"] == "restricted" and not (policy["external_addresses"] or policy["translations"]):
        raise ValueError("Restricted proxy access needs at least one allowed address or translation")
    args = ["bash", "-s", "--"] if script_from_stdin else ["bash", "/home/corevm/setup_llm_proxy-v2.sh"]
    args.extend([
        "--instance-index", "{{instance_index}}",
        "--scenario-xml", policy["scenario_xml"], "--router-node", policy["router_node"],
        "--external-interface", policy["external_interface"], "--uplink-gateway", policy["uplink_gateway"],
        "--mode", policy["mode"], "--no-legacy-port-settings",
        "--internal-sources", *policy["internal_sources"],
    ])
    destinations = policy["external_addresses"] + policy["translations"]
    if destinations:
        args.extend(["--external-addresses", *destinations])
    else:
        args.append("--clear-external-addresses")
    if restart_core:
        args.append("--restart-core")
    return " ".join(arg if arg == "{{instance_index}}" else shlex.quote(arg) for arg in args)
