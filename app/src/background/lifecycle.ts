import { sha256 } from "@noble/hashes/sha2.js";
import defaults from "../shared/config.defaults.json";
import {
  assertWritable,
  database,
  initial,
  state,
  stores,
  usage,
  write,
  type InternalJob,
  type Tx,
} from "../storage/db";
import { digest, fail, hex } from "../domain/rules";
import { abortIn, sameCaller } from "./capture";
import type {
  ArchiveManifest,
  ArchiveRecord,
  CallerBinding,
  RecordQuery,
  StoredRecord,
  SubmissionState,
  UserFields,
} from "../shared/model";
import type { SettingsPatch, VersionedRecord } from "../shared/protocol";

const now = () => new Date().toISOString();
const leaseUntil = () =>
  new Date(Date.now() + defaults.backup.jobLeaseMs).toISOString();
const challenges = new Map<
  string,
  { value: string; epoch: number; expires: number }
>();
const callerKey = (caller: CallerBinding) =>
  JSON.stringify([
    caller.kind,
    caller.tabId,
    caller.documentId,
    caller.frameId,
    caller.origin,
  ]);

export async function setSettings(
  expectedRevision: number,
  patch: SettingsPatch,
  epoch: number | null,
) {
  return write(async (tx) => {
    const runtime = await assertWritable(tx, epoch, { allowPaused: true });
    if (runtime.settingsRevision !== expectedRevision) fail("E_CONFLICT");
    if (patch.budgetBytes !== undefined) {
      if (
        !Number.isSafeInteger(patch.budgetBytes) ||
        patch.budgetBytes < defaults.storage.minimumBudgetBytes ||
        patch.budgetBytes > defaults.storage.maximumBudgetBytes
      )
        fail("E_BAD_MESSAGE");
      runtime.budgetBytes = patch.budgetBytes;
    }
    if (patch.excludedFileNames !== undefined)
      runtime.excludedFileNames = [...patch.excludedFileNames];
    if (patch.locale !== undefined) runtime.locale = patch.locale;
    if (patch.theme !== undefined) runtime.theme = patch.theme;
    runtime.settingsRevision++;
    await tx.objectStore("meta").put(runtime, "runtime");
    return { runtime };
  });
}

export async function setUserFields(
  recordId: string,
  expectedRevision: number,
  fields: UserFields,
  epoch: number | null,
) {
  return write(async (tx) => {
    await assertWritable(tx, epoch, { allowPaused: true });
    const record = await tx.objectStore("records").get(recordId);
    if (
      !record ||
      record.importJobId !== null ||
      record.revision !== expectedRevision
    )
      fail("E_CONFLICT");
    const from = `revision:${record.revision}`;
    record.user = structuredClone(fields);
    record.revision++;
    await tx.objectStore("records").put(record);
    await tx.objectStore("audit").put({
      eventId: crypto.randomUUID(),
      recordId,
      createdAt: now(),
      actor: "user",
      type: "user_fields_changed",
      from,
      to: `revision:${record.revision}`,
      note: null,
    });
    return record;
  });
}

export async function setSubmission(
  records: VersionedRecord[],
  value: SubmissionState,
  note: string | null,
  epoch: number | null,
) {
  return write(async (tx) => {
    await assertWritable(tx, epoch, { allowPaused: true });
    const seen = new Set<string>();
    const selected: StoredRecord[] = [];
    for (const item of records) {
      if (seen.has(item.recordId)) fail("E_BAD_MESSAGE");
      seen.add(item.recordId);
      const record = await tx.objectStore("records").get(item.recordId);
      if (
        !record ||
        record.importJobId !== null ||
        record.revision !== item.expectedRevision
      )
        fail("E_CONFLICT");
      selected.push(record);
    }
    const updatedAt = now();
    for (const record of selected) {
      const from = record.submission.state;
      record.submission = { state: value, updatedAt };
      record.revision++;
      await tx.objectStore("records").put(record);
      await tx.objectStore("audit").put({
        eventId: crypto.randomUUID(),
        recordId: record.recordId,
        createdAt: updatedAt,
        actor: "user",
        type: "submission_changed",
        from,
        to: value,
        note,
      });
    }
    return { records: selected };
  });
}

function archiveRecord(record: StoredRecord): ArchiveRecord {
  const { importJobId: _private, ...publicRecord } = record;
  if (
    !["ready", "metadata_only", "interrupted", "failed"].includes(
      publicRecord.snapshot.state,
    )
  )
    fail("E_OBJECT_MISSING");
  return publicRecord as ArchiveRecord;
}

