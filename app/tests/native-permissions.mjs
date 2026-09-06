import { chromium } from "playwright";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const root = resolve("output/native-permissions");
await mkdir(root, { recursive: true });
const context = await chromium.launchPersistentContext(
  await mkdtemp(resolve(tmpdir(), "upload-ledger-native-")),
  {
    channel: "chromium",
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      `--disable-extensions-except=${resolve("dist")}`,
      `--load-extension=${resolve("dist")}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  },
);
const worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const id = new URL(worker.url()).host;
const page = await context.newPage();
await page.goto(`chrome-extension://${id}/app.html#/sites`);
await page.getByRole("checkbox", { name: "我了解本地明文存储范围" }).check();
await page.getByRole("button", { name: "进入资料库", exact: true }).click();
await page
  .getByLabel("网站地址", { exact: true })
  .fill("http://127.0.0.1:18765");
await page.getByRole("button", { name: "在此站点启用", exact: true }).click();
console.log(
  "WAITING_NATIVE_PERMISSION",
  id,
  await page.evaluate(async () => ({
    granted: await chrome.permissions.contains({
      origins: ["http://127.0.0.1/*"],
    }),
  })),
);
await page.screenshot({ path: resolve(root, "awaiting.png"), fullPage: true });
try {
  await page.waitForFunction(
    async () =>
      await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] }),
    null,
    { timeout: 240000 },
  );
  await page
    .getByRole("button", { name: "停用此站点", exact: true })
    .waitFor({ timeout: 240000 });
  console.log("NATIVE_GRANTED");
  await page.screenshot({
    path: resolve(root, "native-granted.png"),
    fullPage: true,
  });
  const removed = await page.evaluate(() =>
    chrome.permissions.remove({ origins: ["http://127.0.0.1/*"] }),
  );
  const granted = await page.evaluate(() =>
    chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] }),
  );
  await writeFile(
    resolve(root, "results.json"),
    JSON.stringify(
      {
        applicationVersion: "1.0.0",
        nativeGrant: true,
        grantInteraction: "User clicked Allow in native Chrome prompt",
        removed,
        grantedAfterRemove: granted,
        browser: context.browser().version(),
      },
      null,
      2,
    ),
  );
} catch (e) {
  process.exitCode = 1;
  console.log(
    "NATIVE_UNVERIFIED",
    String(e),
    await page.locator("body").innerText(),
  );
  await page.screenshot({ path: resolve(root, "failed.png"), fullPage: true });
} finally {
  await context.close();
}
