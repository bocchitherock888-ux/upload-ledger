import { validate } from "../shared/validation";
import { database, initial, state, write } from "../storage/db";
import {
  CHUNK,
  MAX_FILE,
  cleanURL,
  fail,
  permissionPattern,
} from "../domain/rules";
import {
  abort,
  begin,
  chunk,
  finish,
  manualBegin,
  recover,
  resume,
} from "./capture";
import {
  abortAllAutomatic,
  clearAll,
  continueClear,
  deleteRecords,
  diagnostics,
  endJob,
  expireJobs,
  heartbeatJob,
  markObjectCorrupt,
  prepareJob,
  requestClearChallenge,
  permissionCleanupComplete,
  runGc,
  setSettings,
  setSubmission,
  setUserFields,
} from "./lifecycle";
import type { CallerBinding, SitePolicy } from "../shared/model";
import type { CommandPayloads, CommandType } from "../shared/protocol";
import errors from "../shared/error-codes.json";
import { identify } from "./auth";

const scriptId = (origin: string) =>
  "site-" +
  Array.from(new TextEncoder().encode(origin), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");

export async function syncScripts() {
  const db = await database();
  const [sites, runtime] = await Promise.all([
    db.getAll("sites"),
    db.get("meta", "runtime"),
  ]);
  db.close();
  const enabled: SitePolicy[] = [];
  for (const site of sites)
    if (
      site.enabled &&
      !runtime?.paused &&
      (await chrome.permissions.contains({ origins: [site.permissionPattern] }))
    )
      enabled.push(site);
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const remove = registered
    .filter(
      (item) => !enabled.some((site) => scriptId(site.exactOrigin) === item.id),
    )
    .map((item) => item.id);
  if (remove.length)
    await chrome.scripting.unregisterContentScripts({ ids: remove });
  for (const site of enabled)
    if (!registered.some((item) => item.id === scriptId(site.exactOrigin))) {
      await chrome.scripting.registerContentScripts([
        {
          id: scriptId(site.exactOrigin),
          matches: [site.permissionPattern],
          js: ["content.js"],
          runAt: "document_start",
          world: "ISOLATED",
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    }
  for (const tab of await chrome.tabs.query({}))
    if (tab.id !== undefined && tab.url) {
      let origin = "";
      try {
        origin = new URL(tab.url).origin;
      } catch {
        /* unsupported tab */
      }
      if (enabled.some((site) => site.exactOrigin === origin)) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: false },
            files: ["content.js"],
          });
        } catch {
          /* restricted page */
        }
      } else
        await chrome.tabs
          .sendMessage(tab.id, { type: "CAPTURE_STOP" })
          .catch(() => undefined);
    }
}

async function setPolicy(
  payload: {
    origin: string;
    enabled: boolean;
    dropEnabled: boolean;
    locationMode: "origin_path" | "origin_only";
    saveTitle: boolean;
  },
  epoch: number | null,
) {
  const origin = new URL(cleanURL(payload.origin, "origin_only")).origin;
  if (origin !== payload.origin) fail("E_INVALID_URL");
  const pattern = permissionPattern(origin);
  if (
    payload.enabled &&
    !(await chrome.permissions.contains({ origins: [pattern] }))
  )
    fail("E_PERMISSION_REVOKED");
  await write(async (tx) => {
    const runtime = await state(tx);
    if (runtime.vaultEpoch !== epoch) fail("E_VAULT_EPOCH");
    if (runtime.clearing) fail("E_CLEARING");
    const old = await tx.objectStore("sites").get(origin);
    await tx.objectStore("sites").put({
      exactOrigin: origin,
      enabled: payload.enabled,
      dropEnabled: payload.dropEnabled,
      locationMode: payload.locationMode,
      saveTitle: payload.saveTitle,
      permissionPattern: pattern,
      sitePolicyEpoch: (old?.sitePolicyEpoch ?? 0) + 1,
    });
    await abortAllAutomatic(tx, "E_PERMISSION_REVOKED", origin);
  });
  await syncScripts();
  let permissionRemoved = true;
  if (!payload.enabled) {
    const db = await database();
    const remaining = (await db.getAll("sites")).some(
      (site) => site.enabled && site.permissionPattern === pattern,
    );
    db.close();
    if (!remaining)
      try {
        permissionRemoved = await chrome.permissions.remove({
          origins: [pattern],
        });
      } catch {
        permissionRemoved = false;
      }
  }
  return { enabled: payload.enabled, permissionRemoved };
}

