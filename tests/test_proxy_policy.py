import json
import os
import sqlite3
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import pytest

from app import create_app
from app.proxy_policy import normalize_proxy_config, proxy_setup_command
from app.routes import api
from app.storage.runtime import RuntimeStore


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scenarioforge-ctfd-grain-config" / "setup_llm_proxy-v2.sh"
SCENARIO = ROOT / "scenarioforge-ctfd-grain-config" / "myscenario.xml"


def _policy(**overrides):
    return {
        "router_node": "n3", "scenario_xml": "/root/myscenario.xml",
        "external_interface": "eth1", "uplink_bridge": "vmbr0",
        "uplink_gateway": "11.0.0.254", "internal_sources": ["13.0.0.101/32"],
        "mode": "restricted",
        "external_addresses": ["100.100.100.100:8080:129.108.156.63:11434"],
        **overrides,
    }


def _vm(**overrides):
    return {
        "name": "proxy", "vm_type": "qemu",
        "internal_network_adaptors": ["lab", "vmbr0"],
        "internet_connected_adaptors": ["vmbr0"],
        "proxy_config": _policy(),
        **overrides,
    }


def test_proxy_run_history_preserves_old_policy_and_keeps_ten_unique_runs(tmp_path):
    store = RuntimeStore(str(tmp_path))

    def policy(port):
        return {
            'mode': 'restricted', 'internal_sources': ['13.0.0.101/32', '13.0.0.102/32'],
            'external_addresses': [], 'translations': [f'198.51.100.12:8080:203.0.113.25:{port}'],
        }

    old = policy(8000)
    with sqlite3.connect(tmp_path / 'proxy_history.sqlite3') as db:
        db.execute('CREATE TABLE proxy_history (project_id TEXT, vm_name TEXT, policy TEXT, PRIMARY KEY (project_id, vm_name))')
        db.execute('INSERT INTO proxy_history VALUES (?, ?, ?)', ('lab', 'proxy-1', json.dumps(old)))
    assert store.get_proxy_run_history('lab')['proxy-1'] == [{'policy': old, 'appliedAt': None}]

    store.save_applied_proxy_policies('lab', {'proxy-1': policy(8001), 'proxy-2': policy(9000)})
    assert [run['policy'] for run in store.get_proxy_run_history('lab')['proxy-1']] == [policy(8001), old]
    for port in range(8002, 8012):
        store.save_applied_proxy_policies('lab', {'proxy-1': policy(port)})
    replayed = policy(8005)
    replayed['internal_sources'].reverse()
    store.save_applied_proxy_policies('lab', {'proxy-1': replayed})

    history = store.get_proxy_run_history('lab')
    expected_ports = [8011, 8010, 8009, 8008, 8007, 8006, 8004, 8003, 8002]
    assert [run['policy'] for run in history['proxy-1']] == [replayed, *map(policy, expected_ports)]
    assert history['proxy-1'][0]['appliedAt'] > 0
    assert [run['policy'] for run in history['proxy-2']] == [policy(9000)]
    assert store.get_proxy_run_history('another-project') == {}


