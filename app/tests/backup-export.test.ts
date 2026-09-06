import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/domain/rules";
import { database, initial, stores, write } from "../src/storage/db";
import {
  exportBackup,
  planBackup,
  validateBackupFile,
} from "../src/backup/client";
import type { ArchiveManifest, StoredRecord } from "../src/shared/model";

test("export streams a self-contained archive whose manifest, bytes and SHA roundtrip", async () => {
  const bytes = new TextEncoder().encode("roundtrip export bytes");
  const sha = digest(bytes),
    when = "2026-09-06T11:00:00.000Z";
  const archived = {
    recordId: "11111111-1111-4111-8111-111111111111",
    batchId: "22222222-2222-4222-8222-222222222222",
    observedAt: when,
    source: "manual_snapshot" as const,
    page: null,
    file: {
      name: "roundtrip.txt",
      byteLength: bytes.byteLength,
      declaredMime: "text/plain",
      lastModified: 0,
    },
    snapshot: {
      state: "ready" as const,
      objectSha256: sha,
      capturedAt: when,
      errorCode: null,
    },
    submission: { state: "unknown" as const, updatedAt: null },
    user: { label: null, note: "", tags: [], pinned: false },
    revision: 0,
    importedAt: null,
  };
  const manifest: ArchiveManifest = {
    format: "upload-ledger-backup",
    formatVersion: 1,
    archiveId: "33333333-3333-4333-8333-333333333333",
    createdAt: when,
    appVersion: "0.1.0",
    schemaVersion: 1,
    records: [archived],
    objects: [
      { sha256: sha, byteLength: bytes.byteLength, path: `objects/${sha}.bin` },
    ],
    audit: [],
  };
  const record: StoredRecord = { ...archived, importJobId: null };
  await write(async (tx) => {
    for (const name of stores) await tx.objectStore(name).clear();
    await tx.objectStore("meta").put({ ...initial }, "runtime");
    await tx.objectStore("records").add(record);
    await tx.objectStore("objects").add({
      sha256: sha,
      byteLength: bytes.byteLength,
      payloadId: "44444444-4444-4444-8444-444444444444",
      chunkCount: 1,
      refCount: 1,
      createdAt: when,
      integrityState: "verified",
    });
    await tx.objectStore("chunks").add({
      payloadId: "44444444-4444-4444-8444-444444444444",
      index: 0,
      bytes: bytes.buffer.slice(0),
      rawLength: bytes.byteLength,
      chunkSha256: sha,
    });
  });
  let heartbeats = 0;
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: async (request: any) => {
        if (request.type === "UI_PREPARE_EXPORT") {
          const jobId = "55555555-5555-4555-8555-555555555555";
          await write(async (tx) =>
            tx.objectStore("jobs").put({
              vaultEpoch: 0,
              jobId,
              kind: "export",
              status: "staging",
              leaseUntil: new Date(Date.now() + 60_000).toISOString(),
              objectRefs: [sha],
              stagedRecordIds: [],
              manifest,
              recordIds: [record.recordId],
              createdAt: when,
            }),
          );
          return {
            v: 1,
            requestId: request.requestId,
            ok: true,
            data: {
              jobId,
              recordCount: 1,
              objectCount: 1,
              totalBytes: bytes.byteLength,
            },
          };
        }
        if (request.type === "UI_HEARTBEAT_JOB") {
          heartbeats++;
          return { v: 1, requestId: request.requestId, ok: true, data: {} };
        }
        if (request.type === "UI_END_JOB")
          return { v: 1, requestId: request.requestId, ok: true, data: {} };
        throw new Error("unexpected command");
      },
    },
  };
  const result = await exportBackup([record.recordId], 0);
  assert.ok(result.blob);
  assert.ok(heartbeats >= 1);
  assert.match(result.fileName, /^upload-ledger-backup-2026-09-06-/);
  const validated = await validateBackupFile(
    new File([result.blob!], result.fileName),
  );
  assert.equal(validated.recordCount, 1);
  assert.equal(validated.manifest.objects[0].sha256, sha);
  await write(async (tx) => {
    const chunk = await tx
      .objectStore("chunks")
      .get(["44444444-4444-4444-8444-444444444444", 0]);
    chunk!.bytes = new Uint8Array([9, 9, 9]).buffer;
    await tx.objectStore("chunks").put(chunk!);
  });
  let aborted = false;
  const writable = new WritableStream<Uint8Array>({
    abort() {
      aborted = true;
    },
  });
  await assert.rejects(
    exportBackup([record.recordId], 0, { writable }),
    /E_INTEGRITY|E_ARCHIVE_HASH/,
  );
  assert.equal(aborted, true);
  const db = await database();
  assert.equal(await db.count("objects"), 1);
  db.close();
});

test("backup planning resolves selected records beyond page one and recharges shared objects in each part", async () => {
  const when = "2026-09-06T12:00:00.000Z",
    batchId = "99999999-9999-4999-8999-999999999999",
    fifty = 50 * 1024 * 1024;
  const ids: string[] = [];
  const make = (index: number, sha: string): StoredRecord => {
    const recordId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    ids.push(recordId);
    return {
      recordId,
      batchId,
      observedAt: when,
      source: "manual_snapshot",
      page: null,
      file: {
        name: `${index}.bin`,
        byteLength: fifty,
        declaredMime: "application/octet-stream",
        lastModified: 0,
      },
      snapshot: {
        state: "ready",
        objectSha256: sha,
        capturedAt: when,
        errorCode: null,
      },
      submission: { state: "unknown", updatedAt: null },
      user: { label: null, note: "", tags: [], pinned: false },
      revision: 0,
      importedAt: null,
      importJobId: null,
    };
  };
  const records = [
    make(1, "a".repeat(64)),
    make(2, "b".repeat(64)),
    make(3, "c".repeat(64)),
    make(4, "d".repeat(64)),
  ];
  for (let index = 5; index <= 2603; index++)
    records.push(make(index, "a".repeat(64)));
  await write(async (tx) => {
    for (const name of stores) await tx.objectStore(name).clear();
    await tx.objectStore("meta").put({ ...initial }, "runtime");
    for (const record of records) await tx.objectStore("records").add(record);
  });
  const plan = await planBackup(ids, 0);
  assert.equal(plan.excludedCount, 0);
  assert.equal(
    plan.parts.flatMap((part) => part.recordIds).length,
    records.length,
  );
  assert.ok(plan.parts.length >= 2);
  assert.ok(
    plan.parts.every((part) => part.estimatedBytes <= 200 * 1024 * 1024),
  );
  assert.ok(
    plan.parts[1].estimatedBytes > fifty,
    "a repeated object must be included again in the independent second part",
  );
});
