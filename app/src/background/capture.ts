import { sha256 } from "@noble/hashes/sha2.js";
import defaults from "../shared/config.defaults.json";
import {
  assertWritable,
  database,
  state,
  usage,
  write,
  type InternalCaptureSession,
  type Tx,
} from "../storage/db";
import {
  CHUNK,
  MAX_FILE,
  cleanURL,
  decode,
  digest,
  excluded,
  fail,
  hex,
} from "../domain/rules";
import type {
  CallerBinding,
  CaptureSession,
  PageContext,
  StoredRecord,
} from "../shared/model";
import type {
  BeginPayload,
  BeginResult,
  ChunkPayload,
  FileAcceptance,
  FileCandidate,
  ProgressResult,
  SessionReference,
} from "../shared/protocol";

const now = () => new Date().toISOString();
const terminal = (session: CaptureSession) =>
  ["committed", "aborted"].includes(session.status);
const active = (session: CaptureSession) =>
  ["capturing", "finalising"].includes(session.status);
const callerKey = (caller: CallerBinding) =>
  JSON.stringify([
    caller.kind,
    caller.tabId,
    caller.documentId,
    caller.frameId,
    caller.origin,
  ]);

export function sameCaller(a: CallerBinding, b: CallerBinding) {
  return callerKey(a) === callerKey(b);
}

export async function gate(
  tx: Tx,
  caller: CallerBinding,
  epoch: number | null,
  session?: CaptureSession,
) {
  const runtime = await assertWritable(tx, epoch, {
    allowPaused: caller.kind === "ui",
  });
  if (caller.kind === "ui") return { runtime, site: null };
  if (runtime.paused) fail("E_PAUSED");
  const site = await tx.objectStore("sites").get(caller.origin);
  if (!site?.enabled) fail("E_SITE_DISABLED");
  if (
    session &&
    (session.policyEpoch.global !== runtime.globalPolicyEpoch ||
      session.policyEpoch.site !== site.sitePolicyEpoch)
  ) {
    fail("E_PERMISSION_REVOKED");
  }
  return { runtime, site };
}

export async function bound(
  tx: Tx,
  ref: SessionReference,
  caller: CallerBinding,
  epoch: number | null,
) {
  const runtime = await state(tx);
  if (runtime.vaultEpoch !== epoch) fail("E_VAULT_EPOCH");
  if (runtime.clearing) fail("E_CLEARING");
  const session = await tx.objectStore("sessions").get(ref.sessionId);
  if (
    !session ||
    session.token !== ref.token ||
    !sameCaller(session.caller, caller)
  )
    fail("E_SESSION_MISMATCH");
  if (session.vaultEpoch !== epoch) fail("E_VAULT_EPOCH");
  if (terminal(session)) return session;
  await gate(tx, caller, epoch, session);
  if (
    (session.status !== "queued" &&
      Date.parse(session.expiresAt) < Date.now()) ||
    Date.parse(session.absoluteExpiresAt) < Date.now()
  )
    fail("E_SESSION_EXPIRED");
  return session;
}

function progress(session: CaptureSession): ProgressResult {
  return {
    recordId: session.recordId,
    state: session.status,
    nextChunkIndex: session.nextChunkIndex,
    receivedBytes: session.receivedBytes,
    retryAfterMs: session.status === "queued" ? 250 : null,
  };
}

