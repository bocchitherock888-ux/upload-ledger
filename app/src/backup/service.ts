import { sha256 } from "@noble/hashes/sha2.js";
import defaults from "../shared/config.defaults.json";
import type {
  ArchiveManifest,
  CallerBinding,
  Job,
  StoredChunk,
  StoredRecord,
} from "../shared/model";
import type { CommandPayloads, CommandType } from "../shared/protocol";
import { decode, digest, hex } from "../domain/rules";
import { database, state, usage, write, type Tx } from "../storage/db";
import { parseAndValidateManifest, sameImmutableRecord } from "./manifest";

const limits = defaults.backup;
const CHUNK = defaults.capture.rawChunkBytes;
const LEASE = limits.jobLeaseMs;
type ImportType = Extract<CommandType, `UI_IMPORT_${string}`>;
type Control = {
  id: string;
  kind: "import-control";
  jobId: string;
  vaultEpoch: number;
  caller: CallerBinding;
  status: "staging" | "validated" | "cancelled" | "failed";
  manifestPayloadId: string;
  manifestByteLength: number;
  archiveByteLength: number;
  nextChunkIndex: number;
  receivedBytes: number;
  reservedRemainingBytes: number;
  createdAt: string;
  updatedAt: string;
  leaseUntil: string;
  skippedCount: number;
  conflictCount: number;
};
type ImportObject = {
  id: string;
  kind: "import-object";
  jobId: string;
  sha256: string;
  payloadId: string;
  byteLength: number;
  sessionId: string;
  token: string;
  status: "receiving" | "complete";
  nextChunkIndex: number;
  receivedBytes: number;
};

const fail: (code: string) => never = (code) => {
  throw new Error(code);
};
const now = () => new Date().toISOString();
const lease = () => new Date(Date.now() + LEASE).toISOString();
const sameCaller = (a: CallerBinding, b: CallerBinding) =>
  a.kind === b.kind &&
  a.tabId === b.tabId &&
  a.documentId === b.documentId &&
  a.frameId === b.frameId &&
  a.origin === b.origin;
const importId = (jobId: string, sha: string) => `${jobId}:object:${sha}`;
const asControl = (value: unknown): Control => value as Control;
const asImportObject = (value: unknown): ImportObject => value as ImportObject;
function exact(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("E_BAD_MESSAGE");
  const record = value as Record<string, unknown>;
  const found = Object.keys(record);
  if (
    found.length !== names.length ||
    found.some((key) => !names.includes(key))
  )
    fail("E_BAD_MESSAGE");
  return record;
}
function positiveInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    fail("E_BAD_MESSAGE");
  return value as number;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    fail("E_BAD_MESSAGE");
  return value as string;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    fail("E_BAD_MESSAGE");
  return value as string;
}
async function writable(tx: Tx, vaultEpoch: number) {
  const runtime = await state(tx);
  if (runtime.clearing) fail("E_CLEARING");
  if (runtime.vaultEpoch !== vaultEpoch) fail("E_VAULT_EPOCH");
}
async function bound(
  tx: Tx,
  jobId: string,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  await writable(tx, vaultEpoch);
  const control = asControl(await tx.objectStore("imports").get(jobId));
  const job = (await tx.objectStore("jobs").get(jobId)) as
    (Job & { caller?: CallerBinding; createdAt: string }) | undefined;
  if (
    !control ||
    !job ||
    job.kind !== "import" ||
    job.vaultEpoch !== vaultEpoch ||
    !job.caller ||
    !sameCaller(control.caller, caller) ||
    !sameCaller(job.caller, caller)
  )
    fail("E_IMPORT_CANCELLED");
  if (Date.parse(control.leaseUntil) <= Date.now()) fail("E_IMPORT_CANCELLED");
  return { control: control!, job: job! };
}

