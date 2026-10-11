import base64
import io
import struct
from unittest.mock import Mock, patch

from PIL import Image
from app.connectors.vm_screenshot import capture


def test_capture_decodes_fragmented_raw_console_and_closes_connection():
    pixel_format = bytes(16)
    stream = (b'RFB 003.008\n' + b'\x01\x01' + bytes(4)
              + struct.pack('!HH', 512, 256) + pixel_format + struct.pack('!I', 4) + b'test'
              + b'\0\0' + struct.pack('!H', 1) + struct.pack('!HHHHi', 0, 0, 512, 256, 0)
              + bytes([0, 0, 255, 0]) * (512 * 256))
    ws = Mock()
    ws.recv.side_effect = [stream[:7], stream[7:30], stream[30:]]
    client = Mock(base_url='https://pve.example', verify=True)
    session = client._ensure_session.return_value
    session.cookies.items.return_value = [('PVEAuthCookie', 'auth')]
    session.headers.items.return_value = []
    session.post.return_value.json.return_value = {'data': {'port': 5900, 'ticket': 'console-ticket'}}
    with patch('websocket.create_connection', return_value=ws):
        result = capture(client, 'node1', 100)
    decoded = Image.open(io.BytesIO(base64.b64decode(result.split(',')[1])))
    assert decoded.size == (240, 120)
    red, green, blue = decoded.getpixel((0, 0))
    assert red > 240 and green < 10 and blue < 10
    ws.close.assert_called_once()


def test_inventory_save_preserves_capture_completed_after_scan_started(tmp_path):
    from app.storage.projects import Project, ProjectStore
    store = ProjectStore(str(tmp_path))
    identity = {'name': 'web-1', 'node': 'node1', 'vmid': 100}
    project = Project(id='one', name='One')
    project.instance_statuses = [{'index': 1, 'vm_details': [{**identity, 'state': 'running'}]}]
    store.upsert(project)
    stale_scan = [{'index': 1, 'vm_details': [{**identity, 'state': 'paused'}]}]
    captured = [{'index': 1, 'vm_details': [{**identity, 'state': 'running',
                 'screenshot': 'new-image', 'screenshot_at': 'now'}]}]
    store.update_vm_inventory('one', captured)
    result = store.update_vm_inventory('one', stale_scan, screenshot_targets=set())
    detail = result.instance_statuses[0]['vm_details'][0]
    assert detail['state'] == 'paused'
    assert detail['screenshot'] == 'new-image'
    assert detail['screenshot_stale'] is True
    assert store.get('one').instance_statuses[0]['vm_details'][0]['screenshot'] == 'new-image'
