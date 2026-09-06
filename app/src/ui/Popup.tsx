import { useEffect, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  FileText,
  Pause,
  Play,
  ShieldCheck,
} from "lucide-react";
import { command } from "../shared/client";
import { permissionPattern } from "../domain/rules";
import type { SitePolicy, StoredRecord } from "../shared/model";
import {
  Brand,
  errorText,
  readLibrary,
  readRecords,
  safeSource,
  StatusBadge,
  type LibraryView,
  useLocale,
} from "./common";

export function Popup() {
  const [data, setData] = useState<LibraryView>();
  const [pageUrl, setPageUrl] = useState("");
  const [recent, setRecent] = useState<StoredRecord[]>([]);
  const [recentScope, setRecentScope] = useState<"page" | "site">("site");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { locale, t: translate } = useLocale(data?.runtime);
  const t = (key: Parameters<typeof translate>[0]) =>
    translate(key === "thisPage" && recentScope === "site" ? "thisSite" : key);
  const source = safeSource(pageUrl);
  const origin = source?.origin || "";
  const site = data?.sites.find((item) => item.exactOrigin === origin);
  const reload = async (knownSource = source) => {
    const next = await readLibrary({ limit: 20 });
    setData(next);
    if (knownSource) {
      const found = (
        await readRecords({ origins: [knownSource.origin], limit: 20 })
      ).records;
      const pageRecords = found.filter(
        (record) => record.page?.location === knownSource.location,
      );
      setRecent(
        pageRecords.length ? pageRecords.slice(0, 3) : found.slice(0, 3),
      );
      setRecentScope(pageRecords.length ? "page" : "site");
    }
  };
  useEffect(() => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        const value = tab?.url && /^https?:/.test(tab.url) ? tab.url : "";
        setPageUrl(value);
        void reload(safeSource(value)).catch((reason) =>
          setError(errorText(reason, locale, t)),
        );
      });
  }, []);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (reason) {
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  const toggleSite = () => {
    if (!source || !data) return;
    if (site?.enabled) {
      void perform(() =>
        command(
          "UI_SET_SITE_POLICY",
          {
            origin,
            enabled: false,
            dropEnabled: false,
            locationMode: site.locationMode,
            saveTitle: site.saveTitle,
          },
          data.runtime.vaultEpoch,
        ),
      );
      return;
    }
    const permission = chrome.permissions.request({
      origins: [permissionPattern(origin)],
    });
    void perform(async () => {
      if (!(await permission)) throw new Error("E_PERMISSION_REVOKED");
      await command(
        "UI_SET_SITE_POLICY",
        {
          origin,
          enabled: true,
          dropEnabled: site?.dropEnabled ?? false,
          locationMode: site?.locationMode ?? "origin_path",
          saveTitle: site?.saveTitle ?? true,
        },
        data.runtime.vaultEpoch,
      );
    });
  };
  const updateSite = (
    patch: Partial<
      Pick<SitePolicy, "dropEnabled" | "locationMode" | "saveTitle">
    >,
  ) => {
    if (!site || !data) return;
    void perform(() =>
      command(
        "UI_SET_SITE_POLICY",
        {
          origin,
          enabled: site.enabled,
          dropEnabled: patch.dropEnabled ?? site.dropEnabled,
          locationMode: patch.locationMode ?? site.locationMode,
          saveTitle: patch.saveTitle ?? site.saveTitle,
        },
        data.runtime.vaultEpoch,
      ),
    );
  };
  return (
    <main className="popup" lang={locale}>
      <header className="popup-header">
        <Brand compact />
        <button
          className="text-button"
          aria-label={t("openLibrary")}
          onClick={() =>
            void chrome.tabs.create({ url: chrome.runtime.getURL("app.html") })
          }
        >
          {t("openLibrary")} <ChevronRight size={15} />
        </button>
      </header>
      <section className="popup-site">
        <span className={`site-dot ${site?.enabled ? "enabled" : ""}`} />
        <div>
          <span className="kicker">{t("currentSite")}</span>
          <b>
            <bdi>{origin || t("unavailablePage")}</bdi>
          </b>
        </div>
      </section>
      {error && (
        <div className="alert error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
        </div>
      )}
      <p className="popup-explain">{t("enableExplain")}</p>
      <button
        className="primary full"
        disabled={busy || !source || !data}
        onClick={toggleSite}
      >
        {site?.enabled ? t("disableSite") : t("enableSite")}
      </button>
      {site?.enabled && (
        <div className="popup-controls">
          <label>
            <input
              type="checkbox"
              checked={site.dropEnabled}
              onChange={(event) =>
                updateSite({ dropEnabled: event.target.checked })
              }
            />
            {t("dropCapture")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={site.locationMode === "origin_path"}
              onChange={(event) =>
                updateSite({
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
              checked={site.saveTitle}
              onChange={(event) =>
                updateSite({ saveTitle: event.target.checked })
              }
            />
            {t("saveTitle")}
          </label>
        </div>
      )}
      <div className="popup-section-title">
        <h2>{t("recent")}</h2>
        <span>{source ? t("thisPage") : t("thisSite")}</span>
      </div>
      <div className="popup-records">
        {recent.length ? (
          recent.map((record) => (
            <button
              key={record.recordId}
              onClick={() =>
                void chrome.tabs.create({
                  url: `${chrome.runtime.getURL("app.html")}#record=${encodeURIComponent(record.recordId)}`,
                })
              }
            >
              <FileText size={18} />
              <span>
                <b>
                  <bdi>{record.user.label || record.file.name}</bdi>
                </b>
                <small>
                  {new Date(record.observedAt).toLocaleString(locale)}
                </small>
              </span>
              <StatusBadge
                kind="snapshot"
                value={record.snapshot.state}
                t={t}
              />
            </button>
          ))
        ) : (
          <p>{t("noRecent")}</p>
        )}
      </div>
      <button
        className="secondary full pause-button"
        disabled={!data || busy}
        onClick={() =>
          data &&
          void perform(() =>
            command(
              "UI_SET_GLOBAL_PAUSE",
              { paused: !data.runtime.paused },
              data.runtime.vaultEpoch,
            ),
          )
        }
      >
        {data?.runtime.paused ? <Play size={17} /> : <Pause size={17} />}{" "}
        {data?.runtime.paused ? t("resume") : t("pause")}
      </button>
      <p className="popup-local">
        <ShieldCheck size={14} />
        {t("local")}
      </p>
    </main>
  );
}