async function begin(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const p = exact(payload, ["manifestByteLength", "archiveByteLength"]);
  const manifestByteLength = positiveInt(
      p.manifestByteLength,
      limits.maxManifestBytes,
    ),
    archiveByteLength = positiveInt(
      p.archiveByteLength,
      limits.maxArchiveUncompressedBytes,
    );
  if (archiveByteLength < manifestByteLength) fail("E_ARCHIVE_LIMIT");
  const jobId = crypto.randomUUID(),
    manifestPayloadId = crypto.randomUUID(),
    createdAt = now();
  await write(async (tx) => {
    await writable(tx, vaultEpoch);
    const current = await usage(tx);
    if (current.chargedBytes + archiveByteLength > current.budgetBytes)
      fail("E_BUDGET_EXCEEDED");
    const control: Control = {
      id: jobId,
      kind: "import-control",
      jobId,
      vaultEpoch,
      caller,
      status: "staging",
      manifestPayloadId,
      manifestByteLength,
      archiveByteLength,
      nextChunkIndex: 0,
      receivedBytes: 0,
      reservedRemainingBytes: archiveByteLength,
      createdAt,
      updatedAt: createdAt,
      leaseUntil: lease(),
      skippedCount: 0,
      conflictCount: 0,
    };
    const job: Job & { caller: CallerBinding; createdAt: string } = {
      vaultEpoch,
      jobId,
      kind: "import",
      status: "staging",
      leaseUntil: control.leaseUntil,
      objectRefs: [],
      stagedRecordIds: [],
      manifest: null,
      caller,
      createdAt,
    };
    await tx.objectStore("imports").add(control);
    await tx.objectStore("jobs").add(job);
  });
  return { jobId };
}

function chunkFields(payload: unknown, withJob = true) {
  const names = withJob
    ? [
        "jobId",
        "sessionId",
        "token",
        "index",
        "rawLength",
        "base64",
        "chunkSha256",
      ]
    : ["jobId", "index", "rawLength", "base64", "chunkSha256"];
  const p = exact(payload, names);
  id(p.jobId);
  if (withJob) {
    id(p.sessionId);
    if (
      typeof p.token !== "string" ||
      p.token.length < 1 ||
      p.token.length > 256
    )
      fail("E_BAD_MESSAGE");
  }
  const rawLength = positiveInt(p.rawLength, CHUNK),
    index = positiveInt(p.index);
  if (
    rawLength === 0 ||
    typeof p.base64 !== "string" ||
    p.base64.length > 4 * Math.ceil(CHUNK / 3)
  )
    fail("E_BAD_MESSAGE");
  const base64 = p.base64 as string;
  const bytes = decode(base64, rawLength);
  if (digest(bytes) !== sha(p.chunkSha256)) fail("E_CHUNK_HASH");
  return { p, bytes, index, rawLength };
}
const storedChunk = (
  payloadId: string,
  index: number,
  bytes: Uint8Array,
  rawLength: number,
  chunkSha256: string,
): StoredChunk => ({
  payloadId,
  index,
  bytes: bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer,
  rawLength,
  chunkSha256,
});

async function manifestChunk(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const { p, bytes, index, rawLength } = chunkFields(payload, false);
  const jobId = id(p.jobId);
  return write(async (tx) => {
    const { control, job } = await bound(tx, jobId, caller, vaultEpoch);
    if (
      control.status !== "staging" ||
      control.receivedBytes + rawLength > control.manifestByteLength
    )
      fail("E_ARCHIVE_LIMIT");
    if (index < control.nextChunkIndex) {
      const prior = await tx
        .objectStore("chunks")
        .get([control.manifestPayloadId, index]);
      if (
        !prior ||
        prior.rawLength !== rawLength ||
        prior.chunkSha256 !== p.chunkSha256
      )
        fail("E_CHUNK_CONFLICT");
      return {
        nextChunkIndex: control.nextChunkIndex,
        receivedBytes: control.receivedBytes,
      };
    }
    if (index !== control.nextChunkIndex) fail("E_CHUNK_ORDER");
    await tx
      .objectStore("chunks")
      .add(
        storedChunk(
          control.manifestPayloadId,
          index,
          bytes,
          rawLength,
          p.chunkSha256 as string,
        ),
      );
    control.nextChunkIndex++;
    control.receivedBytes += rawLength;
    control.reservedRemainingBytes -= rawLength;
    control.updatedAt = now();
    control.leaseUntil = lease();
    job.leaseUntil = control.leaseUntil;
    await tx.objectStore("imports").put(control);
    await tx.objectStore("jobs").put(job);
    return {
      nextChunkIndex: control.nextChunkIndex,
      receivedBytes: control.receivedBytes,
    };
  });
}

