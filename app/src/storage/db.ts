import { openDB, type DBSchema, type IDBPTransaction } from "idb";
import defaults from "../shared/config.defaults.json";
import type {
  AuditEvent,
  CallerBinding,
  CaptureSession,
  ContentObject,
  Job,
  SitePolicy,
  StoredChunk,
  StoredRecord,
} from "../shared/model";
import type { FileAcceptance } from "../shared/protocol";

export interface State {
  vaultEpoch: number;
  globalPolicyEpoch: number;
  paused: boolean;
  clearing: boolean;
  settingsRevision: number;
  budgetBytes: number;
  excludedFileNames: string[];
  locale: "zh-CN" | "en-GB";
  theme: "system" | "light" | "dark";
  onboardingComplete?: boolean;
  pendingPermissionPatterns?: string[];
  nextCaptureSequence: number;
}
export interface BatchRow {
  key: string;
  batchId: string;
  batchEventId: string;
  documentId: string;
  sessionIds: string[];
  clientFileIds: string[];
  createdAt: string;
  acceptances?: FileAcceptance[];
  sessionId?: string;
  clientFileId?: string;
}
export interface InternalJob extends Job {
  caller?: CallerBinding;
  recordIds?: string[];
  createdAt: string;
}
export interface InternalCaptureSession extends CaptureSession {
  admissionSequence?: number;
}
export interface ImportRow extends Record<string, unknown> {
  id: string;
}
export interface GcRow {
  payloadId: string;
  byteLength: number;
  createdAt: string;
}
export interface Database extends DBSchema {
  records: { key: string; value: StoredRecord };
  objects: { key: string; value: ContentObject };
  chunks: {
    key: [string, number];
    value: StoredChunk;
    indexes: { rawLength: number };
  };
  sessions: { key: string; value: InternalCaptureSession };
  sites: { key: string; value: SitePolicy };
  meta: { key: string; value: State };
  batches: { key: string; value: BatchRow };
  audit: { key: string; value: AuditEvent };
  jobs: { key: string; value: InternalJob };
  imports: { key: string; value: ImportRow };
  gcQueue: { key: string; value: GcRow };
}
export const stores = [
  "records",
  "objects",
  "chunks",
  "sessions",
  "sites",
  "meta",
  "batches",
  "audit",
  "jobs",
  "imports",
  "gcQueue",
] as const;
export type Tx = IDBPTransaction<Database, typeof stores, "readwrite">;
export type ReadTx = IDBPTransaction<Database, typeof stores, "readonly">;
export const initial: State = {
  vaultEpoch: 0,
  globalPolicyEpoch: 0,
  paused: false,
  clearing: false,
  settingsRevision: 0,
  budgetBytes: defaults.storage.defaultBudgetBytes,
  excludedFileNames: [...defaults.excludedFileNames],
  locale: "zh-CN",
  theme: "system",
  onboardingComplete: false,
  pendingPermissionPatterns: [],
  nextCaptureSequence: 0,
};
export function database() {
  return openDB<Database>("upload-ledger", 2, {
    upgrade(db, _oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains("records"))
        db.createObjectStore("records", { keyPath: "recordId" });
      if (!db.objectStoreNames.contains("objects"))
        db.createObjectStore("objects", { keyPath: "sha256" });
      const chunks = !db.objectStoreNames.contains("chunks")
        ? db.createObjectStore("chunks", { keyPath: ["payloadId", "index"] })
        : transaction.objectStore("chunks");
      if (!chunks.indexNames.contains("rawLength"))
        chunks.createIndex("rawLength", "rawLength");
      if (!db.objectStoreNames.contains("sessions"))
        db.createObjectStore("sessions", { keyPath: "sessionId" });
      if (!db.objectStoreNames.contains("sites"))
        db.createObjectStore("sites", { keyPath: "exactOrigin" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("batches"))
        db.createObjectStore("batches", { keyPath: "key" });
      if (!db.objectStoreNames.contains("audit"))
        db.createObjectStore("audit", { keyPath: "eventId" });
      if (!db.objectStoreNames.contains("jobs"))
        db.createObjectStore("jobs", { keyPath: "jobId" });
      if (!db.objectStoreNames.contains("imports"))
        db.createObjectStore("imports", { keyPath: "id" });
      if (!db.objectStoreNames.contains("gcQueue"))
        db.createObjectStore("gcQueue", { keyPath: "payloadId" });
    },
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase).close();
    },
  });
}
export async function write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await database();
  const tx = db.transaction(stores, "readwrite");
  try {
    const result = await fn(tx);
    await tx.done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* already inactive */
    }
    await tx.done.catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}
