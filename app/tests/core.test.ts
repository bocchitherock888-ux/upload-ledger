import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  abortIn,
  begin,
  chunk,
  finish,
  manualBegin,
  recordCaptureFailure,
  recover,
  resume,
} from "../src/background/capture";
import {
  clearAll,
  deleteRecords,
  endJob,
  prepareJob,
  requestClearChallenge,
  runGc,
  setSettings,
  setSubmission,
  setUserFields,
} from "../src/background/lifecycle";
import {
  database,
  initial,
  state,
  stores,
  usage,
  write,
} from "../src/storage/db";
import {
  getJobManifest,
  library,
  original,
  queryRecords,
} from "../src/storage/read";
import {
  CHUNK,
  cleanURL,
  decode,
  digest,
  encode,
  excluded,
  permissionPattern,
} from "../src/domain/rules";
import { validate } from "../src/shared/validation";
import { command } from "../src/shared/client";
import { identify } from "../src/background/auth";
import { validateManifest } from "../src/backup/manifest";
import type { CallerBinding } from "../src/shared/model";

const caller: CallerBinding = {
  kind: "capture",
  tabId: 1,
  documentId: "document-1",
  frameId: 0,
  origin: "https://example.com",
};
const otherCaller: CallerBinding = {
  ...caller,
  tabId: 2,
  documentId: "document-2",
};
const ui: CallerBinding = {
  kind: "ui",
  tabId: null,
  documentId: "app-document",
  frameId: 0,
  origin: "chrome-extension://test-extension",
};

async function setup() {
  await write(async (tx) => {
    for (const name of stores) await tx.objectStore(name).clear();
    await tx
      .objectStore("meta")
      .put(
        { ...initial, excludedFileNames: [...initial.excludedFileNames] },
        "runtime",
      );
    await tx.objectStore("sites").put({
      exactOrigin: caller.origin,
      enabled: true,
      dropEnabled: true,
      locationMode: "origin_path",
      saveTitle: true,
      permissionPattern: "https://example.com/*",
      sitePolicyEpoch: 0,
    });
  });
}
function beginPayload(
  bytes: Uint8Array[],
  names = bytes.map((_, index) => `file-${index}.txt`),
  batchEventId = crypto.randomUUID(),
) {
  return {
    batchEventId,
    source: "standard_input" as const,
    page: {
      origin: caller.origin,
      location: `${caller.origin}/apply?secret=yes#part`,
      title: "Test",
      locationMode: "origin_path" as const,
    },
    files: bytes.map((value, index) => ({
      clientFileId: crypto.randomUUID(),
      name: names[index],
      byteLength: value.length,
      declaredMime: "text/plain",
      lastModified: 0,
    })),
  };
}
const payload = (
  ref: { sessionId: string; token: string },
  bytes: Uint8Array,
  index = 0,
) => ({
  ...ref,
  index,
  rawLength: bytes.length,
  base64: encode(bytes),
  chunkSha256: digest(bytes),
});
async function save(
  bytes: Uint8Array,
  name = "proposal.txt",
  sourceCaller = caller,
) {
  const result = await begin(beginPayload([bytes], [name]), sourceCaller, 0);
  const accepted = result.files[0];
  assert.ok(accepted.sessionId && accepted.token && accepted.recordId);
  const ref = { sessionId: accepted.sessionId, token: accepted.token };
  for (let index = 0; index < Math.ceil(bytes.length / CHUNK); index++) {
    await chunk(
      payload(ref, bytes.subarray(index * CHUNK, (index + 1) * CHUNK), index),
      sourceCaller,
      0,
    );
  }
  await finish(ref, sourceCaller, 0);
  return { ...accepted, ...ref };
}