async function readPayload(payloadId: string, count: number, expected: number) {
  const db = await database();
  try {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (let i = 0; i < count; i++) {
      const row = await db.get("chunks", [payloadId, i]);
      if (!row) fail("E_ARCHIVE_FORMAT");
      const bytes = new Uint8Array(row.bytes);
      if (
        bytes.byteLength !== row.rawLength ||
        digest(bytes) !== row.chunkSha256
      )
        fail("E_ARCHIVE_HASH");
      length += bytes.byteLength;
      if (length > expected) fail("E_ARCHIVE_LIMIT");
      parts.push(bytes);
    }
    if (length !== expected) fail("E_ARCHIVE_FORMAT");
    const all = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.byteLength;
    }
    return all;
  } finally {
    db.close();
  }
}
async function hashPayload(payloadId: string, count: number, expected: number) {
  const hash = sha256.create();
  let length = 0;
  for (let i = 0; i < count; i++) {
    const db = await database();
    let row;
    try {
      row = await db.get("chunks", [payloadId, i]);
    } finally {
      db.close();
    }
    if (!row) fail("E_ARCHIVE_HASH");
    const bytes = new Uint8Array(row.bytes);
    if (bytes.byteLength !== row.rawLength || digest(bytes) !== row.chunkSha256)
      fail("E_ARCHIVE_HASH");
    length += bytes.byteLength;
    if (length > expected) fail("E_ARCHIVE_LIMIT");
    hash.update(bytes);
  }
  if (length !== expected) fail("E_ARCHIVE_HASH");
  return hex(hash.digest());
}

async function manifestFinish(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const p = exact(payload, ["jobId"]),
    jobId = id(p.jobId);
  let control: Control;
  await write(async (tx) => {
    ({ control } = await bound(tx, jobId, caller, vaultEpoch));
    if (control.receivedBytes !== control.manifestByteLength)
      fail("E_ARCHIVE_FORMAT");
  });
  const bytes = await readPayload(
    control!.manifestPayloadId,
    control!.nextChunkIndex,
    control!.manifestByteLength,
  );
  const manifest = parseAndValidateManifest(bytes);
  if (
    control!.manifestByteLength +
      manifest.objects.reduce((sum, item) => sum + item.byteLength, 0) !==
    control!.archiveByteLength
  )
    fail("E_ARCHIVE_LIMIT");
  return write(async (tx) => {
    const current = await bound(tx, jobId, caller, vaultEpoch);
    control = current.control;
    let skipped = 0,
      conflicts = 0;
    for (const archived of manifest.records) {
      const local = await tx.objectStore("records").get(archived.recordId);
      if (local) {
        if (sameImmutableRecord(local, archived)) skipped++;
        else conflicts++;
      }
    }
    control.skippedCount = skipped;
    control.conflictCount = conflicts;
    control.updatedAt = now();
    control.leaseUntil = lease();
    current.job.manifest = manifest;
    current.job.objectRefs = manifest.objects.map((object) => object.sha256);
    current.job.leaseUntil = control.leaseUntil;
    if (manifest.objects.length === 0) {
      control.status = "validated";
      current.job.status = "validated";
    }
    await tx.objectStore("imports").put(control);
    await tx.objectStore("jobs").put(current.job);
    return {
      recordCount: manifest.records.length,
      objectCount: manifest.objects.length,
      skippedCount: skipped,
      conflictCount: conflicts,
      status: control.status,
    };
  });
}

async function objectBegin(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const p = exact(payload, ["jobId", "sha256", "byteLength"]),
    jobId = id(p.jobId),
    digestValue = sha(p.sha256),
    byteLength = positiveInt(p.byteLength, limits.maxObjectBytes);
  return write(async (tx) => {
    const { control, job } = await bound(tx, jobId, caller, vaultEpoch);
    if (control.status !== "staging" || !job.manifest) fail("E_ARCHIVE_FORMAT");
    const declared = job.manifest.objects.find(
      (item) => item.sha256 === digestValue,
    );
    if (!declared || declared.byteLength !== byteLength)
      fail("E_ARCHIVE_REFERENCE");
    const existing = await tx
      .objectStore("imports")
      .get(importId(jobId, digestValue));
    if (existing) {
      const row = asImportObject(existing);
      return {
        sessionId: row.sessionId,
        token: row.token,
        nextChunkIndex: row.nextChunkIndex,
        receivedBytes: row.receivedBytes,
      };
    }
    const sessions = await tx.objectStore("sessions").getAll();
    const imports = await tx.objectStore("imports").getAll();
    const active =
      sessions.filter(
        (item) => item.status === "capturing" || item.status === "finalising",
      ).length +
      imports.filter(
        (item) =>
          (item as Record<string, unknown>).kind === "import-object" &&
          (item as Record<string, unknown>).status === "receiving",
      ).length;
    if (active >= defaults.capture.maxActiveFilesGlobal) fail("E_BUSY");
    const row: ImportObject = {
      id: importId(jobId, digestValue),
      kind: "import-object",
      jobId,
      sha256: digestValue,
      payloadId: crypto.randomUUID(),
      byteLength,
      sessionId: crypto.randomUUID(),
      token: btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", ""),
      status: "receiving",
      nextChunkIndex: 0,
      receivedBytes: 0,
    };
    control.leaseUntil = lease();
    job.leaseUntil = control.leaseUntil;
    await tx.objectStore("imports").add(row);
    await tx.objectStore("imports").put(control);
    await tx.objectStore("jobs").put(job);
    return {
      sessionId: row.sessionId,
      token: row.token,
      nextChunkIndex: 0,
      receivedBytes: 0,
    };
  });
}