function token() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function activateQueued(tx: Tx) {
  const sessions = await tx.objectStore("sessions").getAll();
  const current = sessions.filter(active);
  const activeCallers = new Set(current.map((item) => callerKey(item.caller)));
  let slots = Math.max(
    0,
    defaults.capture.maxActiveFilesGlobal - current.length,
  );
  const queued = sessions
    .filter((item) => item.status === "queued")
    .sort(
      (a, b) =>
        (a.admissionSequence ?? Number.MAX_SAFE_INTEGER) -
          (b.admissionSequence ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.sessionId.localeCompare(b.sessionId),
    );
  for (const session of queued) {
    if (!slots || activeCallers.has(callerKey(session.caller))) continue;
    session.status = "capturing";
    session.lastProgressAt = now();
    session.expiresAt = new Date(
      Date.now() + defaults.capture.sessionIdleExpiryMs,
    ).toISOString();
    await tx.objectStore("sessions").put(session);
    activeCallers.add(callerKey(session.caller));
    slots--;
  }
}

function cleanPage(
  page: PageContext | null,
  caller: CallerBinding,
  locationMode: "origin_path" | "origin_only",
  saveTitle: boolean,
) {
  if (page === null) return null;
  if (
    caller.kind === "capture" &&
    (page.origin !== caller.origin ||
      new URL(cleanURL(page.location)).origin !== caller.origin)
  )
    fail("E_UNAUTHORISED");
  const location = cleanURL(page.location, locationMode);
  return {
    origin: new URL(location).origin,
    location,
    locationMode,
    title: saveTitle ? page.title : null,
  };
}

async function beginBatch(
  input: {
    batchEventId: string;
    source: "standard_input" | "user_drop" | "manual_snapshot";
    page: PageContext | null;
    files: FileCandidate[];
  },
  caller: CallerBinding,
  epoch: number | null,
): Promise<BeginResult> {
  const totalBytes = input.files.reduce(
    (total, file) => total + file.byteLength,
    0,
  );
  if (
    input.files.length < 1 ||
    input.files.length > defaults.capture.maxBatchFiles ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > defaults.capture.maxBatchBytes
  ) {
    fail("E_BATCH_LIMIT");
  }
  return write(async (tx) => {
    const { runtime, site } = await gate(tx, caller, epoch);
    if (
      caller.kind === "capture" &&
      input.source === "user_drop" &&
      !site?.dropEnabled
    )
      fail("E_SITE_DISABLED");
    const dedupeKey = `${caller.tabId ?? ""}:${caller.documentId}:${input.batchEventId}`;
    const prior = await tx.objectStore("batches").get(dedupeKey);
    const clientFileIds = input.files.map((file) => file.clientFileId);
    if (prior) {
      if (
        prior.clientFileIds?.length &&
        prior.clientFileIds.join(":") !== clientFileIds.join(":")
      )
        fail("E_BAD_MESSAGE");
      if (prior.acceptances) {
        const refreshed: FileAcceptance[] = [];
        for (const acceptance of prior.acceptances) {
          if (!acceptance.sessionId) {
            refreshed.push(acceptance);
            continue;
          }
          const current = await tx
            .objectStore("sessions")
            .get(acceptance.sessionId);
          refreshed.push(
            current
              ? {
                  ...acceptance,
                  nextChunkIndex: current.nextChunkIndex,
                  state: current.status === "queued" ? "queued" : "capturing",
                }
              : acceptance,
          );
        }
        return { batchId: prior.batchId, files: refreshed };
      }
      if (prior.sessionId && prior.clientFileId === clientFileIds[0]) {
        const old = await tx.objectStore("sessions").get(prior.sessionId);
        if (!old) fail("E_SESSION_EXPIRED");
        return {
          batchId: old.batchId,
          files: [
            {
              clientFileId: clientFileIds[0],
              recordId: old.recordId,
              sessionId: old.sessionId,
              token: old.token,
              state: old.status === "queued" ? "queued" : "capturing",
              nextChunkIndex: old.nextChunkIndex,
              errorCode: null,
            },
          ],
        };
      }
      fail("E_BAD_MESSAGE");
    }
    const recentBatches = (await tx.objectStore("batches").getAll()).filter(
      (item) =>
        item.documentId === caller.documentId &&
        Date.parse(item.createdAt) > Date.now() - 60_000,
    );
    if (
      recentBatches.length >= defaults.limits.batchBeginRatePerDocumentPerMinute
    )
      fail("E_RATE_LIMIT");

    const batchId = crypto.randomUUID();
    const createdAt = now();
    const sessions = await tx.objectStore("sessions").getAll();
    let globalActive = sessions.filter(active).length;
    let documentActive = sessions.filter(
      (item) => active(item) && sameCaller(item.caller, caller),
    ).length;
    let chargedBytes = (await usage(tx)).chargedBytes;
    let nextAdmissionSequence = runtime.nextCaptureSequence;
    if (
      !Number.isSafeInteger(nextAdmissionSequence) ||
      nextAdmissionSequence < 0
    )
      fail("E_INTEGRITY");
    const acceptances: FileAcceptance[] = [];
    const sessionIds: string[] = [];
    const locationMode =
      site?.locationMode ?? input.page?.locationMode ?? "origin_path";
    const page = cleanPage(
      input.page,
      caller,
      locationMode,
      site?.saveTitle ?? true,
    );

    for (const file of input.files) {
      if (excluded(file.name, runtime.excludedFileNames)) {
        acceptances.push({
          clientFileId: file.clientFileId,
          recordId: null,
          sessionId: null,
          token: null,
          state: "skipped",
          nextChunkIndex: 0,
          errorCode: "E_EXCLUDED_FILE",
        });
        continue;
      }
      const errorCode =
        file.byteLength > MAX_FILE
          ? "E_FILE_TOO_LARGE"
          : chargedBytes + file.byteLength > runtime.budgetBytes
            ? "E_BUDGET_EXCEEDED"
            : null;
      const recordId = crypto.randomUUID();
      const { clientFileId, ...metadata } = file;
      const record: StoredRecord = {
        recordId,
        batchId,
        observedAt: createdAt,
        source: input.source,
        page,
        file: metadata,
        snapshot: {
          state: errorCode ? "metadata_only" : "capturing",
          objectSha256: null,
          capturedAt: null,
          errorCode,
        },
        submission: { state: "unknown", updatedAt: null },
        user: { label: null, note: "", tags: [], pinned: false },
        revision: 0,
        importedAt: null,
        importJobId: null,
      };
      await tx.objectStore("records").put(record);
      if (errorCode) {
        acceptances.push({
          clientFileId,
          recordId,
          sessionId: null,
          token: null,
          state: "metadata_only",
          nextChunkIndex: 0,
          errorCode,
        });
        continue;
      }
      const status =
        globalActive < defaults.capture.maxActiveFilesGlobal &&
        documentActive < defaults.capture.maxActiveFilesPerDocument
          ? "capturing"
          : "queued";
      if (status === "capturing") {
        globalActive++;
        documentActive++;
      }
      chargedBytes += file.byteLength;
      if (!Number.isSafeInteger(nextAdmissionSequence + 1))
        fail("E_STORAGE_WRITE");
      const session: InternalCaptureSession = {
        vaultEpoch: runtime.vaultEpoch,
        sessionId: crypto.randomUUID(),
        recordId,
        batchId,
        payloadId: crypto.randomUUID(),
        token: token(),
        caller,
        policyEpoch: {
          global: runtime.globalPolicyEpoch,
          site: site?.sitePolicyEpoch ?? 0,
        },
        status,
        expectedBytes: file.byteLength,
        nextChunkIndex: 0,
        receivedBytes: 0,
        reservedRemainingBytes: file.byteLength,
        createdAt,
        lastProgressAt: createdAt,
        expiresAt: new Date(
          Date.now() + defaults.capture.sessionIdleExpiryMs,
        ).toISOString(),
        absoluteExpiresAt: new Date(
          Date.now() + defaults.capture.sessionAbsoluteExpiryMs,
        ).toISOString(),
        admissionSequence: nextAdmissionSequence++,
      };
      await tx.objectStore("sessions").put(session);
      sessionIds.push(session.sessionId);
      acceptances.push({
        clientFileId,
        recordId,
        sessionId: session.sessionId,
        token: session.token,
        state: status,
        nextChunkIndex: 0,
        errorCode: null,
      });
    }
    await tx.objectStore("batches").put({
      key: dedupeKey,
      batchId,
      batchEventId: input.batchEventId,
      documentId: caller.documentId,
      sessionIds,
      clientFileIds,
      acceptances,
      createdAt,
    });
    if (nextAdmissionSequence !== runtime.nextCaptureSequence) {
      runtime.nextCaptureSequence = nextAdmissionSequence;
      await tx.objectStore("meta").put(runtime, "runtime");
    }
    return { batchId, files: acceptances };
  });
}

export function begin(
  payload: BeginPayload,
  caller: CallerBinding,
  epoch: number | null,
) {
  return beginBatch(payload, caller, epoch);
}
export function manualBegin(
  payload: {
    batchEventId: string;
    page: PageContext | null;
    files: FileCandidate[];
  },
  caller: CallerBinding,
  epoch: number | null,
) {
  return beginBatch({ ...payload, source: "manual_snapshot" }, caller, epoch);
}

export async function chunk(
  payload: ChunkPayload,
  caller: CallerBinding,
  epoch: number | null,
) {
  const bytes = decode(payload.base64, payload.rawLength);
  if (digest(bytes) !== payload.chunkSha256) fail("E_CHUNK_HASH");
  try {
    return await write(async (tx) => {
      const session = await bound(tx, payload, caller, epoch);
      if (session.status === "committed") return progress(session);
      if (session.status === "aborted") fail("E_SESSION_EXPIRED");
      if (payload.index < session.nextChunkIndex) {
        const old = await tx
          .objectStore("chunks")
          .get([session.payloadId, payload.index]);
        if (
          !old ||
          old.chunkSha256 !== payload.chunkSha256 ||
          old.rawLength !== payload.rawLength
        )
          fail("E_CHUNK_CONFLICT");
        return progress(session);
      }
      if (
        session.status !== "capturing" ||
        payload.index !== session.nextChunkIndex
      )
        fail("E_CHUNK_ORDER");
      if (
        payload.rawLength !==
        Math.min(CHUNK, session.expectedBytes - session.receivedBytes)
      )
        fail("E_BAD_MESSAGE");
      const currentUsage = await usage(tx);
      if (currentUsage.chargedBytes > currentUsage.budgetBytes)
        fail("E_BUDGET_EXCEEDED");
      await tx.objectStore("chunks").put({
        payloadId: session.payloadId,
        index: payload.index,
        bytes: bytes.buffer as ArrayBuffer,
        rawLength: payload.rawLength,
        chunkSha256: payload.chunkSha256,
      });
      session.receivedBytes += payload.rawLength;
      session.reservedRemainingBytes = Math.max(
        0,
        session.reservedRemainingBytes - payload.rawLength,
      );
      session.nextChunkIndex++;
      session.lastProgressAt = now();
      session.expiresAt = new Date(
        Date.now() + defaults.capture.sessionIdleExpiryMs,
      ).toISOString();
      await tx.objectStore("sessions").put(session);
      return progress(session);
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      await recordCaptureFailure(payload, caller, epoch, error).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function hashPayload(session: CaptureSession) {
  const db = await database();
  try {
    const hasher = sha256.create();
    let size = 0;
    for (let index = 0; index < session.nextChunkIndex; index++) {
      const block = await db.get("chunks", [session.payloadId, index]);
      if (!block) fail("E_INTEGRITY");
      const bytes = new Uint8Array(block.bytes);
      if (
        bytes.length !== block.rawLength ||
        digest(bytes) !== block.chunkSha256
      )
        fail("E_INTEGRITY");
      hasher.update(bytes);
      size += bytes.length;
    }
    if (size !== session.expectedBytes) fail("E_INTEGRITY");
    return hex(hasher.digest());
  } finally {
    db.close();
  }
}

export async function finish(
  payload: SessionReference,
  caller: CallerBinding,
  epoch: number | null,
) {
  const session = await write(async (tx) => {
    const current = await bound(tx, payload, caller, epoch);
    if (terminal(current)) return current;
    if (
      current.status === "queued" ||
      current.receivedBytes !== current.expectedBytes ||
      current.nextChunkIndex !== Math.ceil(current.expectedBytes / CHUNK)
    )
      fail("E_CHUNK_ORDER");
    current.status = "finalising";
    await tx.objectStore("sessions").put(current);
    const record = await tx.objectStore("records").get(current.recordId);
    if (!record) fail("E_OBJECT_MISSING");
    record.snapshot.state = "finalising";
    await tx.objectStore("records").put(record);
    return current;
  });
  if (terminal(session)) return progress(session);
  let hash: string;
  try {
    hash = await hashPayload(session);
  } catch (error) {
    await failSession(payload, caller, epoch, "E_INTEGRITY").catch(
      () => undefined,
    );
    throw error;
  }
  return write(async (tx) => {
    const current = await bound(tx, payload, caller, epoch);
    if (current.status === "committed") return progress(current);
    if (current.status !== "finalising") fail("E_CHUNK_ORDER");
    const existing = await tx.objectStore("objects").get(hash);
    if (existing) {
      if (
        existing.byteLength !== current.expectedBytes ||
        existing.integrityState !== "verified"
      )
        fail("E_HASH_CONFLICT");
      existing.refCount++;
      await tx.objectStore("objects").put(existing);
      await tx.objectStore("gcQueue").put({
        payloadId: current.payloadId,
        byteLength: current.expectedBytes,
        createdAt: now(),
      });
    } else {
      await tx.objectStore("objects").put({
        sha256: hash,
        byteLength: current.expectedBytes,
        payloadId: current.payloadId,
        chunkCount: current.nextChunkIndex,
        refCount: 1,
        createdAt: now(),
        integrityState: "verified",
      });
    }
    const record = await tx.objectStore("records").get(current.recordId);
    if (!record) fail("E_OBJECT_MISSING");
    record.snapshot = {
      state: "ready",
      objectSha256: hash,
      capturedAt: now(),
      errorCode: null,
    };
    record.revision++;
    await tx.objectStore("records").put(record);
    current.status = "committed";
    current.reservedRemainingBytes = 0;
    current.lastProgressAt = now();
    await tx.objectStore("sessions").put(current);
    await tx.objectStore("audit").put({
      eventId: crypto.randomUUID(),
      recordId: record.recordId,
      createdAt: record.snapshot.capturedAt!,
      actor: "system",
      type: "snapshot_saved",
      from: "finalising",
      to: "ready",
      note: null,
    });
    await activateQueued(tx);
    return progress(current);
  });
}

export async function abortIn(tx: Tx, session: CaptureSession, code: string) {
  if (terminal(session)) return;
  const record = await tx.objectStore("records").get(session.recordId);
  if (record) {
    const interrupted = [
      "E_SOURCE_GONE",
      "E_SESSION_EXPIRED",
      "E_PAUSED",
      "E_PERMISSION_REVOKED",
    ].includes(code);
    record.snapshot = {
      state: interrupted ? "interrupted" : "failed",
      objectSha256: null,
      capturedAt: null,
      errorCode: code,
    };
    record.revision++;
    await tx.objectStore("records").put(record);
    await tx.objectStore("audit").put({
      eventId: crypto.randomUUID(),
      recordId: record.recordId,
      createdAt: now(),
      actor: "system",
      type: "snapshot_failed",
      from: session.status,
      to: record.snapshot.state,
      note: code,
    });
  }
  session.status = "aborted";
  session.reservedRemainingBytes = 0;
  session.lastProgressAt = now();
  await tx.objectStore("sessions").put(session);
  if (session.receivedBytes > 0)
    await tx.objectStore("gcQueue").put({
      payloadId: session.payloadId,
      byteLength: session.receivedBytes,
      createdAt: now(),
    });
  await activateQueued(tx);
}

async function failSession(
  ref: SessionReference,
  caller: CallerBinding,
  epoch: number | null,
  code: string,
) {
  return write(async (tx) => {
    const session = await bound(tx, ref, caller, epoch);
    await abortIn(tx, session, code);
    return progress(session);
  });
}
export function storageFailureCode(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? "E_QUOTA"
    : "E_STORAGE_WRITE";
}
export function recordCaptureFailure(
  ref: SessionReference,
  caller: CallerBinding,
  epoch: number | null,
  error: unknown,
) {
  return failSession(ref, caller, epoch, storageFailureCode(error));
}
export function resume(
  payload: SessionReference,
  caller: CallerBinding,
  epoch: number | null,
) {
  return write(async (tx) => {
    await activateQueued(tx);
    const session = await bound(tx, payload, caller, epoch);
    if (session.status === "queued") {
      session.lastProgressAt = now();
      session.expiresAt = new Date(
        Date.now() + defaults.capture.sessionIdleExpiryMs,
      ).toISOString();
      await tx.objectStore("sessions").put(session);
    }
    return progress(session);
  });
}
export function abort(
  payload: SessionReference,
  caller: CallerBinding,
  epoch: number | null,
  code: string,
) {
  return failSession(payload, caller, epoch, code);
}

export async function recover(gone?: CallerBinding, batchEventIds?: string[]) {
  const db = await database();
  const [sessions, batches] = await Promise.all([
    db.getAll("sessions"),
    db.getAll("batches"),
  ]);
  db.close();
  const allowedBatchIds = batchEventIds
    ? new Set(
        batches
          .filter((item) => batchEventIds.includes(item.batchEventId))
          .map((item) => item.batchId),
      )
    : null;
  for (const session of sessions) {
    if (
      terminal(session) ||
      (gone && !sameCaller(session.caller, gone)) ||
      (allowedBatchIds && !allowedBatchIds.has(session.batchId))
    )
      continue;
    if (session.receivedBytes === session.expectedBytes) {
      try {
        await write(async (tx) => {
          const current = await tx
            .objectStore("sessions")
            .get(session.sessionId);
          if (!current || terminal(current)) return;
          await gate(tx, current.caller, current.vaultEpoch, current);
          current.expiresAt = new Date(
            Date.now() + defaults.capture.sessionIdleExpiryMs,
          ).toISOString();
          current.absoluteExpiresAt = new Date(
            Date.now() + defaults.capture.sessionIdleExpiryMs,
          ).toISOString();
          await tx.objectStore("sessions").put(current);
        });
        await finish(session, session.caller, session.vaultEpoch);
      } catch {
        await write(async (tx) => {
          const runtime = await state(tx);
          const current = await tx
            .objectStore("sessions")
            .get(session.sessionId);
          if (
            !current ||
            terminal(current) ||
            runtime.clearing ||
            runtime.vaultEpoch !== current.vaultEpoch
          )
            return;
          const site =
            current.caller.kind === "capture"
              ? await tx.objectStore("sites").get(current.caller.origin)
              : null;
          const code = runtime.paused
            ? "E_PAUSED"
            : current.caller.kind === "capture" &&
                (!site?.enabled ||
                  site.sitePolicyEpoch !== current.policyEpoch.site ||
                  runtime.globalPolicyEpoch !== current.policyEpoch.global)
              ? "E_PERMISSION_REVOKED"
              : "E_STORAGE_WRITE";
          await abortIn(tx, current, code);
        }).catch(() => undefined);
      }
      continue;
    }
    const idleExpired =
      session.status !== "queued" && Date.parse(session.expiresAt) < Date.now();
    if (
      gone ||
      idleExpired ||
      Date.parse(session.absoluteExpiresAt) < Date.now()
    ) {
      await write(async (tx) => {
        const runtime = await state(tx);
        if (runtime.clearing || runtime.vaultEpoch !== session.vaultEpoch)
          return;
        const current = await tx.objectStore("sessions").get(session.sessionId);
        if (
          current &&
          !terminal(current) &&
          current.receivedBytes < current.expectedBytes
        ) {
          await abortIn(
            tx,
            current,
            gone ? "E_SOURCE_GONE" : "E_SESSION_EXPIRED",
          );
        }
      });
    }
  }
  await write(async (tx) => {
    const runtime = await state(tx);
    if (runtime.clearing) return;
    const cutoff = Date.now() - defaults.capture.terminalSessionRetentionMs;
    const current = await tx.objectStore("sessions").getAll();
    for (const session of current)
      if (terminal(session) && Date.parse(session.lastProgressAt) < cutoff) {
        await tx.objectStore("sessions").delete(session.sessionId);
      }
    const remaining = new Set(
      (await tx.objectStore("sessions").getAll()).map((item) => item.sessionId),
    );
    for (const batch of await tx.objectStore("batches").getAll()) {
      const ids =
        batch.sessionIds ?? (batch.sessionId ? [batch.sessionId] : []);
      if (
        Date.parse(batch.createdAt) < cutoff &&
        ids.every((id) => !remaining.has(id))
      )
        await tx.objectStore("batches").delete(batch.key);
    }
  });
}
