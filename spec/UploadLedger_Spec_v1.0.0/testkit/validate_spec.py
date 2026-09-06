#!/usr/bin/env python3
"""Validate specification consistency and synthetic fixtures, not the extension."""
from pathlib import Path
import hashlib, json, re, sys
from validate_archive import validate
ROOT = Path(__file__).resolve().parents[1]

def require(value, message):
    if not value: raise AssertionError(message)

def load(rel): return json.loads((ROOT / rel).read_text(encoding='utf-8'))

def main():
    checks = []
    for path in ROOT.rglob('*.json'): json.loads(path.read_text(encoding='utf-8'))
    checks.append('All JSON files parse')
    config = load('contracts/config.defaults.json'); manifest = load('contracts/manifest.reference.json')
    require(manifest['manifest_version'] == 3 and manifest['incognito'] == 'not_allowed', 'Manifest baseline mismatch')
    require(set(manifest['permissions']) == {'activeTab','scripting','unlimitedStorage','alarms'}, 'Unexpected baseline permissions')
    for forbidden in ['content_scripts','host_permissions','externally_connectable','web_accessible_resources']:
        require(forbidden not in manifest, f'Forbidden baseline manifest key: {forbidden}')
    require(config['capture']['rawChunkBytes'] * 4 // 3 + 8192 < config['capture']['maxWireMessageBytes'], 'Chunk envelope too large')
    require(config['capture']['maxFileBytes'] <= config['backup']['maxObjectBytes'], 'Backup file limit mismatch')
    require(config['privacy']['initialSiteAllowlist'] == [], 'Initial allowlist must be empty')
    checks.append('Manifest, message and storage defaults are consistent')
    reqs = load('contracts/requirements.json')['requirements']; tests = load('contracts/test-cases.json')['tests']
    rid = {x['id'] for x in reqs}; tid = {x['id'] for x in tests}
    require(len(rid) == len(reqs) == 36, 'Expected 36 unique requirements')
    require(len(tid) == len(tests) == 72, 'Expected 72 unique planned tests')
    for req in reqs: require(req['tests'] and set(req['tests']) <= tid, 'Missing requirement tests')
    for test in tests:
        require(set(test['requirements']) <= rid, 'Unknown requirement reference')
        require(test['status'] == 'not_run', 'Spec must not claim product tests executed')
    srcs = load('sources/sources.json'); sid = {x['id'] for x in srcs}
    for path in (ROOT / 'docs').glob('*.md'):
        text = path.read_text()
        for match in re.findall(r'\bREQ-\d{3}\b', text): require(match in rid, f'Unknown requirement in {path.name}')
        for match in re.findall(r'\bT\d{3}\b', text): require(match in tid, f'Unknown test in {path.name}')
        for match in re.findall(r'\bSRC-\d{2}\b', text): require(match in sid, f'Unknown source in {path.name}')
    checks.append('36 requirements, 72 planned tests and source references resolve')
    zh = load('contracts/messages.zh-CN.json'); en = load('contracts/messages.en-GB.json')
    require(set(zh) == set(en), 'Locale keys mismatch')
    codes = load('contracts/error-codes.json')
    require(len({x['code'] for x in codes}) == len(codes), 'Duplicate error code')
    for code in codes: require(code['messageKey'] in zh and code['messageKey'] in en, 'Missing translated error')
    checks.append('Locale keys and error mappings match')
    for item in load('contracts/hash-test-vectors.json'):
        raw = item['utf8'].encode(); require(len(raw) == item['byteLength'] and hashlib.sha256(raw).hexdigest() == item['sha256'], 'Hash vector mismatch')
    inventory = load('testkit/fixtures/fixtures-manifest.json')['fixtures']
    for item in inventory:
        target = ROOT / 'testkit/fixtures' / item['path']
        hashed = hashlib.sha256()
        with target.open('rb') as fh:
            for chunk in iter(lambda: fh.read(1024*1024), b''): hashed.update(chunk)
        require(target.stat().st_size == item['byteLength'] and hashed.hexdigest() == item['sha256'], f'Fixture mismatch: {item["path"]}')
    checks.append(f'{len(inventory)} synthetic fixtures and hash vectors verified')
    positive = validate(ROOT / 'testkit/fixtures/valid-backup.zip')
    require(positive['recordCount'] == 3 and positive['objectCount'] == 2, 'Unexpected valid archive counts')
    rejected = []
    for name in ['bad-checksum-backup.zip','bad-path-backup.zip','bad-duplicate-backup.zip']:
        try: validate(ROOT / 'testkit/fixtures' / name)
        except Exception: rejected.append(name)
        else: raise AssertionError(f'Invalid archive accepted: {name}')
    checks.append('Valid backup accepted; three malformed backup fixtures rejected')
    for path in ['AGENTS.md','START_AGENT_PROMPT.md','README_先读.md','docs/19_SOURCE_REGISTER.md','testkit/server.mjs','testkit/README.md','contracts/protocol.ts','contracts/model.ts']:
        require((ROOT/path).is_file(), f'Missing entry point: {path}')
    checks.append('Package entry points exist')
    result = {'valid': True, 'scope': 'specification-and-testkit-only', 'checks': checks, 'archiveSchemaValidation': positive['schemaValidation'], 'productTestsExecuted': 0, 'productTestsPlanned': len(tests)}
    print(json.dumps(result, ensure_ascii=False, indent=2)); return 0

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as exc:
        print(json.dumps({'valid': False, 'errorType': type(exc).__name__, 'error': str(exc)}, ensure_ascii=False)); sys.exit(1)