test("rules and strict protocol protect URLs, ports, Base64 and all command payloads", () => {
  assert.equal(
    cleanURL("https://u:p@example.com:8443/a?secret=1#x"),
    "https://example.com:8443/a",
  );
  assert.equal(
    permissionPattern("https://example.com:8443"),
    "https://example.com/*",
  );
  assert.throws(() => cleanURL("javascript:alert(1)"), /E_INVALID_URL/);
  for (const name of [".env", ".env.prod", "id_ed25519", "secret.pem"])
    assert.equal(excluded(name), true, name);
  assert.throws(() =>
    validate({
      v: 1,
      requestId: crypto.randomUUID(),
      vaultEpoch: 0,
      type: "UI_GET_RUNTIME_STATE",
      payload: { extra: true },
    }),
  );
  assert.throws(() =>
    validate({
      v: 1,
      requestId: crypto.randomUUID(),
      vaultEpoch: 0,
      type: "UI_SET_SITE_POLICY",
      payload: {
        origin: caller.origin,
        enabled: true,
        dropEnabled: false,
        locationMode: "origin_path",
        saveTitle: true,
        surprise: 1,
      },
    }),
  );
  assert.throws(() => decode("AB==", 1));
  assert.deepEqual(decode("AA==", 1), new Uint8Array([0]));
});

test("lost acknowledgements retry capture with one request ID and send non-idempotent UI writes once", async () => {
  const previous = globalThis.chrome;
  const seen: unknown[] = [];
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        sendMessage: (request: unknown) => {
          seen.push(request);
          return seen.length === 1
            ? Promise.reject(new Error("E_ACK_TIMEOUT"))
            : Promise.resolve({ ok: true, data: { state: "capturing" } });
        },
      },
    },
  });
  try {
    await command(
      "CAPTURE_RESUME",
      { sessionId: crypto.randomUUID(), token: "a".repeat(43) },
      0,
    );
    assert.equal(seen.length, 2);
    assert.equal(
      (seen[0] as { requestId: string }).requestId,
      (seen[1] as { requestId: string }).requestId,
    );
    seen.length = 0;
    await assert.rejects(
      command(
        "UI_SET_SETTINGS",
        { expectedSettingsRevision: 0, patch: { locale: "en-GB" } },
        0,
      ),
      /E_ACK_TIMEOUT/,
    );
    assert.equal(seen.length, 1);
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});

