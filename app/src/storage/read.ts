import { sha256 } from "@noble/hashes/sha2.js";
import { database, state, stores, usage } from "./db";
import { digest, fail, hex, safeName } from "../domain/rules";
import type {
  ArchiveManifest,
  ContentObject,
  RecordQuery,
  StoredRecord,
} from "../shared/model";

function visible(record: StoredRecord) {
  return record.importJobId === null;
}
function compare(a: StoredRecord, b: StoredRecord) {
  return (
    b.observedAt.localeCompare(a.observedAt) ||
    a.recordId.localeCompare(b.recordId)
  );
}
function normal(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}
function filterSignature(query: RecordQuery) {
  return JSON.stringify({
    text: query.text ? normal(query.text.trim()) : null,
    origins: query.origins ? [...query.origins].sort() : null,
    dateFrom: query.dateFrom ?? null,
    dateTo: query.dateTo ?? null,
    snapshotStates: query.snapshotStates
      ? [...query.snapshotStates].sort()
      : null,
    submissionStates: query.submissionStates
      ? [...query.submissionStates].sort()
      : null,
    tags: query.tags ? [...query.tags].map(normal).sort() : null,
    pinned: query.pinned ?? null,
  });
}
function encodeCursor(record: StoredRecord, signature: string) {
  return btoa(JSON.stringify([record.observedAt, record.recordId, signature]));
}
function decodeCursor(value: string | undefined, signature: string) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed.some((item) => typeof item !== "string") ||
      parsed[2] !== signature
    )
      fail("E_BAD_MESSAGE");
    return parsed as [string, string, string];
  } catch {
    return fail("E_BAD_MESSAGE");
  }
}
function matches(record: StoredRecord, query: RecordQuery) {
  if (
    query.origins?.length &&
    (!record.page || !query.origins.includes(record.page.origin))
  )
    return false;
  if (query.dateFrom && record.observedAt < query.dateFrom) return false;
  if (query.dateTo && record.observedAt > query.dateTo) return false;
  if (
    query.snapshotStates?.length &&
    !query.snapshotStates.includes(record.snapshot.state)
  )
    return false;
  if (
    query.submissionStates?.length &&
    !query.submissionStates.includes(record.submission.state)
  )
    return false;
  if (
    query.tags?.length &&
    !query.tags.some((tag) =>
      record.user.tags.some((value) => normal(value) === normal(tag)),
    )
  )
    return false;
  if (query.pinned !== undefined && record.user.pinned !== query.pinned)
    return false;
  if (query.text) {
    const needle = normal(query.text.trim());
    if (
      needle &&
      ![
        record.file.name,
        record.page?.title ?? "",
        record.user.label ?? "",
        record.user.note,
        ...record.user.tags,
      ].some((value) => normal(value).includes(needle))
    )
      return false;
  }
  return true;
}

export async function queryRecords(query: RecordQuery = {}) {
  const limit = Math.min(100, Math.max(1, query.limit ?? 100));
  const signature = filterSignature(query);
  const cursor = decodeCursor(query.cursor, signature);
  const db = await database();
  try {
    const runtime = await db.get("meta", "runtime");
    if (runtime?.clearing) return { records: [], nextCursor: null };
    let records = (await db.getAll("records"))
      .filter(visible)
      .filter((record) => matches(record, query))
      .sort(compare);
    if (cursor)
      records = records.filter(
        (record) =>
          record.observedAt < cursor[0] ||
          (record.observedAt === cursor[0] && record.recordId > cursor[1]),
      );
    const page = records.slice(0, limit);
    return {
      records: page,
      nextCursor:
        records.length > limit
          ? encodeCursor(page[page.length - 1], signature)
          : null,
    };
  } finally {
    db.close();
  }
}

export async function getRecord(id: string) {
  const db = await database();
  try {
    const [runtime, record] = await Promise.all([
      db.get("meta", "runtime"),
      db.get("records", id),
    ]);
    return runtime?.clearing || !record || !visible(record) ? null : record;
  } finally {
    db.close();
  }
}