def test_proxy_policy_api_persists_and_protects_uplink():
    old_auth = os.environ.get("AUTH_ENABLE")
    os.environ["AUTH_ENABLE"] = "0"
    try:
        with tempfile.TemporaryDirectory() as directory:
            app = create_app()
            app.config.update(TESTING=True, DATA_DIR=directory)
            client = app.test_client()
            created = client.post("/api/projects", json={"name": "CORE Lab", "vms": [_vm()]})
            assert created.status_code == 201, created.get_json()
            pid = created.get_json()["id"]
            stored = created.get_json()["vms"][0]
            assert stored["proxy_config"]["router_node"] == "n3"

            command = client.get(f"/api/projects/{pid}/vms/proxy/proxy-command")
            assert command.status_code == 200, command.get_json()
            assert "{{instance_index}}" in command.get_json()["command"]
            assert "--internal-sources 13.0.0.101/32" in command.get_json()["command"]
            restart = client.get(f"/api/projects/{pid}/vms/proxy/proxy-command?restart=1")
            assert restart.status_code == 200
            assert "--restart-core" in restart.get_json()["command"]

            for invalid in ('100.100.100.100:8080:129.108.156.63:11434-11436',
                            '100.100.100.100:8080:129.108.156.6311434-11436'):
                rejected = client.patch(f"/api/projects/{pid}/vms/proxy", json={
                    'proxy_config': _policy(external_addresses=[], translations=[invalid]),
                })
                assert rejected.status_code == 400
                assert 'one TCP port' in rejected.get_json()['error']

            bad_nics = client.patch(f"/api/projects/{pid}/vms/proxy", json={
                "internal_network_adaptors": ["vmbr0"],
                "internet_connected_adaptors": ["vmbr0"],
            })
            assert bad_nics.status_code == 400
            assert "internal interface" in bad_nics.get_json()["error"]

            bad_uplink = client.patch(f"/api/projects/{pid}/vms/proxy", json={
                "proxy_config": {**stored["proxy_config"], "uplink_bridge": "vmbr1"},
            })
            assert bad_uplink.status_code == 400
            assert "sole Internet uplink" in bad_uplink.get_json()["error"]

            moved_policy = {**stored["proxy_config"], "uplink_bridge": "vmbr1"}
            moved_uplink = client.patch(f"/api/projects/{pid}/vms/proxy", json={
                "internal_network_adaptors": ["lab", "vmbr1"],
                "internet_connected_adaptors": ["vmbr1"],
                "proxy_config": moved_policy,
            })
            assert moved_uplink.status_code == 200, moved_uplink.get_json()
            moved_vm = moved_uplink.get_json()["vms"][0]
            assert moved_vm["internal_network_adaptors"] == ["lab", "vmbr1"]
            assert moved_vm["internet_connected_adaptors"] == ["vmbr1"]
            assert moved_vm["proxy_config"] == moved_policy

            reorder_data = {
                "internal_network_adaptors": ["vmbr1", "lab"],
                "internet_connected_adaptors": ["vmbr1"],
            }
            with patch.dict(app.config, {"AUTH_ENABLE": True}), patch.object(
                app, "current_user", return_value={"username": "member", "roles": ["user"]}
            ):
                forbidden = client.patch(f"/api/projects/{pid}/vms/proxy", json=reorder_data)
                assert forbidden.status_code == 403
                assert "move the CORE gateway uplink" in forbidden.get_json()["error"]

            reordered = client.patch(f"/api/projects/{pid}/vms/proxy", json=reorder_data)
            assert reordered.status_code == 200, reordered.get_json()
            reordered_vm = reordered.get_json()["vms"][0]
            assert reordered_vm["internal_network_adaptors"] == ["vmbr1", "lab"]
            assert reordered_vm["proxy_config"] == moved_policy

            full = client.patch(f"/api/projects/{pid}/vms/proxy", json={
                "proxy_config": _policy(uplink_bridge="vmbr1", mode="full", external_addresses=[],
                                        internal_sources=["13.0.0.0/24", "10.0.3.0/24"]),
            })
            assert full.status_code == 200, full.get_json()
            assert full.get_json()["vms"][0]["proxy_config"]["external_addresses"] == []
            command = client.get(f"/api/projects/{pid}/vms/proxy/proxy-command").get_json()["command"]
            assert "--mode full" in command
            assert "--clear-external-addresses" in command
            assert "13.0.0.0/24" in command and "10.0.3.0/24" in command
    finally:
        if old_auth is None:
            os.environ.pop("AUTH_ENABLE", None)
        else:
            os.environ["AUTH_ENABLE"] = old_auth


def test_restricted_policy_needs_an_address_to_generate_command():
    policy = normalize_proxy_config(_policy(external_addresses=[]))
    try:
        proxy_setup_command(policy)
    except ValueError as exc:
        assert "allowed address or translation" in str(exc)
    else:
        raise AssertionError("Restricted policy without addresses should not be staged")