async function runtimeState() {
  const db = await database();
  try {
    const tx = db.transaction(["meta"], "readonly");
    const saved = await tx.objectStore("meta").get("runtime");
    const runtime = { ...initial, ...(saved ?? {}) };
    return {
      vaultEpoch: runtime.vaultEpoch,
      globalPolicyEpoch: runtime.globalPolicyEpoch,
      paused: runtime.paused,
      clearing: runtime.clearing,
      settingsRevision: runtime.settingsRevision,
      budgetBytes: runtime.budgetBytes,
      excludedFileNames: [...runtime.excludedFileNames],
      locale: runtime.locale,
      theme: runtime.theme,
      onboardingComplete: runtime.onboardingComplete,
    };
  } finally {
    db.close();
  }
}

async function ensureCapturePermission(caller: CallerBinding) {
  if (
    !(await chrome.permissions.contains({
      origins: [permissionPattern(caller.origin)],
    }))
  )
    fail("E_PERMISSION_REVOKED");
}

async function cleanupPendingPermissions(patterns?: string[]) {
  let targets = patterns;
  if (!targets) {
    const db = await database();
    const runtime = await db.get("meta", "runtime");
    db.close();
    targets = runtime?.pendingPermissionPatterns ?? [];
  }
  if (!targets.length) return false;
  try {
    const granted = new Set((await chrome.permissions.getAll()).origins ?? []);
    const present = targets.filter((value) => granted.has(value));
    if (!present.length) {
      await permissionCleanupComplete(targets);
      return false;
    }
    const removed = await chrome.permissions.remove({ origins: present });
    if (removed) await permissionCleanupComplete(targets);
    return !removed;
  } catch {
    return true;
  }
}

const importCommands = new Set([
  "UI_IMPORT_BEGIN",
  "UI_IMPORT_MANIFEST_CHUNK",
  "UI_IMPORT_MANIFEST_FINISH",
  "UI_IMPORT_OBJECT_BEGIN",
  "UI_IMPORT_OBJECT_CHUNK",
  "UI_IMPORT_OBJECT_FINISH",
  "UI_IMPORT_PUBLISH",
  "UI_IMPORT_ABORT",
]);
const appOnly = new Set([
  ...importCommands,
  "UI_MANUAL_BEGIN",
  "UI_MANUAL_CHUNK",
  "UI_MANUAL_FINISH",
  "UI_MANUAL_RESUME",
  "UI_MANUAL_ABORT",
]);
type ImportCommand = Extract<CommandType, `UI_IMPORT_${string}`>;

