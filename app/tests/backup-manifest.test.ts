import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseAndValidateManifest,
  parseStrictJSON,
  sameImmutableRecord,
  validateManifest,
} from "../src/backup/manifest";
import { validateBackupFile } from "../src/backup/client";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(
  here,
  "../../spec/UploadLedger_Spec_v1.0.0/testkit/fixtures",
);
const validator = resolve(
  here,
  "../../spec/UploadLedger_Spec_v1.0.0/testkit/validate_archive.py",
);

test("strict JSON rejects duplicate properties at every depth and non-finite syntax", () => {
  assert.throws(
    () => parseStrictJSON('{"records":[],"records":[]}'),
    /Duplicate JSON property/,
  );
  assert.throws(
    () => parseStrictJSON('{"x":{"a":1,"a":2}}'),
    /Duplicate JSON property/,
  );
  assert.throws(() => parseStrictJSON('{"x":NaN}'), /Invalid JSON value/);
  const prototype = parseStrictJSON(
    '{"__proto__":{"polluted":true},"format":"x"}',
  ) as Record<string, unknown>;
  assert.equal((prototype as any).polluted, undefined);
  assert.deepEqual(Object.keys(prototype), ["__proto__", "format"]);
  assert.throws(
    () => parseStrictJSON("[".repeat(65) + "0" + "]".repeat(65)),
    /E_ARCHIVE_LIMIT/,
  );
  assert.throws(
    () => parseStrictJSON("[" + "0,".repeat(100_000) + "0]"),
    /E_ARCHIVE_LIMIT/,
  );
});

test("manifest validator rejects unknown fields and unreferenced descriptors", async () => {
  const sample = JSON.parse(
    await readFile(resolve(fixtures, "sample-manifest.json"), "utf8"),
  );
  assert.equal(validateManifest(sample).records.length, 3);
  assert.throws(
    () => validateManifest({ ...sample, unknown: true }),
    /E_ARCHIVE_FORMAT/,
  );
  const dangling = structuredClone(sample);
  dangling.records = dangling.records.filter(
    (record: any) =>
      record.snapshot.objectSha256 !== dangling.objects[1].sha256,
  );
  assert.throws(() => validateManifest(dangling), /E_ARCHIVE_REFERENCE/);
  const duplicate = new TextEncoder().encode(
    (await readFile(resolve(fixtures, "sample-manifest.json"), "utf8")).replace(
      '"formatVersion": 1',
      '"formatVersion": 1,\n  "formatVersion": 1',
    ),
  );
  assert.throws(
    () => parseAndValidateManifest(duplicate),
    /Duplicate JSON property/,
  );
  const wrongPort = structuredClone(sample);
  wrongPort.records[0].page.location = "https://example.test:8443/apply";
  assert.throws(() => validateManifest(wrongPort), /Page origin mismatch/);
});

test("immutable record comparison is semantic across JSON property ordering", async () => {
  const sample = JSON.parse(
    await readFile(resolve(fixtures, "sample-manifest.json"), "utf8"),
  );
  const archived = validateManifest(sample).records[0];
  const local = {
    ...archived,
    file: {
      byteLength: archived.file.byteLength,
      name: archived.file.name,
      lastModified: archived.file.lastModified,
      declaredMime: archived.file.declaredMime,
    },
    snapshot: {
      objectSha256: archived.snapshot.objectSha256,
      state: archived.snapshot.state,
      errorCode: archived.snapshot.errorCode,
      capturedAt: archived.snapshot.capturedAt,
    },
    importJobId: null,
  };
  assert.equal(sameImmutableRecord(local, archived), true);
});

test("browser-independent ZIP validator accepts valid fixture and rejects path, duplicate and checksum fixtures", async () => {
  const load = async (name: string) => {
    const bytes = await readFile(resolve(fixtures, name));
    return new File([bytes], name, { type: "application/zip" });
  };
  const valid = await validateBackupFile(await load("valid-backup.zip"));
  assert.equal(valid.recordCount, 3);
  assert.equal(valid.objectCount, 2);
  for (const name of [
    "bad-path-backup.zip",
    "bad-duplicate-backup.zip",
    "bad-checksum-backup.zip",
  ])
    await assert.rejects(validateBackupFile(await load(name)), name);
});

test("reference Python validator independently agrees on the four canonical fixtures", () => {
  const valid = spawnSync(
    "python3",
    [validator, resolve(fixtures, "valid-backup.zip")],
    { encoding: "utf8" },
  );
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  for (const name of [
    "bad-path-backup.zip",
    "bad-duplicate-backup.zip",
    "bad-checksum-backup.zip",
  ]) {
    const result = spawnSync("python3", [validator, resolve(fixtures, name)], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, name);
  }
});