async function objectChunk(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const { p, bytes, index, rawLength } = chunkFields(payload),
    jobId = id(p.jobId);
  return write(async (tx) => {
    const { control, job } = await bound(tx, jobId, caller, vaultEpoch);
    const rows = await tx.objectStore("imports").getAll();
    const row = rows
      .map(asImportObject)
      .find(
        (item) =>
          item.kind === "import-object" &&
          item.jobId === jobId &&
          item.sessionId === p.sessionId,
      );
    if (!row || row.token !== p.token || row.status !== "receiving")
      fail("E_SESSION_MISMATCH");
    if (row.receivedBytes + rawLength > row.byteLength) fail("E_ARCHIVE_LIMIT");
    if (index < row.nextChunkIndex) {
      const prior = await tx.objectStore("chunks").get([row.payloadId, index]);
      if (
        !prior ||
        prior.rawLength !== rawLength ||
        prior.chunkSha256 !== p.chunkSha256
      )
        fail("E_CHUNK_CONFLICT");
      return {
        nextChunkIndex: row.nextChunkIndex,
        receivedBytes: row.receivedBytes,
      };
    }
    if (index !== row.nextChunkIndex) fail("E_CHUNK_ORDER");
    await tx
      .objectStore("chunks")
      .add(
        storedChunk(
          row.payloadId,
          index,
          bytes,
          rawLength,
          p.chunkSha256 as string,
        ),
      );
    row.nextChunkIndex++;
    row.receivedBytes += rawLength;
    control.receivedBytes += rawLength;
    control.reservedRemainingBytes -= rawLength;
    if (control.reservedRemainingBytes < 0) fail("E_ARCHIVE_LIMIT");
    control.leaseUntil = lease();
    job.leaseUntil = control.leaseUntil;
    await tx.objectStore("imports").put(row);
    await tx.objectStore("imports").put(control);
    await tx.objectStore("jobs").put(job);
    return {
      nextChunkIndex: row.nextChunkIndex,
      receivedBytes: row.receivedBytes,
    };
  });
}

async function objectFinish(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const p = exact(payload, ["jobId", "sessionId", "token"]),
    jobId = id(p.jobId),
    sessionId = id(p.sessionId);
  if (typeof p.token !== "string" || p.token.length < 1 || p.token.length > 256)
    fail("E_BAD_MESSAGE");
  let row: ImportObject;
  await write(async (tx) => {
    await bound(tx, jobId, caller, vaultEpoch);
    const rows = await tx.objectStore("imports").getAll();
    const found = rows
      .map(asImportObject)
      .find(
        (item) =>
          item.kind === "import-object" &&
          item.jobId === jobId &&
          item.sessionId === sessionId,
      );
    if (!found || found.token !== p.token) fail("E_SESSION_MISMATCH");
    if (found.receivedBytes !== found.byteLength) fail("E_ARCHIVE_HASH");
    row = found;
  });
  if (
    (await hashPayload(
      row!.payloadId,
      row!.nextChunkIndex,
      row!.byteLength,
    )) !== row!.sha256
  )
    fail("E_ARCHIVE_HASH");
  return write(async (tx) => {
    const { control, job } = await bound(tx, jobId, caller, vaultEpoch);
    const current = asImportObject(
      await tx.objectStore("imports").get(row!.id),
    );
    if (!current || current.receivedBytes !== row!.receivedBytes)
      fail("E_SESSION_MISMATCH");
    current.status = "complete";
    await tx.objectStore("imports").put(current);
    const objects = (await tx.objectStore("imports").getAll())
      .map(asImportObject)
      .filter((item) => item.kind === "import-object" && item.jobId === jobId);
    if (
      job.manifest &&
      objects.length === job.manifest.objects.length &&
      objects.every((item) => item.status === "complete")
    ) {
      if (control.receivedBytes !== control.archiveByteLength)
        fail("E_ARCHIVE_LIMIT");
      control.status = "validated";
      job.status = "validated";
    }
    control.leaseUntil = lease();
    job.leaseUntil = control.leaseUntil;
    await tx.objectStore("imports").put(control);
    await tx.objectStore("jobs").put(job);
    return {
      recordCount: job.manifest?.records.length ?? 0,
      objectCount: job.manifest?.objects.length ?? 0,
      skippedCount: control.skippedCount,
      conflictCount: control.conflictCount,
      status: control.status,
    };
  });
}

