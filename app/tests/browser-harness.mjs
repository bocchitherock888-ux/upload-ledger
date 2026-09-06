import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

export const fixtureRoot = resolve(
  "../spec/UploadLedger_Spec_v1.0.0/testkit/fixtures",
);
export const fixture = (name) => resolve(fixtureRoot, name);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function syntheticFile(name, bytes) {
  assert.equal(basename(name), name);
  const path = resolve(
    await mkdtemp(resolve(tmpdir(), "upload-ledger-fixture-")),
    name,
  );
  await writeFile(path, bytes);
  return path;
}
export async function until(fn, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out waiting for assertion");
}

export async function harness({
  output = "output/acceptance",
  headless = true,
  pregrant = true,
  serve = true,
} = {}) {
  const out = resolve(output);
  await mkdir(out, { recursive: true });
  const evidence = {
    startedAt: new Date().toISOString(),
    results: [],
    limitations: pregrant
      ? [
          "Only the copied test manifest pregrants loopback host permission; native prompt verification is recorded separately.",
        ]
      : [],
  };
  const servers = [];
  let context;
  try {
    for (const port of serve ? [18765, 18766] : []) {
      // Never reuse or terminate an unrelated service on these ports.
      let occupied = false;
      try {
        await fetch(`http://127.0.0.1:${port}/health`);
        occupied = true;
      } catch {}
      if (occupied) throw new Error(`Test port ${port} is already in use`);
      const server = spawn(
        process.execPath,
        [
          "../spec/UploadLedger_Spec_v1.0.0/testkit/server.mjs",
          "--port",
          String(port),
        ],
        { stdio: "pipe" },
      );
      servers.push(server);
      await until(async () => {
        if (server.exitCode !== null) throw new Error("Fixture server stopped");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          return (
            (await response.json()).purpose === "upload-ledger-local-testkit"
          );
        } catch {
          return false;
        }
      }, 10000);
    }
    let extensionPath = resolve("dist");
    if (pregrant) {
      extensionPath = await mkdtemp(
        resolve(tmpdir(), "upload-ledger-extension-"),
      );
      await cp(resolve("dist"), extensionPath, { recursive: true });
      const path = resolve(extensionPath, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.host_permissions = ["http://127.0.0.1/*"];
      await writeFile(path, JSON.stringify(manifest));
    }
    const profile = await mkdtemp(resolve(tmpdir(), "upload-ledger-browser-"));
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless,
      acceptDownloads: true,
      viewport: { width: 1380, height: 950 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    evidence.browser = context.browser().version();
    const errors = [],
      externalRequests = [];
    context.on("request", (request) => {
      if (request.url().startsWith("http")) {
        let owner;
        try {
          owner = request.frame().url();
        } catch {
          owner = "worker";
        }
        if (owner.startsWith("chrome-extension:") || owner === "worker")
          externalRequests.push({
            url: request.url().split("?")[0],
            owner: owner.split("?")[0],
          });
      }
    });
    const app = await context.newPage();
    app.on("pageerror", (error) => errors.push(error.message));
    await app.goto(`chrome-extension://${id}/app.html`);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push("fixture: " + error.message));
    if (serve) await page.goto("http://127.0.0.1:18765/");
    const all = (store) =>
      app.evaluate(async (store) => {
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open("upload-ledger");
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        try {
          return await new Promise((res, rej) => {
            const req = db.transaction(store).objectStore(store).getAll();
            req.onsuccess = () =>
              res(
                store === "chunks"
                  ? req.result.map((row) => ({
                      ...row,
                      bytes: Array.from(new Uint8Array(row.bytes)),
                    }))
                  : req.result,
              );
            req.onerror = () => rej(req.error);
          });
        } finally {
          db.close();
        }
      }, store);
    const command = async (type, payload = {}, epoch) => {
      if (epoch === undefined && type !== "UI_GET_RUNTIME_STATE")
        epoch = (await command("UI_GET_RUNTIME_STATE", {}, null)).vaultEpoch;
      const response = await app.evaluate(
        async ({ type, payload, epoch }) =>
          chrome.runtime.sendMessage({
            v: 1,
            requestId: crypto.randomUUID(),
            vaultEpoch: epoch ?? null,
            type,
            payload,
          }),
        { type, payload, epoch },
      );
      if (!response?.ok)
        throw Object.assign(
          new Error(response?.error?.code ?? "Missing response"),
          { response },
        );
      return response.data;
    };
    const records = () => all("records");
    const select = async (selector, files, opts = {}) => {
      const before = new Set((await records()).map((r) => r.recordId));
      const paths = await Promise.all(
        (Array.isArray(files) ? files : [files]).map((file) =>
          typeof file === "string"
            ? fixture(file)
            : syntheticFile(file.name, file.buffer),
        ),
      );
      await page.locator(selector).setInputFiles(paths);
      return until(async () => {
        const newer = (await records()).filter((r) => !before.has(r.recordId));
        return newer.length ===
          (opts.count ?? (Array.isArray(files) ? files.length : 1)) &&
          newer.every(
            (r) =>
              !["capturing", "queued", "finalising"].includes(r.snapshot.state),
          )
          ? newer
          : false;
      }, opts.timeout ?? 60000);
    };
    const check = async (name, ids, fn) => {
      const start = Date.now();
      try {
        const details = await fn();
        evidence.results.push({
          name,
          ids,
          status: "passed",
          durationMs: Date.now() - start,
          ...(details ? { details } : {}),
        });
        console.log("PASS", name);
      } catch (error) {
        evidence.results.push({
          name,
          ids,
          status: "failed",
          durationMs: Date.now() - start,
          error: String(error.stack ?? error),
        });
        throw error;
      }
    };
    const close = async (error) => {
      if (error) {
        evidence.status = "failed";
        evidence.error = String(error.stack ?? error);
        await app
          .screenshot({ path: resolve(out, "failure.png"), fullPage: true })
          .catch(() => {});
        await writeFile(
          resolve(out, "failure-state.json"),
          JSON.stringify(
            {
              records: await all("records"),
              sessions: await all("sessions"),
              siteLog: await page
                .locator("#log")
                .innerText({ timeout: 500 })
                .catch(() => null),
            },
            null,
            2,
          ),
        ).catch(() => {});
        console.error(error);
      } else evidence.status = "passed";
      evidence.pageErrors = errors;
      evidence.externalRequests = externalRequests;
      await writeFile(
        resolve(out, "results.json"),
        JSON.stringify(evidence, null, 2),
      );
      await context.close();
      for (const server of servers) server.kill();
    };
    return {
      context,
      app,
      page,
      id,
      evidence,
      errors,
      externalRequests,
      out,
      all,
      records,
      command,
      select,
      check,
      close,
    };
  } catch (error) {
    await context?.close();
    for (const server of servers) server.kill();
    throw error;
  }
}