export async function state(tx: Tx | ReadTx): Promise<State> {
  const saved = await tx.objectStore("meta").get("runtime");
  return {
    ...initial,
    ...(saved ?? {}),
    excludedFileNames: Array.isArray(saved?.excludedFileNames)
      ? [...saved.excludedFileNames]
      : [...initial.excludedFileNames],
    pendingPermissionPatterns: Array.isArray(saved?.pendingPermissionPatterns)
      ? [...saved.pendingPermissionPatterns]
      : [],
  };
}
export async function assertWritable(
  tx: Tx,
  vaultEpoch: number | null,
  options: { allowPaused?: boolean } = {},
) {
  const runtime = await state(tx);
  if (runtime.vaultEpoch !== vaultEpoch) throw new Error("E_VAULT_EPOCH");
  if (runtime.clearing) throw new Error("E_CLEARING");
  if (runtime.paused && !options.allowPaused) throw new Error("E_PAUSED");
  return runtime;
}
export interface Usage {
  usedBytes: number;
  reservedBytes: number;
  chargedBytes: number;
  budgetBytes: number;
  recordCount: number;
  objectCount: number;
}
async function chunkBytes(tx: Tx | ReadTx) {
  const chunks = tx.objectStore("chunks");
  let total = 0;
  let entries = 0;
  const add = (length: number, count = 1) => {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(total + length * count)
    )
      throw new Error("E_INTEGRITY");
    total += length * count;
    entries += count;
  };
  if (chunks.indexNames.contains("rawLength")) {
    const index = chunks.index("rawLength");
    // Count equal sizes together: full chunks dominate the store. This avoids
    // one asynchronous cursor roundtrip for every stored chunk on every write.
    let cursor = await index.openKeyCursor(null, "nextunique");
    while (cursor) {
      if (typeof cursor.key !== "number") throw new Error("E_INTEGRITY");
      add(cursor.key, await index.count(cursor.key));
      cursor = await cursor.continue();
    }
    if (entries !== (await chunks.count())) throw new Error("E_INTEGRITY");
    return total;
  }
  // Compatibility for local development profiles that opened schema v2 before the index existed.
  let cursor = await chunks.openCursor();
  while (cursor) {
    add(cursor.value.rawLength);
    cursor = await cursor.continue();
  }
  return total;
}
export async function usage(tx: Tx | ReadTx): Promise<Usage> {
  const [runtime, usedBytes, sessions, imports, recordCount, objectCount] =
    await Promise.all([
      state(tx),
      chunkBytes(tx),
      tx.objectStore("sessions").getAll(),
      tx.objectStore("imports").getAll(),
      tx.objectStore("records").count(),
      tx.objectStore("objects").count(),
    ]);
  const sessionReservations = sessions
    .filter((item) =>
      ["queued", "capturing", "finalising"].includes(item.status),
    )
    .reduce(
      (total, item) => total + Math.max(0, item.reservedRemainingBytes),
      0,
    );
  const importReservations = imports.reduce(
    (total, item) =>
      item.kind === "import-control" &&
      typeof item.reservedRemainingBytes === "number"
        ? total + Math.max(0, item.reservedRemainingBytes)
        : total,
    0,
  );
  const reservedBytes = sessionReservations + importReservations;
  return {
    usedBytes,
    reservedBytes,
    chargedBytes: usedBytes + reservedBytes,
    budgetBytes: runtime.budgetBytes,
    recordCount,
    objectCount,
  };
}
