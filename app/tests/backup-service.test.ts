import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { digest, encode } from "../src/domain/rules";
import { database, initial, stores, write } from "../src/storage/db";
import { handleImport, recoverImports } from "../src/backup/service";
import type { ArchiveManifest, CallerBinding } from "../src/shared/model";
import { validate } from "../src/shared/validation";

const caller: CallerBinding = {
  kind: "ui",
  tabId: null,
  documentId: "app-document",
  frameId: 0,
  origin: "chrome-extension://unit",
};
const call = (type: string, payload: any, who = caller): Promise<any> => {
  try {
    validate({
      v: 1,
      requestId: crypto.randomUUID(),
      vaultEpoch: 0,
      type,
      payload,
    });
  } catch {
    return Promise.reject(new Error("E_BAD_MESSAGE"));
  }
  return handleImport(type as any, payload, who, 0);
};
async function setup() {
  await write(async (tx) => {
    for (const name of stores) await tx.objectStore(name).clear();
    await tx.objectStore("meta").put({ ...initial }, "runtime");
  });
}
function material(name = "archive.txt") {
  const bytes = new TextEncoder().encode("durable backup bytes");
  const sha = digest(bytes);
  const observedAt = "2026-09-06T09:00:00.000Z";
  const manifest: ArchiveManifest = {
    format: "upload-ledger-backup",
    formatVersion: 1,
    archiveId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: observedAt,
    appVersion: "0.1.0",
    schemaVersion: 1,
    records: [
      {
        recordId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        observedAt,
        source: "manual_snapshot",
        page: null,
        file: {
          name,
          byteLength: bytes.byteLength,
          declaredMime: "text/plain",
          lastModified: 0,
        },
        snapshot: {
          state: "ready",
          objectSha256: sha,
          capturedAt: observedAt,
          errorCode: null,
        },
        submission: { state: "user_confirmed", updatedAt: observedAt },
        user: {
          label: null,
          note: "from backup",
          tags: ["test"],
          pinned: false,
        },
        revision: 1,
        importedAt: null,
      },
    ],
    objects: [
      { sha256: sha, byteLength: bytes.byteLength, path: `objects/${sha}.bin` },
    ],
    audit: [],
  };
  return { manifest, bytes, sha };
}
async function stage(manifest: ArchiveManifest, bytes: Uint8Array) {
  const raw = new TextEncoder().encode(JSON.stringify(manifest));
  const begun = await call("UI_IMPORT_BEGIN", {
    manifestByteLength: raw.byteLength,
    archiveByteLength: raw.byteLength + bytes.byteLength,
  });
  await call("UI_IMPORT_MANIFEST_CHUNK", {
    jobId: begun.jobId,
    index: 0,
    rawLength: raw.byteLength,
    base64: encode(raw),
    chunkSha256: digest(raw),
  });
  let status = await call("UI_IMPORT_MANIFEST_FINISH", { jobId: begun.jobId });
  for (const object of manifest.objects) {
    const started = await call("UI_IMPORT_OBJECT_BEGIN", {
      jobId: begun.jobId,
      sha256: object.sha256,
      byteLength: object.byteLength,
    });
    await call("UI_IMPORT_OBJECT_CHUNK", {
      jobId: begun.jobId,
      sessionId: started.sessionId,
      token: started.token,
      index: 0,
      rawLength: bytes.byteLength,
      base64: encode(bytes),
      chunkSha256: digest(bytes),
    });
    status = await call("UI_IMPORT_OBJECT_FINISH", {
      jobId: begun.jobId,
      sessionId: started.sessionId,
      token: started.token,
    });
  }
  return { jobId: begun.jobId, status };
}

test("validated staging stays invisible until atomic publication and preserves every byte hash", async () => {
  await setup();
  const { manifest, bytes, sha } = material();
  const staged = await stage(manifest, bytes);
  assert.equal(staged.status.status, "validated");
  const before = await database();
  assert.equal(await before.count("records"), 0);
  before.close();
  const published = await call("UI_IMPORT_PUBLISH", { jobId: staged.jobId });
  assert.equal(published.recordCount, 1);
  const db = await database();
  const record = await db.get("records", manifest.records[0].recordId),
    object = await db.get("objects", sha);
  assert.equal(record?.snapshot.objectSha256, sha);
  assert.equal(object?.byteLength, bytes.byteLength);
  const chunk = await db.get("chunks", [object!.payloadId, 0]);
  assert.deepEqual(new Uint8Array(chunk!.bytes), bytes);
  db.close();
});

test("reimport is idempotent and retains newer local user and submission state", async () => {
  await setup();
  const { manifest, bytes } = material();
  const first = await stage(manifest, bytes);
  await call("UI_IMPORT_PUBLISH", { jobId: first.jobId });
  await write(async (tx) => {
    const local = await tx
      .objectStore("records")
      .get(manifest.records[0].recordId);
    local!.user.note = "local note";
    local!.submission = {
      state: "user_reported_cancelled",
      updatedAt: "2026-09-06T10:00:00.000Z",
    };
    local!.revision = 9;
    await tx.objectStore("records").put(local!);
  });
  const second = await stage(manifest, bytes);
  assert.equal(second.status.skippedCount, 1);
  const result = await call("UI_IMPORT_PUBLISH", { jobId: second.jobId });
  assert.equal(result.recordCount, 0);
  assert.equal(result.skippedCount, 1);
  const db = await database();
  const local = await db.get("records", manifest.records[0].recordId);
  assert.equal(local?.user.note, "local note");
  assert.equal(local?.revision, 9);
  assert.equal(await db.count("records"), 1);
  db.close();
});