test("batch admission is atomic, idempotent, complete, queued and private for exclusions", async () => {
  await setup();
  const batchEventId = crypto.randomUUID();
  const input = beginPayload(
    [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
    ["one.txt", ".env", "three.txt"],
    batchEventId,
  );
  const first = await begin(input, caller, 0);
  const retry = await begin(input, caller, 0);
  assert.equal(first.batchId, retry.batchId);
  assert.equal(first.files.length, 3);
  assert.equal(first.files[0].state, "capturing");
  assert.equal(first.files[1].state, "skipped");
  assert.equal(first.files[2].state, "queued");
  assert.equal(first.files[1].recordId, null);
  assert.deepEqual(retry.files, first.files);
  const db = await database();
  const persisted = JSON.stringify([
    await db.getAll("records"),
    await db.getAll("batches"),
    await db.getAll("sessions"),
  ]);
  db.close();
  assert.equal(persisted.includes(".env"), false);
  await assert.rejects(
    begin(
      beginPayload(Array.from({ length: 101 }, () => new Uint8Array())),
      caller,
      0,
    ),
    /E_BATCH_LIMIT/,
  );
});

test("background rejects drop capture when the exact-site opt-in is disabled", async () => {
  await setup();
  await write(async (tx) => {
    const site = (await tx.objectStore("sites").get(caller.origin))!;
    site.dropEnabled = false;
    await tx.objectStore("sites").put(site);
  });
  const input = {
    ...beginPayload([new Uint8Array([1])]),
    source: "user_drop" as const,
  };
  await assert.rejects(begin(input, caller, 0), /E_SITE_DISABLED/);
  const db = await database();
  assert.equal(await db.count("records"), 0);
  assert.equal(await db.count("sessions"), 0);
  db.close();
});

test("simultaneous BEGIN transactions cannot overbook the byte budget", async () => {
  await setup();
  await write(async (tx) => {
    const runtime = await state(tx);
    runtime.budgetBytes = 1;
    await tx.objectStore("meta").put(runtime, "runtime");
  });
  const [first, second] = await Promise.all([
    begin(beginPayload([new Uint8Array([1])]), caller, 0),
    begin(beginPayload([new Uint8Array([2])]), caller, 0),
  ]);
  const files = [first.files[0], second.files[0]];
  assert.equal(files.filter((file) => file.state === "capturing").length, 1);
  assert.equal(
    files.filter((file) => file.errorCode === "E_BUDGET_EXCEEDED").length,
    1,
  );
  const measured = await write(usage);
  assert.equal(measured.reservedBytes, 1);
  assert.equal(measured.chargedBytes, 1);
});

test("persistent queue advances and chunk retries enforce order, caller, policy and vault epochs", async () => {
  await setup();
  const a = await begin(
    beginPayload([new Uint8Array([1]), new Uint8Array([2])]),
    caller,
    0,
  );
  const first = { sessionId: a.files[0].sessionId!, token: a.files[0].token! };
  const second = { sessionId: a.files[1].sessionId!, token: a.files[1].token! };
  assert.equal((await resume(second, caller, 0)).state, "queued");
  const firstChunk = payload(first, new Uint8Array([1]));
  await chunk(firstChunk, caller, 0);
  assert.equal((await chunk(firstChunk, caller, 0)).receivedBytes, 1);
  await assert.rejects(
    chunk(payload(first, new Uint8Array([9])), caller, 0),
    /E_CHUNK_CONFLICT/,
  );
  await assert.rejects(resume(first, otherCaller, 0), /E_SESSION_MISMATCH/);
  await finish(first, caller, 0);
  assert.equal((await resume(second, caller, 0)).state, "capturing");
  await write(async (tx) => {
    const site = (await tx.objectStore("sites").get(caller.origin))!;
    site.sitePolicyEpoch++;
    await tx.objectStore("sites").put(site);
  });
  await assert.rejects(resume(second, caller, 0), /E_PERMISSION_REVOKED/);
  await assert.rejects(resume(second, caller, 99), /E_VAULT_EPOCH/);
});

test("a seven-file batch drains in selection order without a queued-session deadlock", async () => {
  await setup();
  const values = Array.from(
    { length: 7 },
    (_, index) => new Uint8Array([index + 1]),
  );
  const started = await begin(beginPayload(values), caller, 0);
  assert.equal(started.files[0].state, "capturing");
  assert.equal(
    started.files.slice(1).every((file) => file.state === "queued"),
    true,
  );
  for (let index = 0; index < started.files.length; index++) {
    const accepted = started.files[index];
    const ref = { sessionId: accepted.sessionId!, token: accepted.token! };
    const current = await resume(ref, caller, 0);
    assert.equal(
      current.state,
      "capturing",
      `file ${index + 1} should be promoted next`,
    );
    await chunk(payload(ref, values[index]), caller, 0);
    assert.equal((await finish(ref, caller, 0)).state, "committed");
  }
  const db = await database();
  const sessions = await db.getAll("sessions");
  assert.equal(
    sessions.every((session) => session.status === "committed"),
    true,
  );
  assert.deepEqual(
    sessions
      .map((session) => session.admissionSequence)
      .sort((a, b) => a! - b!),
    [0, 1, 2, 3, 4, 5, 6],
  );
  db.close();
});

test("durable capture hashes independently, deduplicates, supports zero bytes and lease-only reads", async () => {
  await setup();
  const bytes = new Uint8Array(CHUNK + 57).map((_, index) => index % 251);
  const a = await save(bytes);
  const b = await save(bytes, "copy.txt");
  const empty = await save(new Uint8Array(), "empty.txt");
  const job = await prepareJob("preview", [a.recordId!], ui, 0);
  const file = await original(a.recordId!, job.jobId);
  assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), bytes);
  assert.equal(
    (await getJobManifest(job.jobId)).audit.some(
      (event) => event.recordId === a.recordId,
    ),
    true,
  );
  const db = await database();
  assert.equal(
    (await db.get("records", a.recordId!))?.snapshot.objectSha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal((await db.get("objects", digest(bytes)))?.refCount, 2);
  assert.equal(await db.count("objects"), 2);
  assert.equal(
    (await db.get("records", b.recordId!))?.page?.location,
    "https://example.com/apply",
  );
  assert.equal(
    (await db.get("records", empty.recordId!))?.snapshot.state,
    "ready",
  );
  db.close();
  await assert.rejects(
    original(a.recordId!, crypto.randomUUID()),
    /E_OBJECT_IN_USE/,
  );
});