export async function library(query: RecordQuery = {}) {
  const db = await database();
  try {
    const tx = db.transaction(stores, "readonly");
    const runtime = await state(tx);
    const [sites, measured] = await Promise.all([
      runtime.clearing ? Promise.resolve([]) : tx.objectStore("sites").getAll(),
      usage(tx),
    ]);
    await tx.done;
    const listed = await queryRecords(query);
    return { ...listed, sites, runtime, usage: measured };
  } finally {
    db.close();
  }
}

async function leasedObject(
  sha: string,
  jobId: string,
): Promise<ContentObject> {
  const db = await database();
  try {
    const tx = db.transaction(stores, "readonly");
    const runtime = await state(tx);
    if (runtime.clearing) fail("E_CLEARING");
    const job = await tx.objectStore("jobs").get(jobId);
    if (
      !job ||
      job.vaultEpoch !== runtime.vaultEpoch ||
      Date.parse(job.leaseUntil) <= Date.now() ||
      !["staging", "validated"].includes(job.status) ||
      !job.objectRefs.includes(sha)
    )
      fail("E_OBJECT_IN_USE");
    const object = await tx.objectStore("objects").get(sha);
    if (!object) fail("E_OBJECT_MISSING");
    if (object.integrityState !== "verified") fail("E_INTEGRITY");
    await tx.done;
    return object;
  } finally {
    db.close();
  }
}

export function getObject(sha: string, jobId: string) {
  return leasedObject(sha, jobId);
}

export async function* iterateObjectChunks(
  sha: string,
  jobId: string,
): AsyncIterable<Uint8Array> {
  const object = await leasedObject(sha, jobId);
  const hasher = sha256.create();
  let size = 0;
  for (let index = 0; index < object.chunkCount; index++) {
    await leasedObject(sha, jobId);
    const db = await database();
    let block;
    try {
      block = await db.get("chunks", [object.payloadId, index]);
    } finally {
      db.close();
    }
    if (!block) fail("E_OBJECT_MISSING");
    const bytes = new Uint8Array(block.bytes);
    if (
      bytes.byteLength !== block.rawLength ||
      digest(bytes) !== block.chunkSha256
    )
      fail("E_INTEGRITY");
    hasher.update(bytes);
    size += bytes.byteLength;
    yield bytes.slice();
  }
  await leasedObject(sha, jobId);
  if (size !== object.byteLength || hex(hasher.digest()) !== object.sha256)
    fail("E_INTEGRITY");
}

export async function getJobManifest(jobId: string): Promise<ArchiveManifest> {
  const db = await database();
  try {
    const tx = db.transaction(stores, "readonly");
    const runtime = await state(tx);
    if (runtime.clearing) fail("E_CLEARING");
    const job = await tx.objectStore("jobs").get(jobId);
    if (
      !job ||
      job.vaultEpoch !== runtime.vaultEpoch ||
      Date.parse(job.leaseUntil) <= Date.now() ||
      !["staging", "validated"].includes(job.status) ||
      !job.manifest
    )
      fail("E_OBJECT_IN_USE");
    await tx.done;
    return structuredClone(job.manifest);
  } finally {
    db.close();
  }
}

export async function original(recordId: string, jobId: string) {
  const record = await getRecord(recordId);
  if (
    !record ||
    record.snapshot.state !== "ready" ||
    !record.snapshot.objectSha256
  )
    fail("E_OBJECT_MISSING");
  const db = await database();
  try {
    const job = await db.get("jobs", jobId);
    if (!job?.recordIds?.includes(recordId)) fail("E_OBJECT_IN_USE");
  } finally {
    db.close();
  }
  const parts: ArrayBuffer[] = [];
  for await (const bytes of iterateObjectChunks(
    record.snapshot.objectSha256,
    jobId,
  )) {
    parts.push(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
  }
  return {
    blob: new Blob(parts, { type: "application/octet-stream" }),
    name: safeName(record.file.name),
  };
}