async function publish(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const p = exact(payload, ["jobId"]),
    jobId = id(p.jobId);
  return write(async (tx) => {
    const { control, job } = await bound(tx, jobId, caller, vaultEpoch);
    if (
      control.status !== "validated" ||
      job.status !== "validated" ||
      !job.manifest
    )
      fail("E_ARCHIVE_FORMAT");
    if (control.conflictCount) fail("E_IMPORT_CONFLICT");
    const manifest = job.manifest!;
    const fresh: typeof manifest.records = [];
    let skipped = 0;
    for (const archived of manifest.records) {
      const local = await tx.objectStore("records").get(archived.recordId);
      if (local) {
        if (!sameImmutableRecord(local, archived)) fail("E_IMPORT_CONFLICT");
        skipped++;
      } else fresh.push(archived);
    }
    const refCounts = new Map<string, number>();
    for (const record of fresh)
      if (record.snapshot.objectSha256)
        refCounts.set(
          record.snapshot.objectSha256,
          (refCounts.get(record.snapshot.objectSha256) ?? 0) + 1,
        );
    const importedAt = now();
    const staged = (await tx.objectStore("imports").getAll())
      .map(asImportObject)
      .filter((item) => item.kind === "import-object" && item.jobId === jobId);
    const retained = new Set<string>();
    for (const [digestValue, count] of refCounts) {
      const descriptor = manifest.objects.find(
        (item) => item.sha256 === digestValue,
      )!;
      const existing = await tx.objectStore("objects").get(digestValue);
      if (existing) {
        if (
          existing.integrityState !== "verified" ||
          existing.byteLength !== descriptor.byteLength
        )
          fail("E_HASH_CONFLICT");
        existing.refCount += count;
        await tx.objectStore("objects").put(existing);
      } else {
        const stagedObject = staged.find(
          (item) => item.sha256 === digestValue && item.status === "complete",
        );
        if (!stagedObject) fail("E_ARCHIVE_REFERENCE");
        const ready = stagedObject!;
        retained.add(ready.payloadId);
        await tx.objectStore("objects").add({
          sha256: digestValue,
          byteLength: descriptor.byteLength,
          payloadId: ready.payloadId,
          chunkCount: ready.nextChunkIndex,
          refCount: count,
          createdAt: importedAt,
          integrityState: "verified",
        });
      }
    }
    for (const redundant of staged)
      if (!retained.has(redundant.payloadId))
        await tx.objectStore("gcQueue").put({
          payloadId: redundant.payloadId,
          byteLength: redundant.byteLength,
          createdAt: importedAt,
        });
    for (const archived of fresh) {
      const stored: StoredRecord = {
        ...archived,
        importedAt,
        importJobId: null,
      };
      await tx.objectStore("records").add(stored);
      for (const event of manifest.audit.filter(
        (item) => item.recordId === archived.recordId,
      )) {
        const prior = await tx.objectStore("audit").get(event.eventId);
        if (prior) fail("E_IMPORT_CONFLICT");
        await tx.objectStore("audit").add(event);
      }
      await tx.objectStore("audit").add({
        eventId: crypto.randomUUID(),
        recordId: archived.recordId,
        createdAt: importedAt,
        actor: "system",
        type: "imported",
        from: null,
        to: null,
        note: `archive:${manifest.archiveId}`,
      });
    }
    await tx.objectStore("gcQueue").put({
      payloadId: control.manifestPayloadId,
      byteLength: control.manifestByteLength,
      createdAt: importedAt,
    });
    job.status = "committed";
    job.stagedRecordIds = fresh.map((record) => record.recordId);
    job.leaseUntil = importedAt;
    await tx.objectStore("jobs").put(job);
    for (const row of staged) await tx.objectStore("imports").delete(row.id);
    await tx.objectStore("imports").delete(control.id);
    return {
      recordCount: fresh.length,
      objectCount: refCounts.size,
      skippedCount: skipped,
      conflictCount: 0,
    };
  });
}