test("usage keeps partial, reservation, dedup staging and garbage bytes charged", async () => {
  await setup();
  const value = new Uint8Array(CHUNK + 1);
  const started = await begin(beginPayload([value]), caller, 0);
  const ref = {
    sessionId: started.files[0].sessionId!,
    token: started.files[0].token!,
  };
  await chunk(payload(ref, value.subarray(0, CHUNK)), caller, 0);
  let measured = await write(usage);
  assert.equal(measured.usedBytes, CHUNK);
  assert.equal(measured.reservedBytes, 1);
  assert.equal(measured.chargedBytes, CHUNK + 1);
  await chunk(payload(ref, value.subarray(CHUNK), 1), caller, 0);
  await finish(ref, caller, 0);
  await save(value, "same.bin");
  measured = await write(usage);
  assert.equal(measured.objectCount, 1);
  assert.equal(measured.usedBytes, 2 * (CHUNK + 1));
  await runGc(200);
  measured = await write(usage);
  assert.equal(measured.usedBytes, CHUNK + 1);
  await write(async (tx) => {
    const runtime = await state(tx);
    runtime.budgetBytes = measured.chargedBytes;
    await tx.objectStore("meta").put(runtime, "runtime");
  });
  const denied = await begin(beginPayload([new Uint8Array([1])]), caller, 0);
  assert.equal(denied.files[0].errorCode, "E_BUDGET_EXCEEDED");
});

test("usage sums chunk index keys without cloning stored bodies", async () => {
  await setup();
  const value = new Uint8Array(CHUNK + 3);
  const started = await begin(beginPayload([value]), caller, 0);
  const ref = {
    sessionId: started.files[0].sessionId!,
    token: started.files[0].token!,
  };
  await chunk(payload(ref, value.subarray(0, CHUNK)), caller, 0);
  const prototype = IDBObjectStore.prototype as unknown as {
    getAll: (...args: unknown[]) => IDBRequest<unknown[]>;
  };
  const original = prototype.getAll;
  prototype.getAll = function (...args: unknown[]) {
    if ((this as unknown as IDBObjectStore).name === "chunks")
      throw new Error("chunk bodies were cloned");
    return original.apply(this, args);
  };
  try {
    const measured = await write(usage);
    assert.equal(measured.usedBytes, CHUNK);
    assert.equal(measured.reservedBytes, 3);
    assert.equal(measured.chargedBytes, CHUNK + 3);
  } finally {
    prototype.getAll = original;
  }
});

test("quota classification records a failed terminal state and releases reservation", async () => {
  await setup();
  const started = await begin(beginPayload([new Uint8Array([1])]), caller, 0);
  const ref = {
    sessionId: started.files[0].sessionId!,
    token: started.files[0].token!,
  };
  await recordCaptureFailure(
    ref,
    caller,
    0,
    new DOMException("full", "QuotaExceededError"),
  );
  const db = await database();
  const record = await db.get("records", started.files[0].recordId!);
  const session = await db.get("sessions", ref.sessionId);
  db.close();
  assert.equal(record?.snapshot.state, "failed");
  assert.equal(record?.snapshot.errorCode, "E_QUOTA");
  assert.equal(session?.reservedRemainingBytes, 0);
});

