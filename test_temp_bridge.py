import re

err_msg = """Proxmox set lxc net error 500: {"data":null,"message":"bridge 'acosta1' does not exist\n"}"""
match = re.search(r"bridge '([^']+)' does not exist", err_msg)
if match:
    print(match.group(1))