export async function dispatch(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
) {
  let message;
  try {
    message = validate(raw);
  } catch (error) {
    fail(
      error instanceof Error && error.message === "E_MESSAGE_TOO_LARGE"
        ? error.message
        : "E_BAD_MESSAGE",
    );
  }
  const { caller, path } = identify(sender);
  if (message.type.startsWith("UI_") !== (caller.kind === "ui"))
    fail("E_UNAUTHORISED");
  if (appOnly.has(message.type) && path !== "/app.html") fail("E_UNAUTHORISED");
  if (caller.kind === "capture") {
    if (message.type === "CAPTURE_HELLO") {
      const permitted = await chrome.permissions.contains({
        origins: [permissionPattern(caller.origin)],
      });
      const db = await database();
      try {
        const tx = db.transaction(["meta", "sites"], "readonly");
        const runtime = (await tx.objectStore("meta").get("runtime")) ?? {
          vaultEpoch: 0,
          globalPolicyEpoch: 0,
          paused: false,
          clearing: false,
        };
        const site = await tx.objectStore("sites").get(caller.origin);
        await tx.done;
        return {
          vaultEpoch: runtime.vaultEpoch,
          allowed:
            permitted &&
            !!site?.enabled &&
            !runtime.paused &&
            !runtime.clearing,
          paused: runtime.paused,
          policyEpoch: {
            global: runtime.globalPolicyEpoch,
            site: site?.sitePolicyEpoch ?? 0,
          },
          dropEnabled: !!site?.dropEnabled,
          maxFileBytes: MAX_FILE,
          rawChunkBytes: CHUNK,
        };
      } finally {
        db.close();
      }
    }
    await ensureCapturePermission(caller);
    switch (message.type) {
      case "CAPTURE_BEGIN":
        return begin(message.payload, caller, message.vaultEpoch);
      case "CAPTURE_CHUNK":
        return chunk(message.payload, caller, message.vaultEpoch);
      case "CAPTURE_FINISH":
        return finish(message.payload, caller, message.vaultEpoch);
      case "CAPTURE_RESUME":
        return resume(message.payload, caller, message.vaultEpoch);
      case "CAPTURE_ABORT":
        return abort(
          message.payload,
          caller,
          message.vaultEpoch,
          (
            {
              read_failed: "E_READ_FAILED",
              source_changed: "E_SOURCE_CHANGED",
              source_gone: "E_SOURCE_GONE",
              user_cancelled: "E_USER_CANCELLED",
            } as const
          )[message.payload.reason],
        );
      case "CAPTURE_SOURCE_GONE":
        await recover(caller, message.payload.batchEventIds);
        return {};
    }
  }
  switch (message.type) {
    case "UI_GET_RUNTIME_STATE":
      return runtimeState();
    case "UI_SET_SETTINGS":
      return setSettings(
        message.payload.expectedSettingsRevision,
        message.payload.patch,
        message.vaultEpoch,
      );
    case "UI_GET_SITE_STATUS": {
      const origin = new URL(cleanURL(message.payload.origin, "origin_only"))
        .origin;
      if (origin !== message.payload.origin) fail("E_INVALID_URL");
      const db = await database();
      const site = await db.get("sites", origin);
      db.close();
      return {
        site: site ?? null,
        granted: await chrome.permissions.contains({
          origins: [permissionPattern(origin)],
        }),
      };
    }
    case "UI_SET_SITE_POLICY":
      return setPolicy(message.payload, message.vaultEpoch);
    case "UI_SET_GLOBAL_PAUSE":
      await write(async (tx) => {
        const runtime = await state(tx);
        if (runtime.vaultEpoch !== message.vaultEpoch) fail("E_VAULT_EPOCH");
        if (runtime.clearing) fail("E_CLEARING");
        runtime.paused = message.payload.paused;
        runtime.globalPolicyEpoch++;
        await tx.objectStore("meta").put(runtime, "runtime");
        if (message.payload.paused) await abortAllAutomatic(tx, "E_PAUSED");
      });
      await syncScripts();
      return {};
    case "UI_SET_USER_FIELDS":
      return setUserFields(
        message.payload.recordId,
        message.payload.expectedRevision,
        message.payload.fields,
        message.vaultEpoch,
      );
    case "UI_SET_SUBMISSION":
      return setSubmission(
        message.payload.records,
        message.payload.state,
        message.payload.note,
        message.vaultEpoch,
      );
    case "UI_DELETE_RECORDS":
      return deleteRecords(message.payload.records, message.vaultEpoch);
    case "UI_REQUEST_CLEAR_CHALLENGE":
      return requestClearChallenge(caller, message.vaultEpoch);
    case "UI_CLEAR_ALL": {
      const granted = await chrome.permissions.getAll();
      let permissionRemovalFailed = false;
      const origins = (granted.origins ?? []).filter(
        (value) => value.startsWith("http://") || value.startsWith("https://"),
      );
      const result = await clearAll(
        message.payload.challenge,
        caller,
        message.vaultEpoch,
        origins,
      );
      await syncScripts();
      permissionRemovalFailed = await cleanupPendingPermissions(origins);
      return { ...result, permissionRemovalFailed };
    }
    case "UI_MANUAL_BEGIN":
      return manualBegin(message.payload, caller, message.vaultEpoch);
    case "UI_MANUAL_CHUNK":
      return chunk(message.payload, caller, message.vaultEpoch);
    case "UI_MANUAL_FINISH":
      return finish(message.payload, caller, message.vaultEpoch);
    case "UI_MANUAL_RESUME":
      return resume(message.payload, caller, message.vaultEpoch);
    case "UI_MANUAL_ABORT":
      return abort(
        message.payload,
        caller,
        message.vaultEpoch,
        (
          {
            read_failed: "E_READ_FAILED",
            source_changed: "E_SOURCE_CHANGED",
            source_gone: "E_SOURCE_GONE",
            user_cancelled: "E_USER_CANCELLED",
          } as const
        )[message.payload.reason],
      );
    case "UI_PREPARE_EXPORT":
      return prepareJob(
        "export",
        message.payload.recordIds,
        caller,
        message.vaultEpoch,
      );
    case "UI_PREPARE_PREVIEW":
      return prepareJob(
        "preview",
        [message.payload.recordId],
        caller,
        message.vaultEpoch,
      );
    case "UI_HEARTBEAT_JOB":
      return heartbeatJob(message.payload.jobId, caller, message.vaultEpoch);
    case "UI_END_JOB":
      return endJob(
        message.payload.jobId,
        message.payload.outcome,
        caller,
        message.vaultEpoch,
      );
    case "UI_MARK_OBJECT_CORRUPT":
      return markObjectCorrupt(message.payload.recordId, message.vaultEpoch);
    case "UI_GET_DIAGNOSTICS":
      return diagnostics();
  }
  if (importCommands.has(message.type)) {
    const backup = await import("../backup/service");
    return backup.handleImport(
      message.type as ImportCommand,
      message.payload as CommandPayloads[ImportCommand],
      caller,
      message.vaultEpoch!,
    );
  }
  fail("E_BAD_MESSAGE");
}

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  void dispatch(raw, sender)
    .then((data) =>
      respond({
        v: 1,
        requestId: (raw as { requestId?: unknown })?.requestId ?? null,
        ok: true,
        data,
      }),
    )
    .catch((error) => {
      const code =
        error instanceof DOMException && error.name === "QuotaExceededError"
          ? "E_QUOTA"
          : error instanceof Error
            ? error.message
            : "E_STORAGE_WRITE";
      const definition =
        errors.find((item) => item.code === code) ??
        errors.find((item) => item.code === "E_STORAGE_WRITE")!;
      respond({
        v: 1,
        requestId: (raw as { requestId?: unknown })?.requestId ?? null,
        ok: false,
        error: {
          code: definition.code,
          retryable: definition.retryable,
          messageKey: definition.messageKey,
        },
      });
    });
  return true;
});