export async function prepareJob(
  kind: "preview" | "export",
  recordIds: string[],
  caller: CallerBinding,
  epoch: number | null,
) {
  return write(async (tx) => {
    const runtime = await assertWritable(tx, epoch, { allowPaused: true });
    if (!recordIds.length || new Set(recordIds).size !== recordIds.length)
      fail("E_BAD_MESSAGE");
    const records: StoredRecord[] = [];
    const objectRefs = new Set<string>();
    for (const id of recordIds) {
      const record = await tx.objectStore("records").get(id);
      if (
        !record ||
        record.importJobId !== null ||
        record.snapshot.state !== "ready" ||
        !record.snapshot.objectSha256
      )
        fail("E_OBJECT_MISSING");
      const object = await tx
        .objectStore("objects")
        .get(record.snapshot.objectSha256);
      if (
        !object ||
        object.integrityState !== "verified" ||
        object.byteLength !== record.file.byteLength
      )
        fail("E_INTEGRITY");
      records.push(record);
      objectRefs.add(object.sha256);
    }
    const objects = await Promise.all(
      [...objectRefs].map((shaValue) =>
        tx.objectStore("objects").get(shaValue),
      ),
    );
    const selected = new Set(recordIds);
    const audit = (await tx.objectStore("audit").getAll()).filter((event) =>
      selected.has(event.recordId),
    );
    const manifest: ArchiveManifest = {
      format: "upload-ledger-backup",
      formatVersion: 1,
      archiveId: crypto.randomUUID(),
      createdAt: now(),
      appVersion:
        typeof chrome !== "undefined" && chrome.runtime?.getManifest
          ? chrome.runtime.getManifest().version
          : "test",
      schemaVersion: 1,
      records: records.map(archiveRecord),
      objects: objects.map((object) => {
        if (!object) fail("E_OBJECT_MISSING");
        return {
          sha256: object.sha256,
          byteLength: object.byteLength,
          path: `objects/${object.sha256}.bin`,
        };
      }),
      audit,
    };
    const job: InternalJob = {
      vaultEpoch: runtime.vaultEpoch,
      jobId: crypto.randomUUID(),
      kind,
      status: "validated",
      leaseUntil: leaseUntil(),
      objectRefs: [...objectRefs],
      stagedRecordIds: [],
      manifest,
      caller,
      recordIds: [...recordIds],
      createdAt: now(),
    };
    await tx.objectStore("jobs").put(job);
    return {
      jobId: job.jobId,
      recordCount: records.length,
      objectCount: objectRefs.size,
      totalBytes: objects.reduce(
        (total, object) => total + (object?.byteLength ?? 0),
        0,
      ),
    };
  });
}

export async function heartbeatJob(
  jobId: string,
  caller: CallerBinding,
  epoch: number | null,
) {
  return write(async (tx) => {
    const runtime = await assertWritable(tx, epoch, { allowPaused: true });
    const job = await tx.objectStore("jobs").get(jobId);
    if (
      !job ||
      job.vaultEpoch !== runtime.vaultEpoch ||
      !job.caller ||
      !sameCaller(job.caller, caller) ||
      Date.parse(job.leaseUntil) <= Date.now() ||
      !["staging", "validated"].includes(job.status)
    )
      fail("E_OBJECT_IN_USE");
    job.leaseUntil = leaseUntil();
    await tx.objectStore("jobs").put(job);
    return {};
  });
}

export async function endJob(
  jobId: string,
  outcome: "completed" | "cancelled" | "failed",
  caller: CallerBinding,
  epoch: number | null,
) {
  return write(async (tx) => {
    const runtime = await assertWritable(tx, epoch, { allowPaused: true });
    const job = await tx.objectStore("jobs").get(jobId);
    if (
      !job ||
      job.vaultEpoch !== runtime.vaultEpoch ||
      (job.caller && !sameCaller(job.caller, caller))
    )
      fail("E_OBJECT_IN_USE");
    job.status = outcome === "completed" ? "committed" : outcome;
    job.leaseUntil = now();
    await tx.objectStore("jobs").put(job);
    return {};
  });
}

