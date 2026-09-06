#!/usr/bin/env python3
"""Read-only reference validator for Upload Ledger v1 backup archives.

No files are extracted. This complements, rather than replaces, browser importer tests.
Full JSON Schema validation is enabled when the optional jsonschema package exists.
"""
from pathlib import Path
import argparse, hashlib, json, re, stat, sys, zipfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / 'contracts/config.defaults.json').read_text())
LIMITS = CONFIG['backup']
SHA = re.compile(r'^[0-9a-f]{64}$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')

class InvalidArchive(ValueError): pass

def require(condition, message):
    if not condition: raise InvalidArchive(message)

def unique_json(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON property')
        result[key] = value
    return result

def bad_constant(value):
    raise InvalidArchive('Non-finite JSON number')

def integer(value, maximum=9007199254740991):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum

def read_bounded(zf, info, limit):
    require(info.file_size <= limit, 'Declared entry size exceeds limit')
    chunks = []; length = 0
    with zf.open(info) as stream:
        while True:
            data = stream.read(min(262144, limit + 1 - length))
            if not data: break
            length += len(data); require(length <= limit, 'Actual entry size exceeds limit')
            chunks.append(data)
    require(length == info.file_size, 'ZIP length mismatch')
    return b''.join(chunks)

def check_url_page(page):
    require(isinstance(page, dict), 'Page context must be an object')
    require(page.get('locationMode') in ['origin_path', 'origin_only'], 'Invalid URL mode')
    parsed = []
    for field in ['origin', 'location']:
        value = page.get(field)
        require(isinstance(value, str) and len(value) <= 4096, 'Invalid page address')
        require(not any(ord(ch) < 32 for ch in value) and '\\' not in value, 'Unsafe page address')
        require('?' not in value and '#' not in value, 'URL contains query or fragment')
        part = urlsplit(value)
        require(part.scheme in ['http', 'https'] and bool(part.hostname), 'Unsupported page origin')
        require(part.username is None and part.password is None, 'URL contains credentials')
        try: _ = part.port
        except ValueError as exc: raise InvalidArchive('Invalid URL port') from exc
        parsed.append(part)
    a, b = parsed
    require(a.path == '' and not a.query and not a.fragment, 'Origin must exclude a path')
    def authority(x): return (x.scheme, x.hostname, x.port or (443 if x.scheme == 'https' else 80))
    require(authority(a) == authority(b), 'Page origin mismatch')
    if page['locationMode'] == 'origin_only': require(page['location'] == page['origin'], 'origin_only mismatch')

def validate(path: Path, require_schema: bool = False) -> dict:
    require(path.is_file(), 'Archive file missing')
    # ZIP parsing itself uses Python's zipfile. Browser ingestion has independent streaming limits.
    require(path.stat().st_size <= LIMITS['maxArchiveUncompressedBytes'] + 64 * 1024 * 1024, 'Archive file too large')
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        require(len(infos) <= LIMITS['maxObjectCount'] + 1, 'Too many ZIP entries')
        names = set(); declared_total = 0
        for info in infos:
            name = info.filename
            require(name not in names, 'Duplicate ZIP entry'); names.add(name)
            require(not info.is_dir() and not name.startswith('/') and '\\' not in name and '..' not in name.split('/'), 'Unsafe ZIP path')
            require(name == 'manifest.json' or re.fullmatch(r'objects/[0-9a-f]{64}\.bin', name), 'Unexpected ZIP path')
            require(not (info.flag_bits & 1), 'Encrypted ZIP is unsupported')
            mode = (info.external_attr >> 16) & 0xffff
            require(not stat.S_ISLNK(mode), 'Symbolic links are unsupported')
            require(info.compress_type in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED], 'Unsupported compression method')
            declared_total += info.file_size
            require(declared_total <= LIMITS['maxArchiveUncompressedBytes'], 'Declared total exceeds limit')
        require('manifest.json' in names, 'Missing manifest')
        raw = read_bounded(zf, zf.getinfo('manifest.json'), LIMITS['maxManifestBytes'])
        manifest = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_json, parse_constant=bad_constant)
        require(isinstance(manifest, dict), 'Manifest must be an object')
        keys = {'format', 'formatVersion', 'archiveId', 'createdAt', 'appVersion', 'schemaVersion', 'records', 'objects', 'audit'}
        require(set(manifest) == keys, 'Unexpected or missing manifest fields')
        require(manifest['format'] == 'upload-ledger-backup' and manifest['formatVersion'] == 1 and manifest['schemaVersion'] == 1, 'Unsupported format')
        schema_mode = 'basic-structural-only'
        try:
            import jsonschema
        except ImportError:
            require(not require_schema, 'jsonschema package required but unavailable')
        else:
            schema = json.loads((ROOT / 'contracts/archive-manifest.schema.json').read_text())
            jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(manifest)
            schema_mode = 'full-json-schema-plus-semantic-checks'
        for field, maximum in [('records', LIMITS['maxRecords']), ('objects', LIMITS['maxObjectCount']), ('audit', LIMITS['maxAuditEvents'])]:
            require(isinstance(manifest[field], list) and len(manifest[field]) <= maximum, 'Manifest collection limit')
        objects = {}
        for obj in manifest['objects']:
            require(isinstance(obj, dict) and set(obj) == {'sha256', 'byteLength', 'path'}, 'Invalid object descriptor')
            digest = obj['sha256']; size = obj['byteLength']
            require(isinstance(digest, str) and SHA.fullmatch(digest), 'Invalid SHA256')
            require(digest not in objects, 'Duplicate object descriptor')
            require(integer(size, LIMITS['maxObjectBytes']), 'Invalid object length')
            require(obj['path'] == f'objects/{digest}.bin', 'Object path mismatch')
            objects[digest] = obj
        require(names == {'manifest.json'} | {obj['path'] for obj in objects.values()}, 'ZIP and manifest objects differ')
        ids = set(); references = set()
        record_keys = {'recordId','batchId','observedAt','source','page','file','snapshot','submission','user','revision','importedAt'}
        for record in manifest['records']:
            require(isinstance(record, dict) and set(record) == record_keys, 'Invalid record fields')
            rid = record.get('recordId')
            require(isinstance(rid, str) and UUID.fullmatch(rid) and rid not in ids, 'Duplicate or invalid record ID'); ids.add(rid)
            require(record['source'] in ['standard_input', 'user_drop', 'manual_snapshot'], 'Invalid capture source')
            if record['page'] is not None: check_url_page(record['page'])
            else: require(record['source'] == 'manual_snapshot', 'Automatic record requires page context')
            require(isinstance(record['file'], dict) and integer(record['file'].get('byteLength')), 'Invalid file metadata')
            require(isinstance(record['snapshot'], dict), 'Invalid snapshot')
            snapshot = record['snapshot']; state = snapshot.get('state'); digest = snapshot.get('objectSha256')
            require(state in ['ready','metadata_only','interrupted','failed'], 'Non-exportable snapshot state')
            if state == 'ready':
                require(isinstance(digest, str) and digest in objects, 'Ready record lacks object')
                require(record['file']['byteLength'] == objects[digest]['byteLength'], 'Record/object length mismatch')
                require(snapshot.get('capturedAt') is not None and snapshot.get('errorCode') is None, 'Invalid ready metadata')
                references.add(digest)
            else: require(digest is None, 'Non-ready record has object')
        require(references == set(objects), 'Unreferenced object descriptor')
        event_ids = set()
        for event in manifest['audit']:
            require(isinstance(event, dict) and event.get('recordId') in ids, 'Orphan audit event')
            eid = event.get('eventId')
            require(isinstance(eid, str) and UUID.fullmatch(eid) and eid not in event_ids, 'Duplicate or invalid audit event ID'); event_ids.add(eid)
        actual_total = len(raw)
        for digest, obj in objects.items():
            info = zf.getinfo(obj['path'])
            require(info.file_size == obj['byteLength'], 'Declared object length mismatch')
            count = 0; hashed = hashlib.sha256()
            with zf.open(info) as stream:
                while True:
                    data = stream.read(262144)
                    if not data: break
                    count += len(data); actual_total += len(data)
                    require(count <= LIMITS['maxObjectBytes'] and count <= obj['byteLength'], 'Actual object exceeds length')
                    require(actual_total <= LIMITS['maxArchiveUncompressedBytes'], 'Actual archive output exceeds limit')
                    hashed.update(data)
            require(count == obj['byteLength'] and hashed.hexdigest() == digest, 'Object SHA256 or length mismatch')
    return {'valid': True, 'recordCount': len(ids), 'objectCount': len(objects), 'auditCount': len(event_ids), 'uncompressedBytes': actual_total, 'schemaValidation': schema_mode}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--require-jsonschema', action='store_true')
    args = parser.parse_args()
    try: result = validate(args.archive, args.require_jsonschema)
    except Exception as exc:
        print(json.dumps({'valid': False, 'error': str(exc), 'errorType': type(exc).__name__}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2)); return 0

if __name__ == '__main__': sys.exit(main())
