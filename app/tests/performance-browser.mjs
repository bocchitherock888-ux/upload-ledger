import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { harness, until, delay, fixture } from "./browser-harness.mjs";

const h = await harness({ output: "output/performance" });
let error;
try {
  await h.command("UI_SET_SITE_POLICY", {
    origin: "http://127.0.0.1:18765",
    enabled: true,
    dropEnabled: false,
    locationMode: "origin_path",
    saveTitle: true,
  });
  await h.check(
    "50 MiB normal copy and 200 MiB sequential batch preserve every byte",
    ["T014", "T054"],
    async () => {
      const paths = [],
        hashes = [];
      const folder = await mkdtemp(resolve(tmpdir(), "upload-ledger-batch-"));
      for (let i = 0; i < 4; i++) {
        const bytes = Buffer.alloc(50 * 1024 * 1024, 51 + i);
        const path = resolve(folder, `batch-${i}.bin`);
        await writeFile(path, bytes);
        paths.push(path);
        hashes.push(createHash("sha256").update(bytes).digest("hex"));
      }
      const samples = [];
      const sample = async () => {
        const values = await Promise.all(
          [h.app, h.page].map((page) =>
            page.evaluate(() => performance.memory?.usedJSHeapSize ?? null),
          ),
        );
        samples.push(values);
      };
      await sample();
      const timer = setInterval(() => void sample().catch(() => {}), 500);
      const start = Date.now();
      await h.page.locator("#multiple").setInputFiles(paths);
      let firstMs;
      await until(async () => {
        const records = await h.records();
        if (
          firstMs === undefined &&
          records.some((r) => r.snapshot.state === "ready")
        )
          firstMs = Date.now() - start;
        return (
          records.length === 4 &&
          records.every((r) => r.snapshot.state === "ready")
        );
      }, 240000);
      clearInterval(timer);
      await sample();
      const records = await h.records();
      assert.equal(new Set(records.map((r) => r.batchId)).size, 1);
      assert.deepEqual(
        records.map((r) => r.snapshot.objectSha256).sort(),
        hashes.sort(),
      );
      const used = await h.command("UI_GET_DIAGNOSTICS");
      assert.equal(used.usage.usedBytes, 200 * 1024 * 1024);
      return {
        batchBytes: 200 * 1024 * 1024,
        totalMs: Date.now() - start,
        first50MiBMs: firstMs,
        normal50MiBTargetMs: 15000,
        jsHeapPeakBytes: {
          app: Math.max(...samples.map((s) => s[0] ?? 0)),
          page: Math.max(...samples.map((s) => s[1] ?? 0)),
        },
        memoryObservation:
          "Chrome performance.memory samples of page/UI JS heaps; excludes browser native buffers, PDF worker and service-worker process. Full process RSS target remains separately unverified.",
      };
    },
  );
  await h.check(
    "Oversized file yields metadata only; directory input is skipped",
    ["T014", "T046", "T057"],
    async () => {
      const folder = await mkdtemp(
        resolve(tmpdir(), "upload-ledger-boundary-"),
      );
      const tooLarge = resolve(folder, "too-large.bin");
      await writeFile(tooLarge, Buffer.alloc(50 * 1024 * 1024 + 1, 19));
      const before = (await h.records()).length;
      await h.page.locator("#single").setInputFiles(tooLarge);
      const record = await until(async () =>
        (await h.records()).find((r) => r.file.name === "too-large.bin"),
      );
      assert.equal(record.snapshot.state, "metadata_only");
      assert.equal(record.snapshot.objectSha256, null);
      const directory = await h.page.evaluateHandle(() => {
        const input = document.createElement("input");
        input.type = "file";
        input.webkitdirectory = true;
        document.body.append(input);
        return input;
      });
      await directory.setInputFiles(folder);
      await delay(350);
      assert.equal((await h.records()).length, before + 1);
    },
  );
  await h.check(
    "Ten thousand metadata records search and render without loading originals",
    ["T041", "T042"],
    async () => {
      const challenge = await h.command("UI_REQUEST_CLEAR_CHALLENGE");
      await h.command("UI_CLEAR_ALL", { challenge: challenge.challenge });
      await h.app.evaluate(async () => {
        const db = await new Promise((res) => {
          const request = indexedDB.open("upload-ledger");
          request.onsuccess = () => res(request.result);
        });
        const tx = db.transaction("records", "readwrite");
        for (let i = 0; i < 10000; i++)
          tx.objectStore("records").put({
            recordId: crypto.randomUUID(),
            batchId: crypto.randomUUID(),
            observedAt: "2026-09-06T10:00:00.000Z",
            source: "manual_snapshot",
            page: null,
            file: {
              name: `benchmark-${String(i).padStart(5, "0")}.txt`,
              byteLength: 60000000,
              declaredMime: "text/plain",
              lastModified: 0,
            },
            snapshot: {
              state: "metadata_only",
              objectSha256: null,
              capturedAt: null,
              errorCode: "E_FILE_TOO_LARGE",
            },
            submission: { state: "unknown", updatedAt: null },
            user: {
              label: null,
              note: "Synthetic performance fixture",
              tags: [],
              pinned: false,
            },
            revision: 0,
            importedAt: null,
            importJobId: null,
          });
        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
      });
      await h.app.reload();
      await h.app
        .getByRole("checkbox", { name: "我了解文件与备份未加密" })
        .check();
      await h.app
        .getByRole("button", { name: "进入资料库", exact: true })
        .click();
      await until(
        async () => (await h.app.locator(".record-row").count()) === 100,
      );
      const times = [];
      for (let i = 0; i < 10; i++) {
        const term = `benchmark-${String(i * 997).padStart(5, "0")}.txt`;
        const start = Date.now();
        await h.app.getByRole("searchbox").fill(term);
        await until(
          async () =>
            (await h.app.locator(".record-row").count()) === 1 &&
            (await h.app.locator(".record-open").innerText()).includes(term),
        );
        times.push(Date.now() - start);
      }
      times.sort((a, b) => a - b);
      return {
        records: 10000,
        samplesMs: times,
        p50Ms: times[4],
        p95Ms: times[9],
        targetMs: 500,
        measurement:
          "UI search input to rendered result, including 180 ms debounce and 100 ms sampling interval",
      };
    },
  );
} catch (e) {
  error = e;
  process.exitCode = 1;
}
await h.close(error);
