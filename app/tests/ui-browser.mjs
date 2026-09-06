import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { harness, fixture, until, delay } from "./browser-harness.mjs";

const h = await harness({ output: "output/ui-browser", serve: false });
const { app, command, records, all, check, context, out } = h;
let second, error;
const click = (name) => app.getByRole("button", { name, exact: true }).click();
const open = async (name) => {
  await app.locator(".record-open").filter({ hasText: name }).first().click();
  await until(async () =>
    (await app.locator(".detail-panel h2").innerText()).includes(name),
  );
};
const detail = () => app.locator(".detail-panel");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const onboard = async (page) => {
  await page.getByRole("checkbox", { name: "我了解本地明文存储范围" }).check();
  await page.getByRole("button", { name: "进入资料库", exact: true }).click();
  await page.getByRole("button", { name: "网站权限", exact: true }).waitFor();
};
const manual = async (files) => {
  const before = new Set((await records()).map((r) => r.recordId));
  await app
    .getByRole("button", { name: "手动留底", exact: true })
    .first()
    .click();
  const modal = app.getByRole("dialog");
  await modal.getByLabel("选择文件", { exact: true }).setInputFiles(files);
  await modal
    .getByLabel("来源地址（可选）")
    .fill("https://portal.example/applications/2026?token=SYNTHETIC#preview");
  await modal.getByLabel("页面标题（可选）").fill("示例申请 · 附件");
  await modal.getByRole("button", { name: "开始留底", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  return until(async () => {
    const added = (await records()).filter((r) => !before.has(r.recordId));
    return added.length === files.length &&
      added.every((r) => r.snapshot.state === "ready")
      ? added
      : false;
  });
};
try {
  await check(
    "Onboarding requires explicit local plaintext acknowledgement",
    ["T052"],
    async () => {
      const button = app.getByRole("button", {
        name: "进入资料库",
        exact: true,
      });
      await button.waitFor();
      assert.equal(await button.isDisabled(), true);
      await app.screenshot({
        path: resolve(out, "01-onboarding.png"),
        fullPage: true,
        animations: "disabled",
      });
      await onboard(app);
    },
  );
  await check(
    "Denied site permission leaves the site disabled",
    ["T002"],
    async () => {
      await click("网站权限");
      await app.evaluate(() => {
        window.__originalRequest = chrome.permissions.request;
        chrome.permissions.request = async () => false;
      });
      try {
        await app
          .getByLabel("网站地址", { exact: true })
          .fill("https://example.com");
        await click("在此站点启用");
        await app.getByRole("alert").waitFor();
        assert.equal((await all("sites")).length, 0);
      } finally {
        await app.evaluate(() => {
          chrome.permissions.request = window.__originalRequest;
          delete window.__originalRequest;
        });
      }
      await click("附件资料库");
      return {
        permissionResponse:
          "injected false; native grant and revoke tested separately",
      };
    },
  );
  await check(
    "Manual UI saves multiple real files with current time and clean source",
    ["T047"],
    async () => {
      const before = Date.now();
      const created = await manual([
        fixture("v1/proposal.txt"),
        fixture("sample.png"),
        fixture("unicode-notes.txt"),
        fixture("active-content.html"),
        fixture("active-content.svg"),
        resolve("tests/fixtures/synthetic-preview.pdf"),
        resolve("tests/fixtures/synthetic-over-limit.pdf"),
      ]);
      for (const record of created) {
        assert.equal(record.source, "manual_snapshot");
        assert.ok(Date.parse(record.observedAt) >= before);
        assert.equal(
          record.page.location,
          "https://portal.example/applications/2026",
        );
        assert.equal(record.submission.state, "unknown");
      }
      assert.equal((await records()).length, 7);
    },
  );
  await check(
    "Details preview inert text and download preserves exact original",
    ["T023", "T024", "T032", "T043"],
    async () => {
      await open("proposal.txt");
      await detail().locator(".text-preview pre").waitFor();
      assert.equal(
        await detail().locator(".text-preview pre").innerText(),
        await readFile(fixture("v1/proposal.txt"), "utf8"),
      );
      const pending = app.waitForEvent("download");
      await detail()
        .getByRole("button", { name: "下载当次副本", exact: true })
        .click();
      const download = await pending;
      const saved = resolve(out, "proposal-original.txt");
      await download.saveAs(saved);
      assert.deepEqual(
        await readFile(saved),
        await readFile(fixture("v1/proposal.txt")),
      );
      for (const name of ["active-content.html", "active-content.svg"]) {
        await open(name);
        await detail().locator(".text-preview pre").waitFor();
        assert.ok(
          (await detail().locator(".text-preview pre").innerText()).includes(
            "<",
          ),
        );
        assert.equal(
          await detail().locator("iframe,object,embed,svg script").count(),
          0,
        );
      }
      await open("sample.png");
      await until(async () =>
        detail()
          .locator(".image-preview img")
          .evaluate((image) => image.complete && image.naturalWidth > 0),
      );
      await app.screenshot({
        path: resolve(out, "02-image-preview.png"),
        fullPage: true,
        animations: "disabled",
      });
    },
  );
  await check(
    "Local PDF renderer displays pages offline and bounds 501-page documents",
    ["T025", "T034", "T043"],
    async () => {
      await context.setOffline(true);
      await open("synthetic-preview.pdf");
      const canvas = detail().locator("canvas");
      await until(
        async () =>
          canvas.count() &&
          canvas.evaluate((c) => c.width > 300 && c.height > 300),
      );
      await detail()
        .getByRole("button", { name: "下一页", exact: true })
        .click();
      await until(async () =>
        (await detail().locator(".preview-tools").innerText()).includes(
          "2 / 2",
        ),
      );
      assert.equal(
        await app.evaluate(() => Boolean(globalThis.__UL_PDF_RAN)),
        false,
      );
      await app.screenshot({
        path: resolve(out, "03-pdf-preview.png"),
        fullPage: true,
        animations: "disabled",
      });
      await open("synthetic-over-limit.pdf");
      await detail()
        .getByText("预览暂不可用，原件仍可下载。", { exact: true })
        .waitFor();
      assert.equal(
        await detail()
          .getByRole("button", { name: "下载当次副本", exact: true })
          .isEnabled(),
        true,
      );
      await context.setOffline(false);
    },
  );
  await check(
    "Editable user fields, submission state, combined search and pinned filters",
    ["T010", "T041", "T067"],
    async () => {
      await open("proposal.txt");
      await detail()
        .getByLabel("显示名称", { exact: true })
        .fill("申请方案 · 初稿");
      await detail()
        .getByLabel("备注", { exact: true })
        .fill("仅供回归测试的虚构附件。<img src=x onerror=alert(1)>");
      await detail()
        .getByLabel("标签（逗号分隔）", { exact: true })
        .fill("申请, 初稿");
      await detail()
        .getByRole("checkbox", { name: "置顶", exact: true })
        .check();
      await detail()
        .getByRole("button", { name: "保存自定义信息", exact: true })
        .click();
      await until(async () =>
        (await records()).some((r) => r.user.label === "申请方案 · 初稿"),
      );
      await detail().locator("select").first().selectOption("user_confirmed");
      await detail()
        .getByRole("button", { name: "保存提交状态", exact: true })
        .click();
      await until(async () =>
        (await records()).some(
          (r) =>
            r.user.label === "申请方案 · 初稿" &&
            r.submission.state === "user_confirmed",
        ),
      );
      await app.getByRole("searchbox").fill("虚构附件");
      await until(async () => (await app.locator(".record-row").count()) === 1);
      await app
        .getByRole("checkbox", { name: "仅看置顶", exact: true })
        .check();
      await until(async () => (await app.locator(".record-row").count()) === 1);
      await click("清除筛选");
      await until(async () => (await app.locator(".record-row").count()) === 7);
      await app.screenshot({
        path: resolve(out, "04-library-details.png"),
        fullPage: true,
        animations: "disabled",
      });
    },
  );
  await check(
    "A concurrent revision preserves unsaved fields and rejects overwriting newer notes",
    ["T067"],
    async () => {
      await open("申请方案 · 初稿");
      const target = (await records()).find(
        (r) => r.user.label === "申请方案 · 初稿",
      );
      const originalNote = target.user.note;
      const noteInput = detail().getByLabel("备注", { exact: true });
      await noteInput.fill("保留的未保存草稿");
      await command("UI_SET_USER_FIELDS", {
        recordId: target.recordId,
        expectedRevision: target.revision,
        fields: { ...target.user, note: "另一窗口的新备注" },
      });
      await app.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await detail()
        .getByRole("button", { name: "放弃编辑并载入最新记录", exact: true })
        .waitFor();
      assert.equal(await noteInput.inputValue(), "保留的未保存草稿");
      await detail()
        .getByRole("button", { name: "保存自定义信息", exact: true })
        .click();
      await until(
        async () =>
          await detail()
            .getByRole("button", { name: "保存自定义信息", exact: true })
            .isEnabled(),
      );
      assert.equal(
        (await records()).find((r) => r.recordId === target.recordId).user.note,
        "另一窗口的新备注",
      );
      assert.equal(await noteInput.inputValue(), "保留的未保存草稿");
      await detail()
        .getByRole("button", { name: "放弃编辑并载入最新记录", exact: true })
        .click();
      assert.equal(await noteInput.inputValue(), "另一窗口的新备注");
      await noteInput.fill(originalNote);
      await detail()
        .getByLabel("网页提交", { exact: true })
        .selectOption("user_reported_failed");
      await detail()
        .getByRole("button", { name: "保存自定义信息", exact: true })
        .click();
      await until(
        async () =>
          await detail()
            .getByRole("button", { name: "保存自定义信息", exact: true })
            .isEnabled(),
      );
      assert.equal(
        (await records()).find((r) => r.recordId === target.recordId).user.note,
        originalNote,
      );
      assert.equal(
        await detail().getByLabel("网页提交", { exact: true }).inputValue(),
        "user_reported_failed",
      );
      await detail()
        .getByRole("button", { name: "保存提交状态", exact: true })
        .click();
      await until(
        async () =>
          !(await detail()
            .getByLabel("网页提交", { exact: true })
            .isDisabled()),
      );
      assert.equal(
        (await records()).find((r) => r.recordId === target.recordId).submission
          .state,
        "user_reported_failed",
      );
      await detail()
        .getByLabel("网页提交", { exact: true })
        .selectOption("user_confirmed");
      await detail()
        .getByRole("button", { name: "保存提交状态", exact: true })
        .click();
      await until(
        async () =>
          !(await detail()
            .getByLabel("网页提交", { exact: true })
            .isDisabled()),
      );
    },
  );
  await check(
    "Text comparison shows deterministic edits and supports current file",
    ["T044", "T045"],
    async () => {
      await open("申请方案 · 初稿");
      await detail().getByRole("button", { name: "比较", exact: true }).click();
      const dialog = app.getByRole("dialog");
      await dialog
        .getByLabel("或选择当前文件")
        .setInputFiles(fixture("v2/proposal.txt"));
      await dialog
        .getByRole("button", { name: "开始比较", exact: true })
        .click();
      await dialog.getByText("文件字节不同", { exact: true }).waitFor();
      assert.ok((await dialog.locator(".diff-add,.diff-remove").count()) > 0);
      await app.screenshot({
        path: resolve(out, "05-compare.png"),
        fullPage: true,
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    },
  );
  let expected;
  const archivePath = resolve(out, "roundtrip.zip");
  await check(
    "Complete backup through production UI is independently valid",
    ["T048", "T063", "T069"],
    async () => {
      await click("备份与恢复");
      await app.evaluate(() =>
        Object.defineProperty(window, "showSaveFilePicker", {
          value: undefined,
          configurable: true,
        }),
      );
      await click("备份全部记录");
      const dialog = app.getByRole("dialog");
      await dialog.getByText("完整备份", { exact: true }).waitFor();
      const pending = app.waitForEvent("download");
      await dialog
        .getByRole("button", { name: "保存此分包", exact: true })
        .click();
      const resultDownload = await pending;
      await resultDownload.saveAs(archivePath);
      await dialog.getByText("备份文件已写入", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      expected = await records();
      const result = execFileSync(
        process.env.VALIDATION_PYTHON || "python3",
        [
          "../spec/UploadLedger_Spec_v1.0.0/testkit/validate_archive.py",
          archivePath,
        ],
        { encoding: "utf8" },
      );
      await writeFile(
        resolve(out, "independent-archive-validation.txt"),
        result,
      );
      assert.ok(result.length > 0);
      const active = (await all("jobs")).filter((job) =>
        ["staging", "validated"].includes(job.status),
      );
      assert.equal(active.length, 0);
      await app.screenshot({
        path: resolve(out, "06-backup.png"),
        fullPage: true,
        animations: "disabled",
      });
    },
  );
  await check(
    "Fresh browser profile imports exact metadata and bytes; reimport preserves local edits",
    ["T030", "T031", "T048", "T051"],
    async () => {
      second = await harness({
        output: "output/ui-import",
        serve: false,
        pregrant: false,
      });
      await onboard(second.app);
      await second.app
        .getByRole("button", { name: "备份与恢复", exact: true })
        .click();
      const input = second.app.getByLabel("选择 ZIP 备份", { exact: true });
      await input.setInputFiles(archivePath);
      await second.app.getByText("导入前检查", { exact: true }).waitFor();
      assert.equal((await second.records()).length, 0);
      await second.app
        .getByRole("button", { name: "确认导入", exact: true })
        .click();
      await until(
        async () => (await second.records()).length === expected.length,
      );
      const imported = await second.records();
      for (const record of expected) {
        const restored = imported.find((r) => r.recordId === record.recordId);
        assert.ok(restored);
        for (const key of [
          "batchId",
          "observedAt",
          "source",
          "page",
          "file",
          "snapshot",
          "submission",
          "user",
          "revision",
        ])
          assert.deepEqual(restored[key], record[key], key);
      }
      assert.equal((await second.all("sites")).length, 0);
      const objects = await second.all("objects"),
        chunks = await second.all("chunks");
      for (const object of objects) {
        const bytes = Buffer.concat(
          chunks
            .filter((chunk) => chunk.payloadId === object.payloadId)
            .sort((a, b) => a.index - b.index)
            .map((chunk) => Buffer.from(chunk.bytes)),
        );
        assert.equal(bytes.length, object.byteLength);
        assert.equal(hash(bytes), object.sha256);
      }
      const target = imported[0];
      await second.command("UI_SET_USER_FIELDS", {
        recordId: target.recordId,
        expectedRevision: target.revision,
        fields: { ...target.user, note: "Newer local note" },
      });
      await input.setInputFiles(archivePath);
      await second.app.getByText("导入前检查", { exact: true }).waitFor();
      await second.app
        .getByRole("button", { name: "确认导入", exact: true })
        .click();
      await until(
        async () =>
          (await second.app
            .getByText("导入前检查", { exact: true })
            .count()) === 0,
      );
      assert.equal((await second.records()).length, expected.length);
      assert.equal(
        (await second.records()).find((r) => r.recordId === target.recordId)
          .user.note,
        "Newer local note",
      );
      for (const bad of [
        "bad-checksum-backup.zip",
        "bad-path-backup.zip",
        "bad-duplicate-backup.zip",
      ]) {
        await input.setInputFiles(fixture(bad));
        await second.app.getByRole("alert").waitFor();
        assert.equal((await second.records()).length, expected.length);
        assert.equal(
          (await second.records()).find((r) => r.recordId === target.recordId)
            .user.note,
          "Newer local note",
        );
      }
      await second.app.screenshot({
        path: resolve(out, "07-import.png"),
        fullPage: true,
        animations: "disabled",
      });
      assert.deepEqual(second.errors, []);
      assert.deepEqual(second.externalRequests, []);
    },
  );
  await check(
    "Keyboard modal navigation and explicit deletion preserve other files",
    ["T035", "T036", "T052"],
    async () => {
      await click("附件资料库");
      await open("sample.png");
      const before = (await records()).length;
      await detail()
        .getByRole("button", { name: "删除所选", exact: true })
        .click();
      const modal = app.getByRole("dialog");
      await modal.waitFor();
      for (let i = 0; i < 12; i++) {
        await app.keyboard.press("Tab");
        assert.ok(
          await modal.evaluate((el) => el.contains(document.activeElement)),
        );
      }
      await app.keyboard.press("Escape");
      await modal.waitFor({ state: "hidden" });
      assert.equal((await records()).length, before);
      await detail()
        .getByRole("button", { name: "删除所选", exact: true })
        .click();
      await modal
        .getByRole("button", { name: "删除所选", exact: true })
        .click();
      await until(async () => (await records()).length === before - 1);
      assert.ok(!(await records()).some((r) => r.file.name === "sample.png"));
    },
  );
  await check(
    "Chinese and English light/dark layouts fit desktop and narrow windows",
    ["T052", "T053"],
    async () => {
      await click("设置");
      await app.getByLabel("语言", { exact: true }).selectOption("en-GB");
      await app.getByLabel("外观", { exact: true }).selectOption("dark");
      await click("保存设置");
      await app
        .getByRole("button", { name: "Settings", exact: true })
        .waitFor();
      await click("Library");
      await until(
        async () => (await app.locator(".live-region").innerText()) === "",
      );
      const columns = await app
        .locator(".library-layout")
        .evaluate((el) => ({
          layout: el.getBoundingClientRect().width,
          pane: el.querySelector(".library-pane").getBoundingClientRect().width,
        }));
      assert.ok(Math.abs(columns.layout - columns.pane) < 2);
      await app.screenshot({
        path: resolve(out, "08-dark-english.png"),
        fullPage: true,
        animations: "disabled",
      });
      await app.setViewportSize({ width: 390, height: 844 });
      await until(async () => !(await app.locator(".rail").isVisible()));
      await click("Menu");
      await app.locator(".rail.mobile-open").waitFor({ state: "visible" });
      await click("Library");
      await until(async () => !(await app.locator(".rail").isVisible()));
      assert.ok(
        await app.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
      await app.screenshot({
        path: resolve(out, "09-narrow.png"),
        fullPage: true,
        animations: "disabled",
      });
      await app.setViewportSize({ width: 1380, height: 950 });
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 380, height: 640 });
      await popup.goto(`chrome-extension://${h.id}/popup.html`);
      await popup
        .getByRole("button", { name: "Open library", exact: true })
        .waitFor();
      assert.ok(
        await popup.evaluate(() => document.documentElement.scrollWidth <= 380),
      );
      await popup.screenshot({
        path: resolve(out, "10-popup.png"),
        fullPage: true,
        animations: "disabled",
      });
      await popup.close();
    },
  );
  await check(
    "Clear-all UI requires the exact challenge and removes only the test vault",
    ["T038", "T059"],
    async () => {
      const page = second.app;
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page
        .getByRole("button", { name: "暂停并准备清除", exact: true })
        .click();
      const modal = page.getByRole("dialog");
      await modal.waitFor();
      const confirm = modal.getByRole("button", {
        name: "永久清除全部资料",
        exact: true,
      });
      assert.ok(await confirm.isDisabled());
      await modal.locator("input").fill("wrong");
      assert.ok(await confirm.isDisabled());
      await modal
        .locator("input")
        .fill(await modal.locator(".challenge").innerText());
      await confirm.click();
      await until(async () => (await second.records()).length === 0);
      assert.equal((await second.all("chunks")).length, 0);
      assert.equal((await second.all("sites")).length, 0);
      assert.equal((await records()).length, 6);
    },
  );
  await check(
    "Automated accessibility audit and local network boundary",
    ["T034", "T052"],
    async () => {
      const source = await readFile("node_modules/axe-core/axe.min.js", "utf8");
      await app.evaluate(source);
      const report = await app.evaluate(async () =>
        axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        }),
      );
      await writeFile(
        resolve(out, "accessibility.json"),
        JSON.stringify(report.violations, null, 2),
      );
      const serious = report.violations.filter((v) =>
        ["critical", "serious"].includes(v.impact),
      );
      assert.deepEqual(
        serious.map((v) => ({
          id: v.id,
          help: v.help,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
      );
      assert.deepEqual(h.errors, []);
      assert.deepEqual(h.externalRequests, []);
    },
  );
} catch (e) {
  error = e;
  process.exitCode = 1;
}
if (second) await second.close(error);
await h.close(error);