def test_full_mode_clears_allowlist_and_keeps_translations():
    mapping = "100.100.100.100:8080:129.108.156.63:11434-11436"
    policy = normalize_proxy_config(_policy(mode="full", external_addresses=["129.108.4.46:443", mapping]))
    assert policy["external_addresses"] == []
    assert policy["translations"] == [mapping]
    command = proxy_setup_command(policy)
    assert "--external-addresses" in command
    assert mapping in command
    assert "129.108.4.46:443" not in command


def test_core_script_full_access_for_multiple_source_networks():
    with tempfile.TemporaryDirectory() as directory:
        scenario = Path(directory) / "myscenario.xml"
        scenario.write_bytes(SCENARIO.read_bytes())
        result = subprocess.run([
            "bash", str(SCRIPT), "--instance-index", "48", "--scenario-xml", str(scenario),
            "--router-node", "n3", "--mode", "full", "--internal-sources",
            "13.0.0.0/24", "10.0.3.0/24", "--clear-external-addresses",
            "--no-legacy-port-settings",
        ], capture_output=True, text=True,
            env={**os.environ, "EXTERNAL_ADDRESSES": "129.108.156.63", "DEST_PORT": "8080"})
        assert result.returncode == 0, result.stderr
        root = ET.parse(scenario).getroot()
        router = root.find("./service_configurations/service[@name='IPForward'][@node='3']")
        template = router.find("./templates/template[@name='ipforward.sh']").text
        assert "ip route replace default via 11.0.0.254 dev eth1" in template
        assert "-A SCE_UPLINK_NAT -s 13.0.0.0/24 -j SNAT --to-source 11.0.0.48" in template
        assert "-A SCE_UPLINK_OUT -s 10.0.3.0/24 -m conntrack --ctstate NEW,ESTABLISHED" in template
        assert "-A SCE_UPLINK_IN -d 10.0.3.0/24 -m conntrack --ctstate ESTABLISHED,RELATED" in template
        assert "129.108.156.63" not in template


@pytest.mark.parametrize('instance_index', [48, 68])
def test_proxy_action_saves_instance_uplink_before_restarting_session(monkeypatch, instance_index):
    monkeypatch.setenv('AUTH_ENABLE', '0')
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        scenario = work / "myscenario.xml"
        scenario.write_bytes(SCENARIO.read_bytes())
        state = work / "sessions.json"
        state.write_text('[{"id": 7, "file": "' + str(scenario) + '", "state": 4}]')
        cli = work / "core-cli"
        cli.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
import xml.etree.ElementTree as ET
state = Path(os.environ['FAKE_CORE_STATE'])
sessions = json.loads(state.read_text())
args = sys.argv[2:]

def check_saved_uplink(xml_path):
    expected_ip = os.environ['FAKE_CORE_EXPECTED_UPLINK']
    root = ET.parse(xml_path).getroot()
    uplink = root.find('./links/link[@node1="3"][@node2="2"]/iface1')
    assert uplink.attrib['name'] == 'eth1'
    assert uplink.attrib['ip4'] == expected_ip
    assert uplink.attrib['ip4_mask'] == '24'
    lan = root.find('./links/link[@node1="3"][@node2="1"]/iface1')
    assert lan.attrib['ip4'] == '13.0.0.1'
    service = root.find('./service_configurations/service[@name="IPForward"][@node="3"]')
    template = service.find('./templates/template[@name="ipforward.sh"]').text
    assert f'--to-source {expected_ip}' in template

if args == ['query', 'sessions']:
    result = sessions
elif args[:2] == ['session', '--id'] and args[-1] == 'delete':
    session_id = int(args[2])
    check_saved_uplink(next(s['file'] for s in sessions if s['id'] == session_id))
    sessions = [s for s in sessions if s['id'] != session_id]
    state.write_text(json.dumps(sessions))
    result = {'result': True}
elif args[:2] == ['xml', '--file'] and args[-1] == '--start':
    check_saved_uplink(args[2])
    sessions.append({'id': 8, 'file': args[2], 'state': 4})
    state.write_text(json.dumps(sessions))
    result = {'result': True, 'session_id': 8}
else:
    raise SystemExit(2)