test("immutable record conflict blocks whole import and cancellation leaves old library intact", async () => {
  await setup();
  const original = material();
  const first = await stage(original.manifest, original.bytes);
  await call("UI_IMPORT_PUBLISH", { jobId: first.jobId });
  const conflict = material("changed-name.txt");
  const staged = await stage(conflict.manifest, conflict.bytes);
  assert.equal(staged.status.conflictCount, 1);
  await assert.rejects(
    call("UI_IMPORT_PUBLISH", { jobId: staged.jobId }),
    /E_IMPORT_CONFLICT/,
  );
  await call("UI_IMPORT_ABORT", { jobId: staged.jobId });
  const db = await database();
  assert.equal(
    (await db.get("records", original.manifest.records[0].recordId))?.file.name,
    "archive.txt",
  );
  assert.equal(await db.count("records"), 1);
  assert.equal(await db.count("objects"), 1);
  db.close();
});

test("publication rolls back records and object references after a late audit-key collision", async () => {
  await setup();
  const { manifest, bytes } = material();
  const event = {
    eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    recordId: manifest.records[0].recordId,
    createdAt: manifest.createdAt,
    actor: "system" as const,
    type: "snapshot_saved" as const,
    from: null,
    to: "ready",
    note: null,
  };
  manifest.audit = [event];
  const staged = await stage(manifest, bytes);
  await write(async (tx) => {
    await tx
      .objectStore("audit")
      .add({ ...event, recordId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
  });
  await assert.rejects(
    call("UI_IMPORT_PUBLISH", { jobId: staged.jobId }),
    /E_IMPORT_CONFLICT/,
  );
  const db = await database();
  assert.equal(await db.count("records"), 0);
  assert.equal(await db.count("objects"), 0);
  assert.ok(
    await db.get("imports", staged.jobId),
    "validated staging remains available for explicit cancellation",
  );
  db.close();
  await call("UI_IMPORT_ABORT", { jobId: staged.jobId });
});

test("caller binding and expired-job recovery clean only staged chunks", async () => {
  await setup();
  const original = material();
  const committed = await stage(original.manifest, original.bytes);
  await call("UI_IMPORT_PUBLISH", { jobId: committed.jobId });
  const baseline = await database();
  const committedChunks = await baseline.count("chunks");
  baseline.close();
  const raw = new TextEncoder().encode(JSON.stringify(original.manifest));
  const begun = await call("UI_IMPORT_BEGIN", {
    manifestByteLength: raw.byteLength,
    archiveByteLength: raw.byteLength + original.bytes.byteLength,
  });
  await assert.rejects(
    call(
      "UI_IMPORT_MANIFEST_CHUNK",
      {
        jobId: begun.jobId,
        index: 0,
        rawLength: raw.byteLength,
        base64: encode(raw),
        chunkSha256: digest(raw),
      },
      { ...caller, documentId: "foreign" },
    ),
    /E_IMPORT_CANCELLED/,
  );
  await write(async (tx) => {
    const control = await tx.objectStore("imports").get(begun.jobId);
    control!.leaseUntil = "2000-01-01T00:00:00.000Z";
    await tx.objectStore("imports").put(control!);
  });
  await assert.rejects(
    call("UI_IMPORT_MANIFEST_CHUNK", {
      jobId: begun.jobId,
      index: 0,
      rawLength: raw.byteLength,
      base64: encode(raw),
      chunkSha256: digest(raw),
    }),
    /E_IMPORT_CANCELLED/,
  );
  await recoverImports();
  const db = await database();
  assert.equal(await db.count("imports"), 0);
  assert.equal(await db.count("records"), 1);
  assert.equal(await db.count("objects"), 1);
  assert.equal(await db.count("chunks"), committedChunks);
  db.close();
});

test("manifest staging detects durable chunk corruption before schema validation", async () => {
  await setup();
  const { manifest, bytes } = material();
  const raw = new TextEncoder().encode(JSON.stringify(manifest));
  const begun = await call("UI_IMPORT_BEGIN", {
    manifestByteLength: raw.byteLength,
    archiveByteLength: raw.byteLength + bytes.byteLength,
  });
  await assert.rejects(
    call("UI_IMPORT_MANIFEST_CHUNK", {
      jobId: begun.jobId,
      index: 0,
      rawLength: 0,
      base64: "",
      chunkSha256: digest(new Uint8Array()),
    }),
    /E_BAD_MESSAGE/,
  );
  await call("UI_IMPORT_MANIFEST_CHUNK", {
    jobId: begun.jobId,
    index: 0,
    rawLength: raw.byteLength,
    base64: encode(raw),
    chunkSha256: digest(raw),
  });
  await write(async (tx) => {
    const control = await tx.objectStore("imports").get(begun.jobId);
    const chunk = await tx
      .objectStore("chunks")
      .get([control!.manifestPayloadId as string, 0]);
    const changed = new Uint8Array(chunk!.bytes);
    changed[0] ^= 1;
    chunk!.bytes = changed.buffer;
    await tx.objectStore("chunks").put(chunk!);
  });
  await assert.rejects(
    call("UI_IMPORT_MANIFEST_FINISH", { jobId: begun.jobId }),
    /E_ARCHIVE_HASH/,
  );
});