chrome.permissions.onRemoved.addListener(() => {
  void (async () => {
    const db = await database();
    const sites = await db.getAll("sites");
    db.close();
    for (const site of sites)
      if (
        site.enabled &&
        !(await chrome.permissions.contains({
          origins: [site.permissionPattern],
        }))
      ) {
        await write(async (tx) => {
          const current = await tx.objectStore("sites").get(site.exactOrigin);
          if (!current?.enabled) return;
          current.enabled = false;
          current.sitePolicyEpoch++;
          await tx.objectStore("sites").put(current);
          await abortAllAutomatic(
            tx,
            "E_PERMISSION_REVOKED",
            current.exactOrigin,
          );
        });
      }
    await syncScripts();
  })().catch(() => undefined);
});

async function recoverAll() {
  await continueClear();
  await cleanupPendingPermissions();
  try {
    const backup = await import("../backup/service");
    await backup.recoverImports();
  } catch {
    /* backup recovery is isolated */
  }
  await recover();
  await expireJobs();
  await runGc();
}
chrome.alarms.onAlarm.addListener(() => {
  void recoverAll().catch(() => undefined);
});
chrome.runtime.onInstalled.addListener(() => {
  void recoverAll()
    .then(syncScripts)
    .catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  void recoverAll()
    .then(syncScripts)
    .catch(() => undefined);
});
void chrome.alarms.create("recover", { periodInMinutes: 1 });
void recoverAll().catch(() => undefined);
