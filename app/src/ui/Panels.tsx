import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  CircleAlert,
  FileArchive,
  FolderOpen,
  Globe2,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import { command } from "../shared/client";
import { permissionPattern } from "../domain/rules";
import { cancelBackup, inspectBackup, publishBackup } from "../backup/client";
import type { SitePolicy } from "../shared/model";
import type { Locale, MessageKey } from "./i18n";
import {
  errorText,
  humanSize,
  Modal,
  safeSource,
  type DiagnosticsView,
  type ImportReviewView,
  type LibraryView,
} from "./common";

export function BackupPanel({
  data,
  locale,
  t,
  collectIds,
  startExport,
  reload,
  announce,
}: {
  data: LibraryView;
  locale: Locale;
  t: (key: MessageKey) => string;
  collectIds: () => Promise<string[]>;
  startExport: (ids: string[], title: string) => Promise<void>;
  reload: () => Promise<void>;
  announce: (text: string) => void;
}) {
  const [review, setReview] = useState<ImportReviewView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const abort = useRef<AbortController | null>(null);
  const stagedJob = useRef<string | null>(null);
  useEffect(
    () => () => {
      abort.current?.abort();
      if (stagedJob.current)
        void cancelBackup(stagedJob.current, data.runtime.vaultEpoch).catch(
          () => undefined,
        );
    },
    [data.runtime.vaultEpoch],
  );
  const inspect = async (file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    abort.current = new AbortController();
    try {
      const result = await inspectBackup(file, data.runtime.vaultEpoch, {
        signal: abort.current.signal,
        onProgress: (done, total) =>
          setProgress(`${humanSize(done)} / ${humanSize(total)}`),
      });
      stagedJob.current = result.jobId;
      setReview(result);
    } catch (reason) {
      if ((reason as Error)?.name !== "AbortError")
        setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  const cancel = async () => {
    abort.current?.abort();
    if (stagedJob.current)
      await cancelBackup(stagedJob.current, data.runtime.vaultEpoch).catch(
        () => undefined,
      );
    stagedJob.current = null;
    setReview(undefined);
    announce(t("cancelImport"));
  };
  const publish = async () => {
    if (!review) return;
    setBusy(true);
    setError("");
    try {
      await publishBackup(review.jobId, data.runtime.vaultEpoch);
      stagedJob.current = null;
      setReview(undefined);
      await reload();
      announce(t("importDone"));
    } catch (reason) {
      if (reason instanceof Error && reason.message === "E_ACK_TIMEOUT")
        await reload();
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="section-stack">
      <div className="page-heading">
        <div>
          <h1>{t("backupHeading")}</h1>
        </div>
        <Archive size={34} />
      </div>
      <section className="settings-card backup-card">
        <div>
          <FileArchive size={24} />
          <div>
            <h2>{t("completeBackup")}</h2>
            <p>
              {data.usage.recordCount} {t("records")} ·{" "}
              {humanSize(data.usage.usedBytes)}
            </p>
          </div>
        </div>
        <button
          className="primary"
          disabled={busy || data.usage.recordCount === 0}
          onClick={() =>
            void collectIds().then((ids) =>
              startExport(ids, t("completeBackup")),
            )
          }
        >
          <ArrowDownToLine size={17} />
          {t("exportAll")}
        </button>
      </section>
      <section className="settings-card">
        <div className="card-heading">
          <div>
            <h2>{t("importTitle")}</h2>
            </div>
        </div>
        <label className="file-drop compact">
          <FolderOpen size={25} />
          <span>{t("chooseBackup")}</span>
          <input
            disabled={busy}
            aria-label={t("chooseBackup")}
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void inspect(file);
            }}
          />
        </label>
        {busy && !review && (
          <p className="progress-text" role="status">
            <RefreshCw className="spin" size={16} />
            {t("inspecting")} · {progress}
            <button
              className="text-button"
              onClick={() => abort.current?.abort()}
            >
              {t("cancel")}
            </button>
          </p>
        )}
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {review && (
          <div className="import-review">
            <h3>{t("importReview")}</h3>
            <div className="review-grid">
              <span>
                <b>{review.recordCount}</b>
                {t("importRecords")}
              </span>
              <span>
                <b>{review.objectCount}</b>
                {t("importObjects")}
              </span>
              <span>
                <b>{review.skippedCount}</b>
                {t("skipped")}
              </span>
              <span className={review.conflictCount ? "danger-text" : ""}>
                <b>{review.conflictCount}</b>
                {t("conflicts")}
              </span>
            </div>
            <div className="modal-actions">
              <button onClick={() => void cancel()}>{t("cancelImport")}</button>
              <button
                className="primary"
                disabled={busy || review.conflictCount > 0}
                onClick={() => void publish()}
              >
                {t("publishImport")}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function SitesPanel({
  data,
  locale,
  t,
  reload,
  setError,
}: {
  data: LibraryView;
  locale: Locale;
  t: (key: MessageKey) => string;
  reload: () => Promise<void>;
  setError: (value: string) => void;
}) {
  const [originInput, setOriginInput] = useState("");
  const [busy, setBusy] = useState(false);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (reason) {
      if (reason instanceof Error && reason.message === "E_ACK_TIMEOUT")
        await reload();
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const source = safeSource(originInput, "origin_only");
    if (!source) {
      setError(errorText(new Error("E_INVALID_URL"), locale, t));
      return;
    }
    const grant = chrome.permissions.request({
      origins: [permissionPattern(source.origin)],
    });
    void perform(async () => {
      if (!(await grant)) throw new Error("E_PERMISSION_REVOKED");
      await command(
        "UI_SET_SITE_POLICY",
        {
          origin: source.origin,
          enabled: true,
          dropEnabled: false,
          locationMode: "origin_path",
          saveTitle: true,
        },
        data.runtime.vaultEpoch,
      );
      setOriginInput("");
    });
  };
  const update = (site: SitePolicy, patch: Partial<SitePolicy>) =>
    void perform(() =>
      command(
        "UI_SET_SITE_POLICY",
        {
          origin: site.exactOrigin,
          enabled: patch.enabled ?? site.enabled,
          dropEnabled: patch.dropEnabled ?? site.dropEnabled,
          locationMode: patch.locationMode ?? site.locationMode,
          saveTitle: patch.saveTitle ?? site.saveTitle,
        },
        data.runtime.vaultEpoch,
      ),
    );
  const toggle = (site: SitePolicy) => {
    if (site.enabled) {
      update(site, { enabled: false, dropEnabled: false });
      return;
    }
    const grant = chrome.permissions.request({
      origins: [permissionPattern(site.exactOrigin)],
    });
    void perform(async () => {
      if (!(await grant)) throw new Error("E_PERMISSION_REVOKED");
      await command(
        "UI_SET_SITE_POLICY",
        {
          origin: site.exactOrigin,
          enabled: true,
          dropEnabled: site.dropEnabled,
          locationMode: site.locationMode,
          saveTitle: site.saveTitle,
        },
        data.runtime.vaultEpoch,
      );
    });
  };
  return (
    <div className="section-stack">
      <div className="page-heading">
        <div>
          <h1>{t("siteHeading")}</h1>
        </div>
        <Globe2 size={34} />
      </div>
      <section className="settings-card">
        <h2>{t("addSite")}</h2>
        <div className="inline-form">
          <label>
            <span className="sr-only">{t("origin")}</span>
            <input
              type="url"
              aria-label={t("origin")}
              placeholder="https://example.com"
              value={originInput}
              onChange={(event) => setOriginInput(event.target.value)}
            />
          </label>
          <button className="primary" disabled={busy} onClick={add}>
            <Plus size={17} />
            {t("enableSite")}
          </button>
        </div>
      </section>
      <section className="settings-card">
        <h2>{t("siteList")}</h2>
        {data.sites.length ? (
          <div className="site-list">
            {data.sites.map((site) => (
              <article key={site.exactOrigin}>
                <div className="site-name">
                  <span
                    className={`site-dot ${site.enabled ? "enabled" : ""}`}
                  />
                  <div>
                    <b>
                      <bdi>{site.exactOrigin}</bdi>
                    </b>
                    <small>
                      {site.enabled ? t("siteEnabled") : t("siteDisabled")}
                    </small>
                  </div>
                  <button
                    className={site.enabled ? "danger-quiet" : ""}
                    disabled={busy}
                    onClick={() => toggle(site)}
                  >
                    {site.enabled ? t("disableSite") : t("enableSite")}
                  </button>
                </div>
                <div className="site-options">
                  <label>
                    <input
                      type="checkbox"
                      disabled={!site.enabled || busy}
                      checked={site.dropEnabled}
                      onChange={(event) =>
                        update(site, { dropEnabled: event.target.checked })
                      }
                    />
                    {t("dropCapture")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!site.enabled || busy}
                      checked={site.locationMode === "origin_path"}
                      onChange={(event) =>
                        update(site, {
                          locationMode: event.target.checked
                            ? "origin_path"
                            : "origin_only",
                        })
                      }
                    />
                    {t("savePath")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!site.enabled || busy}
                      checked={site.saveTitle}
                      onChange={(event) =>
                        update(site, { saveTitle: event.target.checked })
                      }
                    />
                    {t("saveTitle")}
                  </label>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-copy">{t("noSites")}</p>
        )}
      </section>
    </div>
  );
}

export function SettingsPanel({
  data,
  locale,
  t,
  reload,
  setError,
  announce,
}: {
  data: LibraryView;
  locale: Locale;
  t: (key: MessageKey) => string;
  reload: () => Promise<void>;
  setError: (value: string) => void;
  announce: (text: string) => void;
}) {
  const [budgetGiB, setBudgetGiB] = useState(
    (data.runtime.budgetBytes / 1024 ** 3).toFixed(2),
  );
  const [exclusions, setExclusions] = useState(
    data.runtime.excludedFileNames.join("\n"),
  );
  const [nextLocale, setNextLocale] = useState<Locale>(locale);
  const [theme, setTheme] = useState(data.runtime.theme);
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsView>();
  const [challenge, setChallenge] = useState<{
    challenge: string;
    expiresAt: string;
  }>();
  const [typed, setTyped] = useState("");
  const perform = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
      if (message) announce(message);
    } catch (reason) {
      if (reason instanceof Error && reason.message === "E_ACK_TIMEOUT")
        await reload();
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const budgetBytes = Math.round(Number(budgetGiB) * 1024 ** 3);
    void perform(
      () =>
        command(
          "UI_SET_SETTINGS",
          {
            expectedSettingsRevision: data.runtime.settingsRevision,
            patch: {
              budgetBytes,
              excludedFileNames: exclusions
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean),
              locale: nextLocale,
              theme,
            },
          },
          data.runtime.vaultEpoch,
        ),
      t("save"),
    );
  };
  const prepareClear = async () => {
    setBusy(true);
    setError("");
    try {
      if (!data.runtime.paused)
        await command(
          "UI_SET_GLOBAL_PAUSE",
          { paused: true },
          data.runtime.vaultEpoch,
        );
      setChallenge(
        await command(
          "UI_REQUEST_CLEAR_CHALLENGE",
          {},
          data.runtime.vaultEpoch,
        ),
      );
    } catch (reason) {
      if (reason instanceof Error && reason.message === "E_ACK_TIMEOUT")
        await reload();
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  const clearAll = () =>
    challenge &&
    void perform(async () => {
      await command(
        "UI_CLEAR_ALL",
        { challenge: typed },
        data.runtime.vaultEpoch,
      );
      localStorage.removeItem("upload-ledger-onboarded");
      setChallenge(undefined);
      setTyped("");
    }, t("clearAll"));
  return (
    <div className="section-stack">
      <div className="page-heading">
        <div>
          <h1>{t("settingsHeading")}</h1>
        </div>
        <SettingsIcon size={34} />
      </div>
      <section className="settings-card">
        <h2>{t("capacity")}</h2>
        <div className="usage-bar">
          <span
            style={{
              width: `${Math.min(100, (data.usage.chargedBytes / Math.max(1, data.usage.budgetBytes)) * 100)}%`,
            }}
          />
        </div>
        <div className="usage-summary">
          <span>
            <b>{humanSize(data.usage.usedBytes)}</b>
            {t("usedBytes")}
          </span>
          <span>
            <b>{humanSize(data.usage.reservedBytes)}</b>
            {t("reservedBytes")}
          </span>
          <span>
            <b>{humanSize(data.usage.budgetBytes)}</b>
            {t("budget")}
          </span>
        </div>
        <label>
          {t("budget")} (GiB)
          <input
            type="number"
            min="0.1"
            max="5"
            step="0.1"
            value={budgetGiB}
            onChange={(event) => setBudgetGiB(event.target.value)}
          />
        </label>
        <label>
          {t("exclusions")}
          <textarea
            rows={7}
            value={exclusions}
            onChange={(event) => setExclusions(event.target.value)}
          />
        </label>
      </section>
      <section className="settings-card two-cols">
        <label>
          {t("language")}
          <select
            aria-label={t("language")}
            value={nextLocale}
            onChange={(event) => setNextLocale(event.target.value as Locale)}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-GB">English (UK)</option>
          </select>
        </label>
        <label>
          {t("appearance")}
          <select
            aria-label={t("appearance")}
            value={theme}
            onChange={(event) =>
              setTheme(event.target.value as "system" | "light" | "dark")
            }
          >
            <option value="system">{t("system")}</option>
            <option value="light">{t("light")}</option>
            <option value="dark">{t("dark")}</option>
          </select>
        </label>
        <button className="primary" disabled={busy} onClick={save}>
          {t("saveSettings")}
        </button>
      </section>
      <section className="settings-card">
        <div className="card-heading">
          <div>
            <h2>{t("diagnostics")}</h2>
            {diagnostics && (
              <p>
                DB {diagnostics.databaseVersion} · protocol{" "}
                {diagnostics.protocolVersion} ·{" "}
                {Object.entries(diagnostics.counts)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(" · ")}
              </p>
            )}
          </div>
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () =>
                setDiagnostics(
                  await command(
                    "UI_GET_DIAGNOSTICS",
                    {},
                    data.runtime.vaultEpoch,
                  ),
                ),
              )
            }
          >
            <RefreshCw size={16} />
            {t("refreshDiagnostics")}
          </button>
        </div>
      </section>
      <section className="settings-card danger-card">
        <h2>{t("clearAll")}</h2>
        <p>{t("clearExplain")}</p>
        <button
          className="danger-button"
          disabled={busy}
          onClick={() => void prepareClear()}
        >
          <Trash2 size={17} />
          {t("prepareClear")}
        </button>
      </section>
      {challenge && (
        <Modal
          title={t("clearAll")}
          onClose={() => {
            setChallenge(undefined);
            setTyped("");
          }}
        >
          <div className="alert error">
            <CircleAlert size={18} />
            <span>{t("clearExplain")}</span>
          </div>
          <label>
            {t("typeChallenge")}
            <code className="challenge">{challenge.challenge}</code>
            <input
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button onClick={() => setChallenge(undefined)}>
              {t("cancel")}
            </button>
            <button
              className="danger-button"
              disabled={busy || typed !== challenge.challenge}
              onClick={clearAll}
            >
              {t("clearNow")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