test("source loss and expiry interrupt partial files while complete bytes recover", async () => {
  await setup();
  const partial = await begin(
    beginPayload([new Uint8Array(CHUNK + 1)]),
    caller,
    0,
  );
  const partialRef = {
    sessionId: partial.files[0].sessionId!,
    token: partial.files[0].token!,
  };
  await chunk(payload(partialRef, new Uint8Array(CHUNK)), caller, 0);
  await recover(caller);
  const complete = await begin(
    beginPayload([new Uint8Array([1, 2])]),
    caller,
    0,
  );
  const completeRef = {
    sessionId: complete.files[0].sessionId!,
    token: complete.files[0].token!,
  };
  await chunk(payload(completeRef, new Uint8Array([1, 2])), caller, 0);
  await recover(caller);
  const db = await database();
  assert.equal(
    (await db.get("records", partial.files[0].recordId!))?.snapshot.state,
    "interrupted",
  );
  assert.equal(
    (await db.get("records", complete.files[0].recordId!))?.snapshot.state,
    "ready",
  );
  db.close();
});

test("queued sessions use their absolute deadline while active sessions use idle expiry", async () => {
  await setup();
  const started = await begin(
    beginPayload([new Uint8Array([1]), new Uint8Array([2])]),
    caller,
    0,
  );
  const queuedId = started.files[1].sessionId!;
  await write(async (tx) => {
    const queued = (await tx.objectStore("sessions").get(queuedId))!;
    queued.expiresAt = new Date(0).toISOString();
    queued.absoluteExpiresAt = new Date(Date.now() + 60_000).toISOString();
    await tx.objectStore("sessions").put(queued);
  });
  await recover();
  const db = await database();
  assert.equal((await db.get("sessions", queuedId))?.status, "queued");
  assert.equal(
    (await db.get("records", started.files[1].recordId!))?.snapshot.state,
    "capturing",
  );
  db.close();
});

test("expiry recovery finalises complete bytes and pause leaves manual intake usable", async () => {
  await setup();
  const complete = await begin(beginPayload([new Uint8Array([7])]), caller, 0);
  const completeRef = {
    sessionId: complete.files[0].sessionId!,
    token: complete.files[0].token!,
  };
  await chunk(payload(completeRef, new Uint8Array([7])), caller, 0);
  await write(async (tx) => {
    const session = (await tx
      .objectStore("sessions")
      .get(completeRef.sessionId))!;
    session.expiresAt = new Date(0).toISOString();
    session.absoluteExpiresAt = new Date(0).toISOString();
    await tx.objectStore("sessions").put(session);
  });
  await recover();
  await write(async (tx) => {
    const runtime = await state(tx);
    runtime.paused = true;
    runtime.globalPolicyEpoch++;
    await tx.objectStore("meta").put(runtime, "runtime");
    await abortIn(
      tx,
      (await tx.objectStore("sessions").get(completeRef.sessionId))!,
      "E_PAUSED",
    );
  });
  const manual = await manualBegin(
    {
      batchEventId: crypto.randomUUID(),
      page: null,
      files: [
        {
          clientFileId: crypto.randomUUID(),
          name: "manual.txt",
          byteLength: 0,
          declaredMime: "text/plain",
          lastModified: 0,
        },
      ],
    },
    ui,
    0,
  );
  assert.equal(manual.files[0].state, "capturing");
  await finish(
    { sessionId: manual.files[0].sessionId!, token: manual.files[0].token! },
    ui,
    0,
  );
  const db = await database();
  assert.equal(
    (await db.get("records", complete.files[0].recordId!))?.snapshot.state,
    "ready",
  );
  assert.equal(
    (await db.get("records", manual.files[0].recordId!))?.snapshot.state,
    "ready",
  );
  db.close();
});