export async function deleteRecords(
  records: VersionedRecord[],
  epoch: number | null,
) {
  return write(async (tx) => {
    await assertWritable(tx, epoch, { allowPaused: true });
    const seen = new Set<string>();
    const selected: StoredRecord[] = [];
    for (const item of records) {
      if (seen.has(item.recordId)) fail("E_BAD_MESSAGE");
      seen.add(item.recordId);
      const record = await tx.objectStore("records").get(item.recordId);
      if (
        !record ||
        record.importJobId !== null ||
        record.revision !== item.expectedRevision
      )
        fail("E_CONFLICT");
      if (["capturing", "finalising"].includes(record.snapshot.state))
        fail("E_BUSY");
      selected.push(record);
    }
    const objectCounts = new Map<string, number>();
    for (const record of selected)
      if (record.snapshot.objectSha256) {
        objectCounts.set(
          record.snapshot.objectSha256,
          (objectCounts.get(record.snapshot.objectSha256) ?? 0) + 1,
        );
      }
    const leased = (await tx.objectStore("jobs").getAll()).filter(
      (job) =>
        Date.parse(job.leaseUntil) > Date.now() &&
        ["staging", "validated"].includes(job.status),
    );
    for (const shaValue of objectCounts.keys())
      if (leased.some((job) => job.objectRefs.includes(shaValue)))
        fail("E_OBJECT_IN_USE");
    const audit = await tx.objectStore("audit").getAll();
    let pendingGcBytes = 0;
    for (const [shaValue, decrement] of objectCounts) {
      const object = await tx.objectStore("objects").get(shaValue);
      if (!object || object.refCount < decrement) fail("E_INTEGRITY");
      object.refCount -= decrement;
      if (object.refCount === 0) {
        await tx.objectStore("objects").delete(shaValue);
        await tx.objectStore("gcQueue").put({
          payloadId: object.payloadId,
          byteLength: object.byteLength,
          createdAt: now(),
        });
        pendingGcBytes += object.byteLength;
      } else await tx.objectStore("objects").put(object);
    }
    for (const record of selected) {
      await tx.objectStore("records").delete(record.recordId);
      for (const event of audit)
        if (event.recordId === record.recordId)
          await tx.objectStore("audit").delete(event.eventId);
    }
    return {
      count: selected.length,
      releasedBytes: pendingGcBytes,
      pendingGcBytes,
    };
  });
}