async function cleanupPayload(payloadId: string) {
  const db = await database();
  try {
    while (true) {
      const tx = db.transaction("chunks", "readwrite");
      const rows = await tx.store.getAll(
        IDBKeyRange.bound([payloadId, 0], [payloadId, Number.MAX_SAFE_INTEGER]),
        defaults.storage.cleanupMaxChunksPerTick,
      );
      for (const row of rows) await tx.store.delete([row.payloadId, row.index]);
      await tx.done;
      if (rows.length < defaults.storage.cleanupMaxChunksPerTick) break;
    }
  } finally {
    db.close();
  }
}
async function cleanupJob(jobId: string) {
  let payloads: string[] = [];
  const db = await database();
  try {
    const rows = (await db.getAll("imports")).filter(
      (row) => (row as Record<string, unknown>).jobId === jobId,
    );
    payloads = rows.flatMap((row) => {
      const item = row as unknown as Control | ImportObject;
      return item.kind === "import-control"
        ? [item.manifestPayloadId]
        : [item.payloadId];
    });
  } finally {
    db.close();
  }
  for (const payloadId of new Set(payloads)) await cleanupPayload(payloadId);
  await write(async (tx) => {
    for (const row of await tx.objectStore("imports").getAll())
      if ((row as Record<string, unknown>).jobId === jobId)
        await tx
          .objectStore("imports")
          .delete((row as Record<string, unknown>).id as string);
    const job = await tx.objectStore("jobs").get(jobId);
    if (job?.kind === "import") await tx.objectStore("jobs").delete(jobId);
  });
}
async function abort(
  payload: unknown,
  caller: CallerBinding,
  vaultEpoch: number,
) {
  const p = exact(payload, ["jobId"]),
    jobId = id(p.jobId);
  await write(async (tx) => {
    const { control, job } = await bound(tx, jobId, caller, vaultEpoch);
    control.status = "cancelled";
    control.reservedRemainingBytes = 0;
    job.status = "cancelled";
    await tx.objectStore("imports").put(control);
    await tx.objectStore("jobs").put(job);
  });
  await cleanupJob(jobId);
}

export async function recoverImports() {
  const db = await database();
  let controls: Control[];
  try {
    controls = (await db.getAll("imports"))
      .filter(
        (row) => (row as Record<string, unknown>).kind === "import-control",
      )
      .map(asControl);
  } finally {
    db.close();
  }
  for (const control of controls)
    if (
      control.status === "cancelled" ||
      control.status === "failed" ||
      Date.parse(control.leaseUntil) <= Date.now()
    )
      await cleanupJob(control.jobId);
}

export async function handleImport<T extends ImportType>(
  type: T,
  payload: CommandPayloads[T],
  caller: CallerBinding,
  vaultEpoch: number,
): Promise<unknown> {
  if (caller.kind !== "ui") fail("E_UNAUTHORISED");
  switch (type) {
    case "UI_IMPORT_BEGIN":
      return begin(payload, caller, vaultEpoch);
    case "UI_IMPORT_MANIFEST_CHUNK":
      return manifestChunk(payload, caller, vaultEpoch);
    case "UI_IMPORT_MANIFEST_FINISH":
      return manifestFinish(payload, caller, vaultEpoch);
    case "UI_IMPORT_OBJECT_BEGIN":
      return objectBegin(payload, caller, vaultEpoch);
    case "UI_IMPORT_OBJECT_CHUNK":
      return objectChunk(payload, caller, vaultEpoch);
    case "UI_IMPORT_OBJECT_FINISH":
      return objectFinish(payload, caller, vaultEpoch);
    case "UI_IMPORT_PUBLISH":
      return publish(payload, caller, vaultEpoch);
    case "UI_IMPORT_ABORT":
      return abort(payload, caller, vaultEpoch);
    default:
      return fail("E_BAD_MESSAGE");
  }
}