print(json.dumps(result))
""")
        cli.chmod(0o755)
        applied_mapping = f'100.100.100.100:8080:129.108.156.63:{12000 + instance_index}'
        fail_restart = False

        def execute(_client, *, node, vmid, command, input_data, timeout):
            assert node == 'pve' and vmid == 101
            assert command.startswith(f'bash -s -- --instance-index {instance_index} ')
            assert input_data == SCRIPT.read_text()
            if fail_restart:
                return {'exitcode': 1, 'stderr': 'CORE failed to start'}
            assert applied_mapping in command
            result = subprocess.run(
                ["sh", "-c", command], input=input_data, capture_output=True, text=True, timeout=5,
                env={**os.environ, "PATH": f"{work}:{os.environ['PATH']}", "FAKE_CORE_STATE": str(state),
                     "FAKE_CORE_EXPECTED_UPLINK": f"11.0.0.{instance_index}"},
            )
            return {'exitcode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}

        monkeypatch.setattr(api.ProxmoxClient, 'agent_exec', execute)
        monkeypatch.setattr(api, '_list_cluster_vms_by_name', lambda _client: (
            {f'proxy-lab-{instance_index}': {'node': 'pve', 'vmid': 101, 'type': 'qemu'}}, None,
        ))
        app = create_app()
        app.config.update(TESTING=True, DATA_DIR=directory)
        client = app.test_client()
        created = client.post('/api/projects', json={
            'name': 'CORE Lab', 'tag': '-lab-', 'instances': instance_index,
            'vms': [_vm(proxy_config=_policy(scenario_xml=str(scenario)))],
        })
        assert created.status_code == 201, created.get_json()
        pid = created.get_json()['id']
        with app.app_context():
            api._store().update_vm(pid, 'proxy', proxy_config=_policy(external_addresses=[], translations=[
                '100.100.100.100:8080:129.108.156.63:11434-11436',
            ], scenario_xml=str(scenario)))
        target = {'index': instance_index, 'name': f'proxy-lab-{instance_index}'}
        preview_url = f'/api/projects/{pid}/proxy-restart/preview'
        preview = client.post(preview_url, json={'targets': [target]}).get_json()['targets'][0]
        assert preview['has_previous'] is False
        expected_port = {48: 11436, 68: 11435}[instance_index]
        assert preview['policy']['translations'] == [f'100.100.100.100:8080:129.108.156.63:{expected_port}']
        policy = {**preview['policy'], 'translations': [applied_mapping]}
        range_override = {**policy, 'translations': ['100.100.100.100:8080:129.108.156.63:11434-11436']}
        rejected = client.post(preview_url, json={'targets': [{**target, 'policy': range_override}]})
        assert rejected.status_code == 400
        assert f'{target["name"]}: Invalid translation' in rejected.get_json()['error']
        action_url = f'/api/projects/{pid}/instances/actions/configure_restart_proxy'
        action_body = {
            'baseUrl': 'https://pve.example', 'username': 'root@pam', 'password': 'test',
            'targets': [{**target, 'policy': policy}],
        }
        missing_review = client.post(action_url, json={**action_body, 'targets': [target]})
        assert missing_review.status_code == 400
        assert 'review the proxy settings before restarting' in missing_review.get_json()['error']
        response = client.post(action_url, json=action_body)
        result = response.get_json()
        assert response.status_code == 200, result
        assert result['errors'] == []
        assert 'Started CORE session 8' in result['ran'][0]['cmds'][0]['stdout_preview']
        assert scenario.with_suffix('.xml.bak').read_bytes() == SCENARIO.read_bytes()
        assert json.loads(state.read_text()) == [{"id": 8, "file": str(scenario.resolve()), "state": 4}]

        fail_restart = True
        action_body['targets'][0]['policy'] = {**policy, 'translations': ['100.100.100.100:8080:129.108.156.63:15000']}
        failed = client.post(action_url, json=action_body).get_json()
        assert 'CORE failed to start' in failed['errors'][0]['reason']
        saved, other = client.post(preview_url, json={
            'targets': [target, {'index': 1, 'name': 'proxy-lab-1'}],
        }).get_json()['targets']
        assert saved['has_previous'] and saved['policy'] == policy
        assert [run['policy'] for run in saved['history']] == [policy]
        assert saved['defaults'] == preview['defaults']
        assert not other['has_previous']
        assert other['history'] == []
        assert other['policy']['translations'] == ['100.100.100.100:8080:129.108.156.63:11434']


def test_core_script_refuses_unrelated_session_before_changing_xml():
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        scenario = work / "myscenario.xml"
        original = SCENARIO.read_bytes()
        scenario.write_bytes(original)
        cli = work / "core-cli"
        cli.write_text('#!/bin/sh\nprintf \'[{"id": 9, "file": "/root/other.xml", "state": 4}]\\n\'\n')
        cli.chmod(0o755)
        result = subprocess.run([
            "bash", str(SCRIPT), "--instance-index", "48", "--scenario-xml", str(scenario),
            "--router-node", "n3", "--mode", "full", "--internal-sources", "13.0.0.0/24",
            "--clear-external-addresses", "--no-legacy-port-settings", "--restart-core",
        ], capture_output=True, text=True, env={**os.environ, "PATH": f"{work}:{os.environ['PATH']}"})
        assert result.returncode != 0
        assert "Could not identify one CORE session" in result.stderr
        assert scenario.read_bytes() == original


def test_core_script_restricted_mappings_keep_each_source_limited():
    with tempfile.TemporaryDirectory() as directory:
        scenario = Path(directory) / "myscenario.xml"
        scenario.write_bytes(SCENARIO.read_bytes())
        result = subprocess.run([
            "bash", str(SCRIPT), "--instance-index", "48", "--scenario-xml", str(scenario),
            "--router-node", "n3", "--mode", "restricted", "--no-legacy-port-settings",
            "--internal-sources", "13.0.0.101/32", "10.0.3.0/24",
            "--external-addresses", "100.100.100.100:8080:129.108.156.63:11434-11436",
        ], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        root = ET.parse(scenario).getroot()
        router = root.find("./service_configurations/service[@name='IPForward'][@node='3']")
        template = router.find("./templates/template[@name='ipforward.sh']").text
        assert "-s 13.0.0.101/32 -d 100.100.100.100/32 -p tcp --dport 8080" in template
        assert "-s 10.0.3.0/24 -d 100.100.100.100/32 -p tcp --dport 8080" in template
        assert "--to-destination 129.108.156.63:11436" in template
        assert "ip route replace default" not in template


def test_core_script_rejects_full_mode_with_endpoint_entries():
    with tempfile.TemporaryDirectory() as directory:
        scenario = Path(directory) / "myscenario.xml"
        scenario.write_bytes(SCENARIO.read_bytes())
        original = scenario.read_bytes()
        result = subprocess.run([
            "bash", str(SCRIPT), "--instance-index", "48", "--scenario-xml", str(scenario),
            "--router-node", "n3", "--mode", "full", "--no-legacy-port-settings",
            "--external-addresses", "129.108.156.63",
        ], capture_output=True, text=True)
        assert result.returncode != 0
        assert "direct allowed destinations" in result.stderr
        assert scenario.read_bytes() == original


def test_core_script_full_mode_keeps_explicit_translation():
    with tempfile.TemporaryDirectory() as directory:
        scenario = Path(directory) / "myscenario.xml"
        scenario.write_bytes(SCENARIO.read_bytes())
        result = subprocess.run([
            "bash", str(SCRIPT), "--instance-index", "48", "--scenario-xml", str(scenario),
            "--router-node", "n3", "--mode", "full", "--no-legacy-port-settings",
            "--internal-sources", "13.0.0.101/32",
            "--external-addresses", "100.100.100.100:8080:129.108.156.63:11434-11436",
        ], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        root = ET.parse(scenario).getroot()
        router = root.find("./service_configurations/service[@name='IPForward'][@node='3']")
        template = router.find("./templates/template[@name='ipforward.sh']").text
        assert "ip route replace default via 11.0.0.254 dev eth1" in template
        assert "--to-destination 129.108.156.63:11436" in template
        assert "-A SCE_UPLINK_NAT -s 13.0.0.101/32 -j SNAT --to-source 11.0.0.48" in template
