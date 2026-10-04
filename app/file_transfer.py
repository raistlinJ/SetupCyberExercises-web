"""VM-note file transfer policy management."""
import json


def config_policy(vm):
    accessible = getattr(vm, "viewable_to_user", False) is True
    return {"file_upload": accessible and getattr(vm, "file_upload", False) is True,
            "file_download": accessible and getattr(vm, "file_download", False) is True}


def write_policy(description, policy):
    # Preserve human notes, credentials and unrelated JSON; replace only our namespace.
    source = str(description or "")
    decoder = json.JSONDecoder()
    parts = []
    cursor = 0
    while cursor < len(source):
        start = source.find("{", cursor)
        if start < 0:
            parts.append(source[cursor:])
            break
        try:
            obj, length = decoder.raw_decode(source[start:])
        except ValueError:
            if '"AccessForge"' in source[start:]:
                raise ValueError('Repair malformed AccessForge policy JSON in VM Notes before changing transfer settings')
            parts.append(source[cursor:start + 1])
            cursor = start + 1
            continue
        parts.append(source[cursor:start])
        if isinstance(obj, dict) and "AccessForge" in obj:
            del obj["AccessForge"]
            if obj:
                parts.append(json.dumps(obj, indent=4))
        else:
            parts.append(source[start:start + length])
        cursor = start + length
    clean = ''.join(parts).strip()
    metadata = json.dumps({"AccessForge": policy}, indent=4)
    return (clean + "\n\n" if clean else "") + metadata


def _unique_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("Duplicate metadata key")
        obj[key] = value
    return obj


def read_policy(description):
    disabled = {"file_upload": False, "file_download": False}
    if not isinstance(description, str):
        return disabled
    decoder = json.JSONDecoder(object_pairs_hook=_unique_keys)
    policies = []
    cursor = 0
    while cursor < len(description):
        start = description.find("{", cursor)
        if start < 0:
            break
        try:
            obj, length = decoder.raw_decode(description[start:])
        except ValueError:
            # A broken policy must not expose an inner JSON object as policy.
            if '"AccessForge"' in description[start:]:
                return disabled
            cursor = start + 1
            continue
        if isinstance(obj, dict) and "AccessForge" in obj:
            policies.append(obj["AccessForge"])
        cursor = start + length
    if len(policies) != 1 or not isinstance(policies[0], dict):
        return disabled
    return {key: policies[0].get(key) is True for key in disabled}
