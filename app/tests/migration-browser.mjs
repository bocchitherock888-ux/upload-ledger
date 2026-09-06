// Real same-path extension update test. Input is our previously built M0 ZIP.
import { chromium } from "playwright";
import { mkdtemp, mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { until, fixture } from "./browser-harness.mjs";

const archive = resolve(
  process.argv[2] ?? "tests/fixtures/migration-v0.1.0.zip",
);
const folder = await mkdtemp(resolve(tmpdir(), "upload-ledger-update-"));
const extension = resolve(folder, "extension"),
  profile = resolve(folder, "profile");
await mkdir(extension);
await mkdir(profile);
await mkdir("output/migration", { recursive: true });
execFileSync("python3", [
  "-c",
  "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
  archive,
  extension,
]);
const manifestPath = resolve(extension, "manifest.json");
const old = JSON.parse(await readFile(manifestPath, "utf8"));
old.host_permissions = ["http://127.0.0.1/*"];
await writeFile(manifestPath, JSON.stringify(old));
const server = spawn(
  process.execPath,
  ["../spec/UploadLedger_Spec_v1.0.0/testkit/server.mjs", "--port", "18765"],
  { stdio: "pipe" },
);
let context;
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1380, height: 950 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
const result = { startedAt: new Date().toISOString(), from: old.version };
try {
  await until(async () => {
    if (server.exitCode !== null) throw new Error("Test port busy");
    try {
      return (await (await fetch("http://127.0.0.1:18765/health")).json()).ok;
    } catch {
      return false;
    }
  });
  context = await launch();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  let app = await context.newPage();
  await app.goto(`chrome-extension://${id}/app.html`);
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:18765/");
  const command = (type, payload = {}) =>
    app.evaluate(
      async ({ type, payload }) => {
        const state = await chrome.runtime.sendMessage({
          v: 1,
          requestId: crypto.randomUUID(),
          vaultEpoch: null,
          type: "UI_GET_RUNTIME_STATE",
          payload: {},
        });
        return chrome.runtime.sendMessage({
          v: 1,
          requestId: crypto.randomUUID(),
          vaultEpoch: state.data.vaultEpoch,
          type,
          payload,
        });
      },
      { type, payload },
    );
  await command("UI_SET_SITE_POLICY", {
    origin: "http://127.0.0.1:18765",
    enabled: true,
    dropEnabled: false,
    locationMode: "origin_path",
    saveTitle: true,
  });
  await page.reload();
  const read = () =>
    app.evaluate(async () => {
      const db = await new Promise((res) => {
        const req = indexedDB.open("upload-ledger");
        req.onsuccess = () => res(req.result);
      });
      const records = await new Promise((res) => {
        const req = db.transaction("records").objectStore("records").getAll();
        req.onsuccess = () => res(req.result);
      });
      const version = db.version;
      db.close();
      return { records, version };
    });
  await page.locator("#single").setInputFiles(fixture("v1/proposal.txt"));
  const before = await until(async () => {
    const data = await read();
    return data.records.length === 1 &&
      data.records[0].snapshot.state === "ready"
      ? data
      : false;
  });
  assert.equal(before.version, 1);
  await context.close();
  await cp(resolve("dist"), extension, { recursive: true });
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  result.to = current.version;
  context = await launch();
  const nextWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  assert.equal(new URL(nextWorker.url()).host, id);
  app = await context.newPage();
  await app.goto(`chrome-extension://${id}/app.html`);
  const after = await until(async () => {
    const data = await read();
    return data.version === 2 ? data : false;
  });
  assert.equal(after.version, 2);
  assert.deepEqual(after.records, before.records);
  const objects = await app.evaluate(async () => {
    const db = await new Promise((res) => {
      const req = indexedDB.open("upload-ledger");
      req.onsuccess = () => res(req.result);
    });
    const all = (store) =>
      new Promise((res) => {
        const req = db.transaction(store).objectStore(store).getAll();
        req.onsuccess = () => res(req.result);
      });
    const objects = await all("objects"),
      chunks = await all("chunks");
    db.close();
    return {
      objects,
      chunks: chunks.map((row) => ({
        ...row,
        bytes: Array.from(new Uint8Array(row.bytes)),
      })),
    };
  });
  for (const object of objects.objects) {
    const bytes = Buffer.concat(
      objects.chunks
        .filter((chunk) => chunk.payloadId === object.payloadId)
        .sort((a, b) => a.index - b.index)
        .map((chunk) => Buffer.from(chunk.bytes)),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      object.sha256,
    );
  }
  result.status = "passed";
  result.databaseVersion = after.version;
  result.records = after.records.length;
  result.sameExtensionId = true;
  result.browser = context.browser().version();
  console.log(
    "PASS same-ID M0 database update preserves metadata and original SHA",
  );
} catch (error) {
  result.status = "failed";
  result.error = String(error.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  server.kill();
  await writeFile(
    "output/migration/results.json",
    JSON.stringify(result, null, 2),
  );
}