test("settings and record revisions reject concurrent stale writes atomically", async () => {
  await setup();
  const saved = await save(new Uint8Array([1]));
  const settings = await setSettings(
    0,
    { locale: "en-GB", theme: "dark", excludedFileNames: ["*.secret"] },
    0,
  );
  assert.equal(settings.runtime.settingsRevision, 1);
  await assert.rejects(setSettings(0, { locale: "zh-CN" }, 0), /E_CONFLICT/);
  const fields = {
    label: "Application",
    note: "sent",
    tags: ["work"],
    pinned: true,
  };
  const updated = await setUserFields(saved.recordId!, 1, fields, 0);
  await assert.rejects(
    setUserFields(saved.recordId!, 1, fields, 0),
    /E_CONFLICT/,
  );
  await setSubmission(
    [{ recordId: saved.recordId!, expectedRevision: updated.revision }],
    "user_confirmed",
    null,
    0,
  );
  await assert.rejects(
    setSubmission(
      [{ recordId: saved.recordId!, expectedRevision: updated.revision }],
      "unknown",
      null,
      0,
    ),
    /E_CONFLICT/,
  );
});

test("maximum user notes remain exportable with bounded audit transitions", async () => {
  await setup();
  const saved = await save(new Uint8Array([1, 2, 3]));
  await setUserFields(
    saved.recordId!,
    1,
    {
      label: "申".repeat(120),
      note: "注".repeat(4000),
      tags: ["test"],
      pinned: true,
    },
    0,
  );
  const job = await prepareJob("export", [saved.recordId!], ui, 0);
  const manifest = await getJobManifest(job.jobId);
  validateManifest({ ...manifest, appVersion: "1.0.0" });
  const audit = manifest.audit.find(
    (event) => event.type === "user_fields_changed",
  )!;
  assert.equal(audit.from, "revision:1");
  assert.equal(audit.to, "revision:2");
  assert.equal(manifest.records[0].user.note.length, 4000);
  await endJob(job.jobId, "completed", ui, 0);
});

test("leases block deletion, then refcounts and bounded GC release shared content", async () => {
  await setup();
  const a = await save(new Uint8Array([1, 2, 3]));
  const b = await save(new Uint8Array([1, 2, 3]), "alias.txt");
  const job = await prepareJob("export", [a.recordId!], ui, 0);
  await assert.rejects(
    deleteRecords([{ recordId: a.recordId!, expectedRevision: 1 }], 0),
    /E_OBJECT_IN_USE/,
  );
  await write(async (tx) => {
    const row = (await tx.objectStore("jobs").get(job.jobId))!;
    row.leaseUntil = new Date(0).toISOString();
    await tx.objectStore("jobs").put(row);
  });
  await deleteRecords([{ recordId: a.recordId!, expectedRevision: 1 }], 0);
  let db = await database();
  assert.equal(
    (await db.get("objects", digest(new Uint8Array([1, 2, 3]))))?.refCount,
    1,
  );
  db.close();
  await deleteRecords([{ recordId: b.recordId!, expectedRevision: 1 }], 0);
  db = await database();
  assert.equal(await db.count("objects"), 0);
  assert.equal(await db.count("gcQueue"), 2);
  db.close();
  assert.equal((await runGc(1)).deletedChunks, 1);
  db = await database();
  assert.equal(await db.count("gcQueue"), 1);
  db.close();
  await runGc(1);
  db = await database();
  assert.equal(await db.count("gcQueue"), 0);
  db.close();
});

