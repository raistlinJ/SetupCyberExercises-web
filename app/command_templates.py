"""Literal command variables from project and guest metadata."""
import re


class CommandTemplateError(ValueError):
    pass


TOKEN = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
SAFE_VALUE = re.compile(r"[A-Za-z0-9_.:/-]+\Z")
VARIABLES = {
    "instance_index": "Stable 1-based instance number, shared by its guests.",
    "vmid": "Resolved Proxmox guest ID (may change after recreating a guest).",
    "vm_name": "Generated guest name.",
    "project_id": "Project ID.",
}


def command_context(project, guest):
    index = guest.get("index")
    if type(index) is not int or index < 1 or index > project.instances:
        raise CommandTemplateError("Invalid instance index for this project")
    context = {"instance_index": index, "vmid": guest.get("vmid"),
               "vm_name": guest.get("name"), "project_id": project.id}
    return context


def render_command(command, project, guest, *, enabled=True):
    # Leave ordinary commands, Bash ${...}, awk braces, and JSON untouched.
    if not enabled or not TOKEN.search(command):
        return command
    context = command_context(project, guest)

    def replace(match):
        key = match.group(1)
        if key not in VARIABLES:
            raise CommandTemplateError(f"Unknown command variable: {key}")
        value = context.get(key)
        if value is None:
            raise CommandTemplateError(f"Variable {key} is unavailable; refresh guest inventory or provide a preview VMID")
        text = str(value)
        if not SAFE_VALUE.fullmatch(text):
            raise CommandTemplateError(f"Variable {key} contains characters that are not safe for literal shell substitution")
        return text

    return TOKEN.sub(replace, command)
