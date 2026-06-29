import sys
from app import create_app
from app.routes.api import get_client

def main():
    app = create_app()
    with app.app_context():
        client = get_client()
        nodes = client.get_nodes()
        for n in nodes:
            node = n['node']
            lxcs = client.get_lxc(node)
            for lxc in lxcs:
                vmid = lxc['vmid']
                if "kpmx3" in lxc.get('name', ''):
                    print(f"Found LXC: {vmid} on {node}")
                    try:
                        cfg = client.get_lxc_config(node, vmid)
                        print(f"Config: {cfg}")
                        return
                    except Exception as e:
                        print(f"Error getting config: {e}")

if __name__ == '__main__':
    main()
