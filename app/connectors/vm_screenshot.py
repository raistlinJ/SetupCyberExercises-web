"""Read one raw RFB framebuffer over an authenticated Proxmox console."""
import base64
import io
import ssl
import struct
import time
from urllib.parse import urlencode, quote


def capture(client, node, vmid):
    import websocket
    from PIL import Image
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    session = client._ensure_session()
    path = f'/api2/json/nodes/{quote(str(node), safe="")}/qemu/{int(vmid)}'
    response = session.post(client.base_url.rstrip('/') + path + '/vncproxy', data={'websocket': 1}, timeout=15)
    response.raise_for_status()
    proxy = response.json()['data']
    url = client.base_url.rstrip('/').replace('https://', 'wss://', 1).replace('http://', 'ws://', 1)
    url += path + '/vncwebsocket?' + urlencode({'port': proxy['port'], 'vncticket': proxy['ticket']})
    ws = websocket.create_connection(url, timeout=15, cookie='; '.join(f'{k}={v}' for k, v in session.cookies.items()),
                                     header=[f'{k}: {v}' for k, v in session.headers.items() if k.lower() == 'authorization'],
                                     sslopt={'cert_reqs': ssl.CERT_REQUIRED if client.verify else ssl.CERT_NONE}, subprotocols=['binary'])
    buffer = bytearray()
    deadline = time.monotonic() + 20
    def read(size):
        if size > 64 * 1024 * 1024:
            raise RuntimeError('Console frame too large')
        while len(buffer) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Console capture timed out')
            ws.settimeout(remaining)
            chunk = ws.recv()
            if not isinstance(chunk, bytes) or not chunk:
                raise RuntimeError('Console disconnected')
            buffer.extend(chunk)
        value = bytes(buffer[:size]); del buffer[:size]
        return value
    try:
        version = read(12)
        if version != b'RFB 003.008\n':
            raise RuntimeError('Unsupported console protocol')
        ws.send_binary(version)
        security = read(read(1)[0])
        if 2 in security:
            ws.send_binary(b'\x02')
            challenge = read(16)
            key = bytes(int(f'{v:08b}'[::-1], 2) for v in proxy['ticket'].encode()[:8].ljust(8, b'\0'))
            encryptor = Cipher(algorithms.TripleDES(key * 3), modes.ECB()).encryptor()
            ws.send_binary(encryptor.update(challenge) + encryptor.finalize())
        elif 1 in security:
            ws.send_binary(b'\x01')
        else:
            raise RuntimeError('Console authentication unsupported')
        if read(4) != b'\0\0\0\0':
            raise RuntimeError('Console authentication failed')
        ws.send_binary(b'\x01')  # shared console; no keyboard or pointer input
        width, height = struct.unpack('!HH', read(4))
        if not width or not height or width * height > 16000000:
            raise RuntimeError('Console dimensions unsupported')
        read(16)
        read(struct.unpack('!I', read(4))[0])
        pixel_format = struct.pack('!BBBBHHHBBBxxx', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
        ws.send_binary(b'\0\0\0\0' + pixel_format)
        ws.send_binary(struct.pack('!BBHi', 2, 0, 1, 0))
        ws.send_binary(struct.pack('!BBHHHH', 3, 0, 0, 0, width, height))
        frame = Image.new('RGB', (width, height))
        while True:
            kind = read(1)[0]
            if kind == 2:
                continue
            if kind == 3:
                read(3); read(struct.unpack('!I', read(4))[0]); continue
            if kind != 0:
                raise RuntimeError('Unsupported console message')
            read(1)
            count = struct.unpack('!H', read(2))[0]
            for _ in range(count):
                x, y, w, h, encoding = struct.unpack('!HHHHi', read(12))
                if encoding != 0 or x + w > width or y + h > height:
                    raise RuntimeError('Unsupported console rectangle')
                pixels = read(w * h * 4)
                if w and h:
                    frame.paste(Image.frombytes('RGB', (w, h), pixels, 'raw', 'BGRX'), (x, y))
            if count:
                break
        frame.thumbnail((240, 150))
        output = io.BytesIO(); frame.save(output, format='JPEG', quality=70)
        return 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')
    finally:
        ws.close()
