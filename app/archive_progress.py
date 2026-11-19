"""Measured progress for archive operations without buffering large files."""

import io
import os
import time
import zipfile


PROGRESS_FIELDS = (
    'phase', 'step', 'total_steps', 'progress', 'phase_progress', 'current', 'message',
    'item_completed', 'item_total', 'bytes_done', 'bytes_total',
    'file_bytes_done', 'file_bytes_total',
    'archive_bytes',
)


class ArchiveProgress:
    def __init__(self, record, phases, report=None):
        self.record = record
        self.phases = phases
        self.report = report
        self.index = 0
        self.last_report = 0

    def stage(self, index, message, *, items=None, size=None):
        self.index = index
        self.last_report = 0
        self.record.update(phase=self.phases[index], step=index + 1, total_steps=len(self.phases),
                           phase_progress=None, current='', message=message,
                           item_completed=0, item_total=items, bytes_done=0 if size is not None else None,
                           bytes_total=size, file_bytes_done=None, file_bytes_total=None)
        self.update()

    def update(self, *, fraction=None, **fields):
        if self.record.get('cancel') and self.record.get('status') != 'finalizing':
            raise InterruptedError('Archive operation cancelled')
        self.record.update(fields)
        if fraction is None:
            size = self.record.get('bytes_total')
            items = self.record.get('item_total')
            if size:
                fraction = (self.record.get('bytes_done') or 0) / size
            elif items:
                fraction = (self.record.get('item_completed') or 0) / items
        if fraction is not None:
            fraction = max(0, min(1, fraction))
            self.record['phase_progress'] = round(fraction * 100, 1)
        value = 100 * (self.index + (fraction or 0)) / len(self.phases)
        self.record['progress'] = max(self.record.get('progress', 0), min(99, round(value, 1)))
        now = time.monotonic()
        if self.report and (now - self.last_report >= 0.15 or fraction == 1):
            self.report({key: self.record.get(key) for key in PROGRESS_FIELDS})
            self.last_report = now

    def copy(self, source, target, name, size):
        base = self.record.get('bytes_done') or 0
        copied = 0
        self.update(current=name, file_bytes_done=0, file_bytes_total=size)
        while chunk := source.read(1024 * 1024):
            target.write(chunk)
            copied += len(chunk)
            self.update(bytes_done=base + copied, file_bytes_done=copied)
        self.update(item_completed=(self.record.get('item_completed') or 0) + 1)

    def finish(self, message):
        self.record.update(progress=100, phase_progress=100, step=len(self.phases),
                           total_steps=len(self.phases), message=message, current='', status='completed')
        if self.report:
            self.report({key: self.record.get(key) for key in PROGRESS_FIELDS})


class ArchiveEntries:
    """Collect archive paths and small generated payloads before measuring ZIP work."""
    def __init__(self):
        self.entries = []

    def writestr(self, name, data):
        data = data.encode('utf-8') if isinstance(data, str) else data
        self.entries.append((name, data, None, len(data)))

    def write(self, path, arcname):
        self.entries.append((arcname, None, path, os.path.getsize(path)))

    def pack(self, destination, progress, stage):
        progress.stage(stage, 'Compressing ZIP archive', items=len(self.entries),
                       size=sum(entry[3] for entry in self.entries))
        try:
            with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for name, data, path, size in self.entries:
                    info = zipfile.ZipInfo.from_file(path, name) if path else zipfile.ZipInfo(name)
                    # Proxmox already compresses these disk archives. Store
                    # them verbatim instead of spending CPU recompressing GiB.
                    compressed_backup = name.startswith('backups/') and name.lower().endswith(('.zst', '.gz', '.lzo'))
                    info.compress_type = zipfile.ZIP_STORED if compressed_backup else zipfile.ZIP_DEFLATED
                    info.file_size = size
                    with (open(path, 'rb') if path else io.BytesIO(data)) as source:
                        with archive.open(info, 'w', force_zip64=True) as target:
                            progress.copy(source, target, name, size)
        except BaseException:
            if isinstance(destination, (str, bytes, os.PathLike)):
                try:
                    os.remove(destination)
                except FileNotFoundError:
                    pass
            raise
        progress.update(fraction=1, message='ZIP archive written')
