"""Title/link materials published to AccessForge through Proxmox Notes."""
from urllib.parse import urlsplit


def normalize_material_links(value, *, strict=False):
    if not isinstance(value, list):
        if strict:
            raise ValueError('materials must be a list of title/link entries')
        return []
    result, seen = [], set()
    for index, entry in enumerate(value, 1):
        try:
            if not isinstance(entry, dict):
                raise ValueError('must have a title and URL')
            title, url = entry.get('title'), entry.get('url')
            if not isinstance(title, str) or not title.strip():
                raise ValueError('title is required')
            if not isinstance(url, str) or not url.strip():
                raise ValueError('URL is required')
            title, url = title.strip(), url.strip()
            if any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == '\\' for c in url):
                raise ValueError('URL must not contain whitespace or control characters')
            parsed = urlsplit(url)
            if parsed.scheme not in ('https', 'http') or not parsed.hostname:
                raise ValueError('URL must be an absolute HTTP or HTTPS link')
            parsed.port
        except ValueError as exc:
            if strict:
                raise ValueError(f'Material {index}: {exc}') from exc
            continue
        if url not in seen:
            seen.add(url)
            result.append({'title': title, 'url': url})
    return result


def config_materials(vm):
    category = getattr(vm, 'material_category', '')
    category = category.strip() if isinstance(category, str) else ''
    return {'Material Category': category or 'Misc',
            'materials': normalize_material_links(getattr(vm, 'materials', []))}
