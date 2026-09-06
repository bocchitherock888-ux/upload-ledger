import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  harness,
  fixture,
  delay,
  until,
  syntheticFile,
} from "./browser-harness.mjs";

const h = await harness();
const { app, page, context, command, records, all, check, select } = h;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const policy = (extra = {}) => ({
  origin: "http://127.0.0.1:18765",
  enabled: true,
  dropEnabled: false,
  locationMode: "origin_path",
  saveTitle: true,
  ...extra,
});
const terminal = (record) =>
  !["queued", "capturing", "finalising"].includes(record.snapshot.state);
let error;
try {
  await until(async () =>
    Number.isInteger(
      (await command("UI_GET_RUNTIME_STATE", {}, null)).vaultEpoch,
    ),
  );
  await check("Fresh installation captures nothing", ["T001"], async () => {
    await page.locator("#single").setInputFiles(fixture("binary.dat"));
    await delay(350);
    for (const store of ["records", "sessions", "chunks", "sites"])
      assert.equal((await all(store)).length, 0);
  });
  await check(
    "Enable exact origin injects immediately into already open page",
    ["T002", "T062"],
    async () => {
      await command("UI_SET_SITE_POLICY", policy());
      const registered = await app.evaluate(() =>
        chrome.scripting.getRegisteredContentScripts(),
      );
      assert.equal(registered.length, 1);
      const [record] = await select("#single", "v1/proposal.txt");
      assert.equal(record.snapshot.state, "ready");
      assert.equal(
        record.snapshot.objectSha256,
        hash(await readFile(fixture("v1/proposal.txt"))),
      );
      const other = await context.newPage();
      await other.goto("http://127.0.0.1:18766/");
      await delay(200);
      const before = (await records()).length;
      await other.locator("#single").setInputFiles(fixture("binary.dat"));
      await delay(400);
      assert.equal((await records()).length, before);
      await other.close();
    },
  );
  await check(
    "Trusted capture preserves website raw upload digest and unknown submission",
    ["T009", "T055", "T056"],
    async () => {
      await page.locator("#autoUpload").check();
      const [record] = await select("#single", "v2/proposal.txt");
      const expected = hash(await readFile(fixture("v2/proposal.txt")));
      await until(async () =>
        (await page.locator("#log").innerText()).includes(expected),
      );
      assert.match(await page.locator("#log").innerText(), /"isTrusted":true/);
      assert.equal(record.snapshot.objectSha256, expected);
      assert.equal(record.submission.state, "unknown");
      await page.locator("#autoUpload").uncheck();
    },
  );
  await check(
    "Multiple, hidden, dynamic, immediate reset and removal inputs",
    ["T003", "T004"],
    async () => {
      const multi = await select("#multiple", [
        "binary.dat",
        "unicode-notes.txt",
      ]);
      assert.equal(new Set(multi.map((r) => r.batchId)).size, 1);
      for (const [selector, name] of [
        ["#hidden", "sample.png"],
        ["#reset", "binary.dat"],
        ["#remove", "unicode-notes.txt"],
      ]) {
        const [record] = await select(selector, name);
        assert.equal(
          record.snapshot.objectSha256,
          hash(await readFile(fixture(name))),
        );
      }
      assert.equal(await page.locator("#reset").inputValue(), "");
      assert.equal(await page.locator("#remove").count(), 0);
      await page.locator("#dynamicButton").click();
      const [dynamic] = await select("[id^=dynamic-]", "empty.txt");
      assert.equal(dynamic.snapshot.state, "ready");
    },
  );
  await check(
    "Zero bytes, exact chunk and final partial chunk",
    ["T058"],
    async () => {
      for (const size of [0, 262144, 262145]) {
        const bytes = Buffer.alloc(size, 71);
        const [record] = await select("#single", {
          name: `boundary-${size}.bin`,
          mimeType: "application/octet-stream",
          buffer: bytes,
        });
        assert.equal(record.snapshot.objectSha256, hash(bytes));
        const object = (await all("objects")).find(
          (o) => o.sha256 === hash(bytes),
        );
        assert.equal(object.chunkCount, Math.ceil(size / 262144));
      }
    },
  );
  await check(
    "Same-name versions remain distinct; alias deduplicates bytes",
    ["T005", "T006"],
    async () => {
      const [one] = await select("#single", "v1/proposal.txt");
      const [two] = await select("#single", "v2/proposal.txt");
      assert.notEqual(one.snapshot.objectSha256, two.snapshot.objectSha256);
      const bytes = await readFile(fixture("v1/proposal.txt"));
      await select("#single", {
        name: "alias-proposal.txt",
        mimeType: "text/plain",
        buffer: bytes,
      });
      const refs = (await records()).filter(
        (r) => r.snapshot.objectSha256 === hash(bytes),
      );
      const objects = (await all("objects")).filter(
        (o) => o.sha256 === hash(bytes),
      );
      assert.equal(objects.length, 1);
      assert.equal(objects[0].refCount, refs.length);
    },
  );
  await check(
    "Synthetic input and sensitive names persist no data",
    ["T056", "T071"],
    async () => {
      const counts = await Promise.all(
        ["records", "sessions", "chunks"].map(
          async (store) => (await all(store)).length,
        ),
      );
      await page.locator("#syntheticButton").click();
      await delay(250);
      await page
        .locator("#single")
        .setInputFiles(
          await syntheticFile(
            ".env.production",
            Buffer.from("SYNTHETIC_SECRET=TEST_ONLY"),
          ),
        );
      await delay(350);
      assert.deepEqual(
        await Promise.all(
          ["records", "sessions", "chunks"].map(
            async (store) => (await all(store)).length,
          ),
        ),
        counts,
      );
    },
  );
  await check(
    "SPA context removes token and uses selection-time route",
    ["T039", "T040"],
    async () => {
      await page.locator("#routeButton").click();
      const [record] = await select("#single", "sample.png");
      assert.equal(
        record.page.location,
        "http://127.0.0.1:18765/apply/student-example",
      );
      assert.equal(JSON.stringify(record).includes("DUMMY_ONLY"), false);
      await command(
        "UI_SET_SITE_POLICY",
        policy({ saveTitle: false, locationMode: "origin_only" }),
      );
      const [originOnly] = await select("#single", "empty.txt");
      assert.equal(originOnly.page.location, policy().origin);
      assert.equal(originOnly.page.title, null);
      await command("UI_SET_SITE_POLICY", policy());
    },
  );
  await check(
    "Open shadow capture and iframe isolation",
    ["T019"],
    async () => {
      const [record] = await select("#open-shadow-input", "binary.dat");
      assert.equal(record.source, "standard_input");
      const frame = page
        .frames()
        .find(
          (frame) =>
            frame.url().endsWith("/frame.html") &&
            frame.url().includes(":18765"),
        );
      if (!frame) throw new Error("Same-origin fixture frame missing");
      const before = (await records()).length;
      await frame
        .locator("input[type=file]")
        .setInputFiles(fixture("sample.png"));
      await delay(400);
      assert.equal((await records()).length, before);
    },
  );
  await check(
    "Trusted native drag protocol obeys opt-in and leaves website handler working",
    ["T017", "T018"],
    async () => {
      const box = await page.locator("#dropZone").boundingBox();
      assert.ok(box);
      const cdp = await context.newCDPSession(page);
      const drag = async () => {
        for (const type of ["dragEnter", "dragOver", "drop"])
          await cdp.send("Input.dispatchDragEvent", {
            type,
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
            data: {
              items: [],
              files: [fixture("binary.dat")],
              dragOperationsMask: 1,
            },
          });
      };
      const before = (await records()).length;
      await drag();
      await delay(400);
      assert.equal((await records()).length, before);
      await command("UI_SET_SITE_POLICY", policy({ dropEnabled: true }));
      await page.locator("#dropChange").check();
      await drag();
      await until(async () =>
        (await records()).some(
          (r) => r.source === "user_drop" && r.snapshot.state === "ready",
        ),
      );
      await delay(350);
      assert.equal((await records()).length, before + 1);
      assert.match(
        await page.locator("#log").innerText(),
        /"event":"drop","isTrusted":true/,
      );
      await cdp.detach();
    },
  );
  await check(
    "Paused capture stops while user status and manual capture remain available",
    ["T008", "T010", "T022", "T047", "T067"],
    async () => {
      await command("UI_SET_GLOBAL_PAUSE", { paused: true });
      const before = (await records()).length;
      await page.locator("#single").setInputFiles(fixture("sample.png"));
      await delay(350);
      assert.equal((await records()).length, before);
      const target = (await records()).find(
        (r) => r.snapshot.state === "ready",
      );
      await command("UI_SET_SUBMISSION", {
        records: [
          { recordId: target.recordId, expectedRevision: target.revision },
        ],
        state: "user_confirmed",
        note: "Synthetic confirmation",
      });
      await assert.rejects(
        () =>
          command("UI_SET_SUBMISSION", {
            records: [
              { recordId: target.recordId, expectedRevision: target.revision },
            ],
            state: "user_reported_failed",
            note: null,
          }),
        /CONFLICT/,
      );
      const payload = {
        batchEventId: randomUUID(),
        page: null,
        files: [
          {
            clientFileId: randomUUID(),
            name: "manual-empty.txt",
            byteLength: 0,
            declaredMime: "text/plain",
            lastModified: 0,
          },
        ],
      };
      const begun = await command("UI_MANUAL_BEGIN", payload);
      const file = begun.files[0];
      await command("UI_MANUAL_FINISH", {
        sessionId: file.sessionId,
        token: file.token,
      });
      const manual = (await records()).find(
        (r) => r.recordId === file.recordId,
      );
      assert.equal(manual.source, "manual_snapshot");
      assert.equal(manual.snapshot.objectSha256, hash(Buffer.alloc(0)));
      assert.equal(manual.submission.state, "unknown");
      await command("UI_SET_GLOBAL_PAUSE", { paused: false });
    },
  );
  await check(
    "Real worker termination during 50 MiB copy resumes without duplicate bytes",
    ["T012", "T054"],
    async () => {
      const bytes = Buffer.alloc(50 * 1024 * 1024, 37);
      const path = resolve(
        await mkdtemp(resolve(tmpdir(), "upload-ledger-large-")),
        "large-50MiB.bin",
      );
      await writeFile(path, bytes);
      const start = Date.now();
      await page.locator("#single").setInputFiles(path);
      await until(async () =>
        (await all("sessions")).some(
          (s) =>
            s.status === "capturing" &&
            s.receivedBytes > 0 &&
            s.receivedBytes < bytes.length,
        ),
      );
      const cdp = await context.newCDPSession(app);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      const record = await until(
        async () =>
          (await records()).find(
            (r) => r.file.name === "large-50MiB.bin" && terminal(r),
          ),
        120000,
      );
      assert.equal(record.snapshot.state, "ready");
      assert.equal(record.snapshot.objectSha256, hash(bytes));
      const object = (await all("objects")).find(
        (o) => o.sha256 === hash(bytes),
      );
      assert.equal(object.chunkCount, 200);
      await cdp.detach();
      return {
        bytes: bytes.length,
        durationMs: Date.now() - start,
        sha256: hash(bytes),
        performanceTargetMs: 15000,
        faultInjection: true,
      };
    },
  );
  await check(
    "Site revoke during capture aborts pending data and preserves prior ready records",
    ["T007"],
    async () => {
      const readyBefore = (await records())
        .filter((r) => r.snapshot.state === "ready")
        .map((r) => r.recordId);
      const bytes = Buffer.alloc(8 * 1024 * 1024, 81);
      await page
        .locator("#single")
        .setInputFiles(await syntheticFile("revoke-in-flight.bin", bytes));
      await until(async () =>
        (await records()).some((r) => r.file.name === "revoke-in-flight.bin"),
      );
      await command("UI_SET_SITE_POLICY", policy({ enabled: false }));
      await until(async () => {
        const record = (await records()).find(
          (r) => r.file.name === "revoke-in-flight.bin",
        );
        return record && terminal(record);
      });
      const after = await records();
      const stopped = after.find((r) => r.file.name === "revoke-in-flight.bin");
      assert.notEqual(stopped.snapshot.state, "ready");
      assert.equal(stopped.snapshot.objectSha256, null);
      for (const id of readyBefore)
        assert.equal(
          after.find((r) => r.recordId === id).snapshot.state,
          "ready",
        );
    },
  );
  await check(
    "Preview lease blocks deletion; ending it permits reference-safe deletion",
    ["T035", "T036"],
    async () => {
      const list = await records();
      const target = list.find((r) => r.file.name === "alias-proposal.txt");
      const object = (await all("objects")).find(
        (o) => o.sha256 === target.snapshot.objectSha256,
      );
      const job = await command("UI_PREPARE_PREVIEW", {
        recordId: target.recordId,
      });
      await assert.rejects(
        () =>
          command("UI_DELETE_RECORDS", {
            records: [
              { recordId: target.recordId, expectedRevision: target.revision },
            ],
          }),
        /OBJECT_IN_USE/,
      );
      await command("UI_END_JOB", { jobId: job.jobId, outcome: "cancelled" });
      await command("UI_DELETE_RECORDS", {
        records: [
          { recordId: target.recordId, expectedRevision: target.revision },
        ],
      });
      const kept = (await all("objects")).find(
        (o) => o.sha256 === object.sha256,
      );
      assert.equal(kept.refCount, object.refCount - 1);
    },
  );
  await check(
    "Diagnostics contain technical counts without user metadata",
    ["T033"],
    async () => {
      const text = JSON.stringify(await command("UI_GET_DIAGNOSTICS"));
      for (const forbidden of [
        "proposal",
        "student-example",
        "Synthetic confirmation",
        "127.0.0.1",
        "token",
        "documentId",
      ])
        assert.equal(text.includes(forbidden), false, forbidden);
    },
  );
  await check(
    "Clear challenge invalidates old epoch and removes all local data",
    ["T038", "T059"],
    async () => {
      const epoch = (await command("UI_GET_RUNTIME_STATE", {}, null))
        .vaultEpoch;
      const pending = await command("UI_MANUAL_BEGIN", {
        batchEventId: randomUUID(),
        page: null,
        files: [
          {
            clientFileId: randomUUID(),
            name: "pending-clear.bin",
            byteLength: 100,
            declaredMime: "",
            lastModified: 0,
          },
        ],
      });
      await assert.rejects(() =>
        command("UI_CLEAR_ALL", { challenge: "not-a-valid-challenge" }),
      );
      const challenge = await command("UI_REQUEST_CLEAR_CHALLENGE");
      await command("UI_CLEAR_ALL", { challenge: challenge.challenge });
      await until(async () => (await records()).length === 0);
      for (const store of [
        "records",
        "objects",
        "chunks",
        "sessions",
        "jobs",
        "imports",
        "sites",
      ])
        assert.equal((await all(store)).length, 0, store);
      await assert.rejects(
        () =>
          command(
            "UI_MANUAL_FINISH",
            {
              sessionId: pending.files[0].sessionId,
              token: pending.files[0].token,
            },
            epoch,
          ),
        /VAULT_EPOCH|SESSION/,
      );
    },
  );
  await check(
    "Extension contexts made no external network requests",
    ["T034"],
    async () => {
      assert.deepEqual(h.externalRequests, []);
      assert.deepEqual(h.errors, []);
    },
  );
} catch (e) {
  error = e;
  process.exitCode = 1;
}
await h.close(error);