export async function runGc(
  maxChunks = defaults.storage.cleanupMaxChunksPerTick,
) {
  if (maxChunks < 1) return { deletedChunks: 0 };
  return write(async (tx) => {
    const queues = (await tx.objectStore("gcQueue").getAll()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    let deletedChunks = 0;
    for (const queue of queues) {
      const range = IDBKeyRange.bound(
        [queue.payloadId, 0],
        [queue.payloadId, Number.MAX_SAFE_INTEGER],
      );
      const keys = await tx
        .objectStore("chunks")
        .getAllKeys(range, maxChunks - deletedChunks);
      for (const key of keys) {
        await tx.objectStore("chunks").delete(key);
        deletedChunks++;
      }
      if ((await tx.objectStore("chunks").count(range)) === 0)
        await tx.objectStore("gcQueue").delete(queue.payloadId);
      if (deletedChunks >= maxChunks) break;
    }
    return { deletedChunks };
  });
}

export async function expireJobs() {
  return write(async (tx) => {
    const jobs = await tx.objectStore("jobs").getAll();
    let expired = 0;
    for (const job of jobs)
      if (job.kind !== "import" && Date.parse(job.leaseUntil) <= Date.now()) {
        await tx.objectStore("jobs").delete(job.jobId);
        expired++;
      }
    return { expired };
  });
}

export function requestClearChallenge(
  caller: CallerBinding,
  epoch: number | null,
) {
  if (epoch === null) fail("E_VAULT_EPOCH");
  const value = Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const expires = Date.now() + 60_000;
  challenges.set(callerKey(caller), { value, epoch, expires });
  return { challenge: value, expiresAt: new Date(expires).toISOString() };
}

export async function clearAll(
  challenge: string,
  caller: CallerBinding,
  epoch: number | null,
  permissionPatterns: string[] = [],
) {
  const key = callerKey(caller);
  const expected = challenges.get(key);
  challenges.delete(key);
  if (
    !expected ||
    expected.value !== challenge ||
    expected.epoch !== epoch ||
    expected.expires < Date.now()
  )
    fail("E_UNAUTHORISED");
  const nextEpoch = await write(async (tx) => {
    const runtime = await assertWritable(tx, epoch, { allowPaused: true });
    const activeJobs = (await tx.objectStore("jobs").getAll()).some(
      (job) =>
        job.kind !== "import" &&
        Date.parse(job.leaseUntil) > Date.now() &&
        ["staging", "validated"].includes(job.status),
    );
    if (activeJobs) fail("E_OBJECT_IN_USE");
    runtime.vaultEpoch++;
    runtime.globalPolicyEpoch++;
    runtime.paused = true;
    runtime.clearing = true;
    runtime.pendingPermissionPatterns = [...new Set(permissionPatterns)];
    await tx.objectStore("meta").put(runtime, "runtime");
    return runtime.vaultEpoch;
  });
  await continueClear();
  return { vaultEpoch: nextEpoch };
}

export async function continueClear() {
  const db = await database();
  const persisted = await db.get("meta", "runtime");
  db.close();
  if (!persisted?.clearing) return;
  await write(async (tx) => {
    for (const name of stores)
      if (name !== "meta") await tx.objectStore(name).clear();
  });
  await write(async (tx) => {
    const runtime = await state(tx);
    await tx.objectStore("meta").put(
      {
        ...initial,
        vaultEpoch: runtime.vaultEpoch,
        globalPolicyEpoch: runtime.globalPolicyEpoch,
        paused: true,
        clearing: false,
        settingsRevision: runtime.settingsRevision + 1,
        pendingPermissionPatterns: [
          ...(runtime.pendingPermissionPatterns ?? []),
        ],
      },
      "runtime",
    );
  });
}

export async function permissionCleanupComplete(patterns: string[]) {
  await write(async (tx) => {
    const runtime = await state(tx);
    const removed = new Set(patterns);
    runtime.pendingPermissionPatterns = (
      runtime.pendingPermissionPatterns ?? []
    ).filter((value) => !removed.has(value));
    await tx.objectStore("meta").put(runtime, "runtime");
  });
}

async function objectIsValid(record: StoredRecord) {
  if (!record.snapshot.objectSha256) return false;
  const db = await database();
  try {
    const object = await db.get("objects", record.snapshot.objectSha256);
    if (!object) return false;
    const hasher = sha256.create();
    let size = 0;
    for (let index = 0; index < object.chunkCount; index++) {
      const block = await db.get("chunks", [object.payloadId, index]);
      if (!block) return false;
      const bytes = new Uint8Array(block.bytes);
      if (
        bytes.length !== block.rawLength ||
        digest(bytes) !== block.chunkSha256
      )
        return false;
      hasher.update(bytes);
      size += bytes.length;
    }
    return size === object.byteLength && hex(hasher.digest()) === object.sha256;
  } finally {
    db.close();
  }
}

export async function markObjectCorrupt(
  recordId: string,
  epoch: number | null,
) {
  const db = await database();
  const record = await db.get("records", recordId);
  db.close();
  if (!record || record.importJobId !== null || !record.snapshot.objectSha256)
    fail("E_OBJECT_MISSING");
  if (await objectIsValid(record)) return { marked: 0 };
  return write(async (tx) => {
    await assertWritable(tx, epoch, { allowPaused: true });
    const shaValue = record.snapshot.objectSha256!;
    const object = await tx.objectStore("objects").get(shaValue);
    if (object) {
      object.integrityState = "corrupt";
      await tx.objectStore("objects").put(object);
    }
    let marked = 0;
    for (const affected of await tx.objectStore("records").getAll())
      if (affected.snapshot.objectSha256 === shaValue) {
        const from = affected.snapshot.state;
        affected.snapshot.state = "corrupt";
        affected.snapshot.errorCode = "E_INTEGRITY";
        affected.revision++;
        await tx.objectStore("records").put(affected);
        await tx.objectStore("audit").put({
          eventId: crypto.randomUUID(),
          recordId: affected.recordId,
          createdAt: now(),
          actor: "system",
          type: "integrity_failed",
          from,
          to: "corrupt",
          note: null,
        });
        marked++;
      }
    return { marked };
  });
}

export async function diagnostics() {
  const db = await database();
  try {
    const tx = db.transaction(stores, "readonly");
    const runtime = await state(tx);
    const [measured, records, objects, sessions, jobs, gcQueue] =
      await Promise.all([
        usage(tx),
        tx.objectStore("records").count(),
        tx.objectStore("objects").count(),
        tx.objectStore("sessions").count(),
        tx.objectStore("jobs").count(),
        tx.objectStore("gcQueue").count(),
      ]);
    await tx.done;
    return {
      databaseVersion: 2,
      protocolVersion: 1,
      counts: { records, objects, sessions, jobs, gcQueue },
      usage: measured,
      runtime: {
        vaultEpoch: runtime.vaultEpoch,
        globalPolicyEpoch: runtime.globalPolicyEpoch,
        paused: runtime.paused,
        clearing: runtime.clearing,
        settingsRevision: runtime.settingsRevision,
      },
    };
  } finally {
    db.close();
  }
}

export async function abortAllAutomatic(tx: Tx, code: string, origin?: string) {
  for (const session of await tx.objectStore("sessions").getAll()) {
    if (
      session.caller.kind === "capture" &&
      (!origin || session.caller.origin === origin)
    )
      await abortIn(tx, session, code);
  }
}
