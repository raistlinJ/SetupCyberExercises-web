import re

def _adaptor_numeric_suffix_letters(value) -> str:
    mapping = { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f', '6': 'g', '7': 'h', '8': 'i', '9': 'j' }
    return ''.join(mapping.get(c, c) for c in str(value))

def _normalize_bridge_adaptor_name(adaptor_name) -> str:
    try:
        raw = str(adaptor_name or '').strip()
        if not raw:
            return ''
        base = re.sub(r"[^A-Za-z]", "", raw)
        suffix = ''
        digit_match = re.search(r"(\d+)$", raw)
        if digit_match:
            suffix = _adaptor_numeric_suffix_letters(digit_match.group(1))
        if suffix:
            allowed_base = max(0, 8 - len(suffix))
            return f"{base[:allowed_base]}{suffix}" or suffix[:8]
        return base[:8]
    except Exception:
        return ''

def _bridge_iface_name(idx, adaptor_name) -> str:
    try:
        index = int(idx)
    except Exception:
        index = 0
    base = _normalize_bridge_adaptor_name(adaptor_name)
    name = f"{base}{index}" if base else f"br{index}"
    if len(name) > 15:
        name = name[:15]
    return name or f"br{index}"

print(_bridge_iface_name(1, "acosta1"))
