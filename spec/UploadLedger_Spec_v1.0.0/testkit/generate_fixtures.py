#!/usr/bin/env python3
"""Rebuild deterministic synthetic fixtures. Large boundary files are opt-in."""
from pathlib import Path
import argparse, datetime, hashlib, json, struct, uuid, warnings, zipfile, zlib

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'fixtures'
NS = uuid.UUID('b9ef6aef-19fc-4ba9-90bc-6c557b87f2e6')

def uid(name: str) -> str:
    return str(uuid.uuid5(NS, name))

def save(rel: str, data: bytes) -> None:
    target = OUT / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

def png() -> bytes:
    def chunk(kind: bytes, content: bytes) -> bytes:
        return struct.pack('>I', len(content)) + kind + content + struct.pack('>I', zlib.crc32(kind + content) & 0xffffffff)
    size = 32
    raw = b''.join(b'\0' + bytes(v for x in range(size) for v in (x * 8, y * 8, 128)) for y in range(size))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

def write_zip(name: str, entries: list[tuple[str, bytes]]) -> None:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(OUT / name, 'w', compression=zipfile.ZIP_STORED) as zf:
            for path, data in entries:
                info = zipfile.ZipInfo(path, date_time=(2026, 9, 6, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100600 << 16
                zf.writestr(info, data)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--large', action='store_true', help='Create 50 MiB and 50 MiB + 1 byte boundary files.')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    v1 = b'Synthetic research proposal.\nVersion A.\nSample size: 120.\n'
    v2 = b'Synthetic research proposal.\nVersion B.\nSample size: 180.\n'
    files = {
        'v1/proposal.txt': v1, 'v2/proposal.txt': v2, 'proposal-copy.txt': v1,
        'empty.txt': b'', 'unicode-notes.txt': '虚构课程笔记\nRésumé / 語料 / café\n'.encode(),
        'binary.dat': bytes(range(256)) * 4, 'sample.png': png(),
        'active-content.html': b'<!doctype html><title>Inert preview fixture</title><script>document.documentElement.dataset.fixtureExecuted="true";</script><p>Synthetic test only.</p>',
        'active-content.svg': b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="this.setAttribute(\'data-fixture-executed\',\'true\')"><rect width="10" height="10"/></svg>',
        'excluded/.env': b'SYNTHETIC_TEST_VALUE=not-a-secret\n',
        'excluded/id_ed25519': b'SYNTHETIC NAME-EXCLUSION FIXTURE; NOT A KEY\n',
    }
    for rel, data in files.items(): save(rel, data)
    hashes = [hashlib.sha256(v).hexdigest() for v in [v1, v2]]
    records = []
    for n, (name, data, digest) in enumerate([('proposal.txt', v1, hashes[0]), ('proposal.txt', v2, hashes[1]), ('proposal-copy.txt', v1, hashes[0])], 1):
        at = f'2026-09-06T08:0{n}:00.000Z'
        records.append({
            'recordId': uid(f'record-{n}'), 'batchId': uid(f'batch-{n}'), 'observedAt': at,
            'source': 'standard_input',
            'page': {'origin': 'https://example.test', 'location': 'https://example.test/apply', 'locationMode': 'origin_path', 'title': 'Synthetic application page'},
            'file': {'name': name, 'byteLength': len(data), 'declaredMime': 'text/plain', 'lastModified': 1788681600000},
            'snapshot': {'state': 'ready', 'objectSha256': digest, 'capturedAt': at, 'errorCode': None},
            'submission': {'state': 'user_confirmed' if n == 1 else 'unknown', 'updatedAt': at if n == 1 else None},
            'user': {'label': None, 'note': 'Synthetic sample only.', 'tags': ['demo'], 'pinned': False},
            'revision': 1, 'importedAt': None,
        })
    audit = [{'eventId': uid(f'audit-{n}'), 'recordId': record['recordId'], 'createdAt': record['observedAt'], 'actor': 'system', 'type': 'snapshot_saved', 'from': 'finalising', 'to': 'ready', 'note': None} for n, record in enumerate(records, 1)]
    audit.append({'eventId': uid('audit-confirmed'), 'recordId': records[0]['recordId'], 'createdAt': records[0]['observedAt'], 'actor': 'user', 'type': 'submission_changed', 'from': 'unknown', 'to': 'user_confirmed', 'note': None})
    manifest = {'format': 'upload-ledger-backup', 'formatVersion': 1, 'archiveId': uid('archive'), 'createdAt': '2026-09-06T09:00:00.000Z', 'appVersion': '0.1.0', 'schemaVersion': 1,
        'records': records, 'objects': [{'sha256': digest, 'byteLength': len(data), 'path': f'objects/{digest}.bin'} for digest, data in zip(hashes, [v1, v2])], 'audit': audit}
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    entries = [('manifest.json', manifest_bytes)] + [(f'objects/{digest}.bin', data) for digest, data in zip(hashes, [v1, v2])]
    write_zip('valid-backup.zip', entries)
    damaged = list(entries)
    damaged[1] = (damaged[1][0], b'X' + damaged[1][1][1:])
    write_zip('bad-checksum-backup.zip', damaged)
    write_zip('bad-path-backup.zip', entries + [('../escape.txt', b'SYNTHETIC PATH TEST\n')])
    write_zip('bad-duplicate-backup.zip', entries + [('manifest.json', manifest_bytes)])
    save('sample-manifest.json', manifest_bytes)
    if args.large:
        block = bytes(range(256)) * 4096
        for rel, extra in [('large/exact-50MiB.bin', False), ('large/over-50MiB.bin', True)]:
            target = OUT / rel; target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('wb') as fh:
                for _ in range(50): fh.write(block)
                if extra: fh.write(b'X')
    inventory = []
    for target in sorted(OUT.rglob('*')):
        if not target.is_file() or target.name == 'fixtures-manifest.json': continue
        digest = hashlib.sha256()
        with target.open('rb') as fh:
            for block in iter(lambda: fh.read(1024 * 1024), b''): digest.update(block)
        inventory.append({'path': target.relative_to(OUT).as_posix(), 'byteLength': target.stat().st_size, 'sha256': digest.hexdigest(), 'synthetic': True})
    save('fixtures-manifest.json', (json.dumps({'fixtures': inventory, 'notice': 'All material is synthetic. Negative archives are intentionally invalid.'}, ensure_ascii=False, indent=2) + '\n').encode())
    print(f'Generated {len(inventory)} synthetic fixtures.')

if __name__ == '__main__': main()