test("stable paging follows record ID ascending, binds cursors to filters and searches title with tag OR", async () => {
  await setup();
  const a = await save(new Uint8Array([1]), "alpha.txt");
  const b = await save(new Uint8Array([2]), "beta.txt");
  await setUserFields(
    a.recordId!,
    1,
    { label: "Needle", note: "", tags: ["x"], pinned: true },
    0,
  );
  await setUserFields(
    b.recordId!,
    1,
    { label: null, note: "", tags: ["y"], pinned: false },
    0,
  );
  await write(async (tx) => {
    for (const id of [a.recordId!, b.recordId!]) {
      const record = (await tx.objectStore("records").get(id))!;
      record.observedAt = "2026-01-01T00:00:00.000Z";
      await tx.objectStore("records").put(record);
    }
  });
  assert.deepEqual(
    (await queryRecords({ text: "test" })).records
      .map((item) => item.recordId)
      .sort(),
    [a.recordId, b.recordId].sort(),
  );
  assert.deepEqual(
    (await queryRecords({ tags: ["x", "y"] })).records
      .map((item) => item.recordId)
      .sort(),
    [a.recordId, b.recordId].sort(),
  );
  const expected = [a.recordId!, b.recordId!].sort();
  const first = await queryRecords({ limit: 1 });
  assert.deepEqual(
    first.records.map((item) => item.recordId),
    expected.slice(0, 1),
  );
  const second = await queryRecords({ limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(
    second.records.map((item) => item.recordId),
    expected.slice(1),
  );
  await assert.rejects(
    queryRecords({ text: "changed", limit: 1, cursor: first.nextCursor! }),
    /E_BAD_MESSAGE/,
  );
  await write(async (tx) => {
    const staged = (await tx.objectStore("records").get(b.recordId!))!;
    staged.importJobId = crypto.randomUUID();
    await tx.objectStore("records").put(staged);
  });
  const all = await library({ limit: 1 });
  assert.equal(all.records.length, 1);
  assert.equal(all.records[0].recordId, a.recordId);
});

test("clear uses caller-bound challenge, advances generations and rejects late writes", async () => {
  await setup();
  const started = await begin(beginPayload([new Uint8Array([1])]), caller, 0);
  const ref = {
    sessionId: started.files[0].sessionId!,
    token: started.files[0].token!,
  };
  const challenge = requestClearChallenge(ui, 0);
  const result = await clearAll(challenge.challenge, ui, 0);
  assert.equal(result.vaultEpoch, 1);
  await assert.rejects(
    chunk(payload(ref, new Uint8Array([1])), caller, 0),
    /E_VAULT_EPOCH/,
  );
  const db = await database();
  const runtime = await db.get("meta", "runtime");
  assert.equal(runtime?.vaultEpoch, 1);
  assert.equal(runtime?.paused, true);
  assert.equal(runtime?.clearing, false);
  assert.equal(await db.count("records"), 0);
  assert.equal(await db.count("sites"), 0);
  db.close();
});

test("clear blocks active read leases and cancels active import staging through its generation", async () => {
  await setup();
  const saved = await save(new Uint8Array([1]));
  const preview = await prepareJob("preview", [saved.recordId!], ui, 0);
  let challenge = requestClearChallenge(ui, 0);
  await assert.rejects(clearAll(challenge.challenge, ui, 0), /E_OBJECT_IN_USE/);
  await endJob(preview.jobId, "cancelled", ui, 0);
  const importJobId = crypto.randomUUID();
  const expires = new Date(Date.now() + 60_000).toISOString();
  await write(async (tx) => {
    await tx.objectStore("jobs").put({
      vaultEpoch: 0,
      jobId: importJobId,
      kind: "import",
      status: "staging",
      leaseUntil: expires,
      objectRefs: [],
      stagedRecordIds: [],
      manifest: null,
      caller: ui,
      createdAt: new Date().toISOString(),
    });
    await tx.objectStore("imports").put({
      id: importJobId,
      kind: "import-control",
      jobId: importJobId,
      reservedRemainingBytes: 1,
    });
  });
  challenge = requestClearChallenge(ui, 0);
  await clearAll(challenge.challenge, ui, 0);
  const db = await database();
  assert.equal(await db.count("jobs"), 0);
  assert.equal(await db.count("imports"), 0);
  db.close();
});

test("v1 database upgrades in place and state defaults merge without record loss", async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("upload-ledger");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("upload-ledger", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("records", { keyPath: "recordId" });
      db.createObjectStore("objects", { keyPath: "sha256" });
      db.createObjectStore("chunks", { keyPath: ["payloadId", "index"] });
      db.createObjectStore("sessions", { keyPath: "sessionId" });
      db.createObjectStore("sites", { keyPath: "exactOrigin" });
      db.createObjectStore("meta");
      db.createObjectStore("batches", { keyPath: "key" });
      db.createObjectStore("audit", { keyPath: "eventId" });
      request
        .transaction!.objectStore("records")
        .put({ recordId: "legacy", marker: true });
      request.transaction!.objectStore("meta").put(
        {
          vaultEpoch: 7,
          globalPolicyEpoch: 2,
          paused: false,
          clearing: false,
          settingsRevision: 0,
          budgetBytes: 123,
        },
        "runtime",
      );
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  const db = await database();
  assert.equal(
    ((await db.get("records", "legacy")) as unknown as { marker: boolean })
      .marker,
    true,
  );
  assert.equal(db.objectStoreNames.contains("jobs"), true);
  assert.equal(
    db.transaction("chunks").store.indexNames.contains("rawLength"),
    true,
  );
  db.close();
  const merged = await write(state);
  assert.equal(merged.vaultEpoch, 7);
  assert.equal(merged.locale, "zh-CN");
  assert.ok(merged.excludedFileNames.length > 0);
});

test("caller roles require exact extension paths, top frame, origin and normal mode", () => {
  const previous = globalThis.chrome;
  Object.assign(globalThis, { chrome: { runtime: { id: "test-extension" } } });
  try {
    assert.equal(
      identify({
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
        documentId: "ui",
        frameId: 0,
      } as chrome.runtime.MessageSender).caller.kind,
      "ui",
    );
    assert.equal(
      identify({
        id: "test-extension",
        url: "chrome-extension://test-extension/popup.html",
        documentId: "popup",
      } as chrome.runtime.MessageSender).caller.kind,
      "ui",
    );
    assert.throws(
      () =>
        identify({
          id: "test-extension",
          url: "invalid",
          documentId: "ui",
          frameId: 0,
        } as chrome.runtime.MessageSender),
      /E_UNAUTHORISED/,
    );
    assert.throws(
      () =>
        identify({
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
          frameId: 0,
        } as chrome.runtime.MessageSender),
      /E_UNAUTHORISED/,
    );
    assert.throws(
      () =>
        identify({
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
          documentId: "ui",
          frameId: 1,
        } as chrome.runtime.MessageSender),
      /E_UNAUTHORISED/,
    );
    assert.throws(
      () =>
        identify({
          id: "test-extension",
          url: "chrome-extension://test-extension/evil.html",
        } as chrome.runtime.MessageSender),
      /E_UNAUTHORISED/,
    );
    assert.equal(
      identify({
        id: "test-extension",
        url: "https://example.com/a",
        origin: "https://example.com",
        frameId: 0,
        documentId: "doc",
        tab: { id: 1 },
      } as chrome.runtime.MessageSender).caller.kind,
      "capture",
    );
    assert.throws(
      () =>
        identify({
          id: "test-extension",
          url: "https://example.com/a",
          origin: "https://example.com",
          frameId: 1,
          documentId: "doc",
          tab: { id: 1 },
        } as chrome.runtime.MessageSender),
      /E_UNAUTHORISED/,
    );
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});

 test("all three language choices persist without changing saved records", async () => {
  await setup();
  const saved = await save(new Uint8Array([1, 2, 3]));
  for (const [revision, locale] of (["en-GB", "zh-TW", "zh-CN"] as const).entries()) {
    await setSettings(revision, { locale }, 0);
    const runtime = await write((tx) => state(tx));
    assert.equal(runtime.locale, locale);
    assert.ok(await getRecordForLocaleTest(saved.recordId!));
  }
});
async function getRecordForLocaleTest(recordId: string) {
  const db = await database();
  try { return await db.get("records", recordId); } finally { db.close(); }
}
