import { useEffect, useRef, useState } from "react";
import {
  Archive,
  BookOpen,
  CircleAlert,
  Database,
  Globe2,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { command } from "../shared/client";
import { planBackup } from "../backup/client";
import type { StoredRecord, SubmissionState } from "../shared/model";
import type { MessageKey } from "./i18n";
import { BackupPanel, SettingsPanel, SitesPanel } from "./Panels";
import { CompareDialog, Detail, RecordList } from "./Details";
import { ExportDialog, ManualDialog } from "./Dialogs";
import {
  Brand,
  errorText,
  humanSize,
  Modal,
  Onboarding,
  queryFor,
  readLibrary,
  readRecord,
  readRecords,
  type ExportPlanView,
  type Filters,
  type LibraryView,
  useLocale,
} from "./common";

export function App() {
  const [section, setSection] = useState<
    "library" | "sites" | "backup" | "settings"
  >(() => {
    const requested = location.hash.replace(/^#\//, "");
    return requested === "sites" ||
      requested === "backup" ||
      requested === "settings"
      ? requested
      : "library";
  });
  const [data, setData] = useState<LibraryView>();
  const [records, setRecords] = useState<StoredRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<StoredRecord>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>({
    text: "",
    origin: "",
    dateFrom: "",
    dateTo: "",
    snapshot: "",
    submission: "",
    tags: "",
    pinned: false,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [batchState, setBatchState] = useState<SubmissionState>();
  const [exportPlan, setExportPlan] = useState<ExportPlanView>();
  const { locale, t } = useLocale(data?.runtime);
  const signature = JSON.stringify(filters);
  const loadedTarget = useRef(100);
  const load = async () => {
    setLoading(true);
    try {
      const next = await readLibrary(queryFor(filters));
      const merged = [...next.records];
      let cursor = next.nextCursor;
      while (cursor && merged.length < loadedTarget.current) {
        const page = await readRecords(queryFor(filters, cursor));
        merged.push(...page.records);
        cursor = page.nextCursor;
      }
      setData(next);
      setRecords(merged);
      setNextCursor(cursor);
      setError("");
      if (selectedId) setDetail((await readRecord(selectedId)) || undefined);
    } catch (reason) {
      setError(errorText(reason, locale, t));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    loadedTarget.current = 100;
    setChecked(new Set());
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [signature]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [signature, selectedId]);
  useEffect(() => {
    const hash = new URLSearchParams(location.hash.replace(/^#/, "")).get(
      "record",
    );
    if (hash) setSelectedId(hash);
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    let live = true;
    void readRecord(selectedId)
      .then((record) => {
        if (live) setDetail(record || undefined);
      })
      .catch((reason) => setError(errorText(reason, locale, t)));
    return () => {
      live = false;
    };
  }, [selectedId]);
  useEffect(() => {
    const theme = data?.runtime.theme || "system";
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
  }, [data?.runtime.theme, locale]);
  const announce = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 4_000);
  };
  const perform = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      if (message) announce(message);
    } catch (reason) {
      if (reason instanceof Error && reason.message === "E_ACK_TIMEOUT")
        await load();
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  const loadMore = async () => {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const page = await readRecords(queryFor(filters, nextCursor));
      setRecords((previous) => {
        const merged = [...previous, ...page.records];
        loadedTarget.current = merged.length;
        return merged;
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  const refreshDetail = async () => {
    await load();
    if (selectedId) setDetail((await readRecord(selectedId)) || undefined);
  };
  const collectAllIds = async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await readRecords({
        cursor: cursor || undefined,
        limit: 100,
      });
      ids.push(...page.records.map((record) => record.recordId));
      cursor = page.nextCursor;
    } while (cursor && ids.length < 10_000);
    return ids;
  };
  const startExport = async (ids: string[], title: string) => {
    setBusy(true);
    setError("");
    try {
      const plan = await planBackup(ids, data!.runtime.vaultEpoch);
      setExportPlan({ ...plan, title });
    } catch (reason) {
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  const versionsFor = async (ids: string[]) => {
    const found = await Promise.all(ids.map(readRecord));
    if (found.some((record) => !record)) throw new Error("E_CONFLICT");
    return found.map((record) => ({
      recordId: record!.recordId,
      expectedRevision: record!.revision,
    }));
  };
  const deleteRecords = () => {
    if (!data || !deleteIds.length) return;
    void perform(async () => {
      if (deleteIds.includes(selectedId || "")) {
        setSelectedId(undefined);
        setDetail(undefined);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      const targets = await versionsFor(deleteIds);
      const result = await command<{ count: number; releasedBytes: number }>(
        "UI_DELETE_RECORDS",
        { records: targets },
        data.runtime.vaultEpoch,
      );
      setChecked(new Set());
      setDeleteIds([]);
      announce(
        `${result.count} ${t("deleted")} · ${t("released")} ${humanSize(result.releasedBytes)}`,
      );
    });
  };
  const batchSubmission = () => {
    if (!data || !batchState) return;
    const summary = records
      .filter((record) => checked.has(record.recordId))
      .map(
        (record) =>
          `${record.file.name} · ${new Date(record.observedAt).toLocaleString(locale)} · ${record.page?.origin || t("manualSource")}`,
      )
      .join("\n");
    if (!window.confirm(`${t("submissionDisclaimer")}\n\n${summary}`)) return;
    void perform(async () => {
      const targets = await versionsFor([...checked]);
      await command(
        "UI_SET_SUBMISSION",
        { records: targets, state: batchState, note: null },
        data.runtime.vaultEpoch,
      );
    }, t("save")).then(() => {
      setBatchState(undefined);
      setChecked(new Set());
    });
  };
  const onboarded =
    localStorage.getItem("upload-ledger-onboarded") === "yes" ||
    data?.runtime.onboardingComplete;
  if (!data && loading)
    return (
      <div className="app-loading">
        <Brand />
        <RefreshCw className="spin" />
        <p>{t("loading")}</p>
      </div>
    );
  if (data && !onboarded)
    return (
      <Onboarding
        t={t}
        onDone={() => {
          localStorage.setItem("upload-ledger-onboarded", "yes");
          setData({ ...data });
        }}
      />
    );
  if (!data)
    return (
      <div className="app-loading">
        <CircleAlert />
        <p>{error || t("genericError")}</p>
        <button onClick={() => void load()}>{t("retry")}</button>
      </div>
    );
  const nav = [
    { id: "library" as const, label: t("library"), icon: BookOpen },
    { id: "sites" as const, label: t("sites"), icon: Globe2 },
    { id: "backup" as const, label: t("backup"), icon: Archive },
    { id: "settings" as const, label: t("settings"), icon: SettingsIcon },
  ];
  const filtered =
    filters.text ||
    filters.origin ||
    filters.snapshot ||
    filters.submission ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.tags ||
    filters.pinned;
  return (
    <div className="shell" lang={locale}>
      <aside className={`rail ${mobileNav ? "mobile-open" : ""}`}>
        <Brand />
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              className={section === item.id ? "active" : ""}
              onClick={() => {
                setSection(item.id);
                setMobileNav(false);
              }}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Menu"
            onClick={() => setMobileNav((value) => !value)}
          >
            <Menu size={20} />
          </button>
          <div className="top-summary">
            <Database size={17} />
            <span>
              {data.usage.recordCount} {t("records")}
            </span>
            <span>
              {humanSize(data.usage.chargedBytes)} /{" "}
              {humanSize(data.usage.budgetBytes)}
            </span>
          </div>
          <div className="top-actions">
            <button
              aria-label={t("manual")}
              onClick={() => setManualOpen(true)}
            >
              <Plus size={17} />
              {t("manual")}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  command(
                    "UI_SET_GLOBAL_PAUSE",
                    { paused: !data.runtime.paused },
                    data.runtime.vaultEpoch,
                  ),
                )
              }
            >
              {data.runtime.paused ? <Play size={17} /> : <Pause size={17} />}{" "}
              {data.runtime.paused ? t("resume") : t("pause")}
            </button>
          </div>
        </header>
        {data.runtime.paused && (
          <div className="paused-banner">
            <Pause size={17} />
            {t("pausedNotice")}
          </div>
        )}
        {error && (
          <div className="alert error page-alert" role="alert">
            <CircleAlert size={18} />
            <span>{error}</span>
            <button
              className="icon-button"
              onClick={() => setError("")}
              aria-label={t("close")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="live-region" aria-live="polite">
          {notice}
        </div>
        {section === "library" && (
          <>
            <div className="library-heading">
              <div>
                <h1>{t("library")}</h1>
              </div>
            </div>
            <div className="library-layout">
              <section className="library-pane">
                <div className="search-row">
                  <label className="search-box">
                    <Search size={18} />
                    <input
                      type="search"
                      aria-label={t("search")}
                      placeholder={t("search")}
                      value={filters.text}
                      onChange={(event) =>
                        setFilters({ ...filters, text: event.target.value })
                      }
                    />
                  </label>
                  <button className="filter-more" aria-label="Filters">
                    <MoreHorizontal size={19} />
                  </button>
                </div>
                <div className="filters">
                  <select
                    aria-label={t("allSites")}
                    value={filters.origin}
                    onChange={(event) =>
                      setFilters({ ...filters, origin: event.target.value })
                    }
                  >
                    <option value="">{t("allSites")}</option>
                    {data.sites.map((site) => (
                      <option key={site.exactOrigin} value={site.exactOrigin}>
                        {site.exactOrigin}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t("allCopies")}
                    value={filters.snapshot}
                    onChange={(event) =>
                      setFilters({ ...filters, snapshot: event.target.value })
                    }
                  >
                    <option value="">{t("allCopies")}</option>
                    {(
                      [
                        "ready",
                        "capturing",
                        "finalising",
                        "metadata_only",
                        "interrupted",
                        "failed",
                        "corrupt",
                      ] as const
                    ).map((value) => (
                      <option value={value} key={value}>
                        {t(`snapshot_${value}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t("allSubmissions")}
                    value={filters.submission}
                    onChange={(event) =>
                      setFilters({ ...filters, submission: event.target.value })
                    }
                  >
                    <option value="">{t("allSubmissions")}</option>
                    {(
                      [
                        "unknown",
                        "user_confirmed",
                        "user_reported_failed",
                        "user_reported_cancelled",
                      ] as const
                    ).map((value) => (
                      <option value={value} key={value}>
                        {t(`submission_${value}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                  <label>
                    <span>{t("from")}</span>
                    <input
                      type="date"
                      value={filters.dateFrom}
                      onChange={(event) =>
                        setFilters({ ...filters, dateFrom: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>{t("to")}</span>
                    <input
                      type="date"
                      value={filters.dateTo}
                      onChange={(event) =>
                        setFilters({ ...filters, dateTo: event.target.value })
                      }
                    />
                  </label>
                  <label className="tag-filter">
                    <Tag size={15} />
                    <input
                      aria-label={t("tags")}
                      placeholder={t("tags")}
                      value={filters.tags}
                      onChange={(event) =>
                        setFilters({ ...filters, tags: event.target.value })
                      }
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={filters.pinned}
                      onChange={(event) =>
                        setFilters({ ...filters, pinned: event.target.checked })
                      }
                    />
                    {t("pinnedOnly")}
                  </label>
                  <button
                    className="text-button"
                    onClick={() =>
                      setFilters({
                        text: "",
                        origin: "",
                        dateFrom: "",
                        dateTo: "",
                        snapshot: "",
                        submission: "",
                        tags: "",
                        pinned: false,
                      })
                    }
                  >
                    {t("clearFilters")}
                  </button>
                </div>
                {checked.size > 0 && (
                  <div className="batch-bar">
                    <b>
                      {checked.size} {t("selected")}
                    </b>
                    <select
                      aria-label={t("submissionBatch")}
                      value={batchState || ""}
                      onChange={(event) =>
                        setBatchState(event.target.value as SubmissionState)
                      }
                    >
                      <option value="">{t("submissionBatch")}</option>
                      {(
                        [
                          "unknown",
                          "user_confirmed",
                          "user_reported_failed",
                          "user_reported_cancelled",
                        ] as const
                      ).map((value) => (
                        <option key={value} value={value}>
                          {t(`submission_${value}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                    <button disabled={!batchState} onClick={batchSubmission}>
                      {t("apply")}
                    </button>
                    <button
                      onClick={() =>
                        void startExport([...checked], t("exportSelected"))
                      }
                    >
                      <Archive size={16} />
                      {t("exportSelected")}
                    </button>
                    <button
                      className="danger-quiet"
                      onClick={() => setDeleteIds([...checked])}
                    >
                      <Trash2 size={16} />
                      {t("deleteSelected")}
                    </button>
                  </div>
                )}
                <div className="list-head">
                  <label>
                    <input
                      type="checkbox"
                      aria-label={t("selectAllPage")}
                      checked={
                        records.length > 0 &&
                        records.every((record) => checked.has(record.recordId))
                      }
                      onChange={(event) =>
                        setChecked(
                          event.target.checked
                            ? new Set(records.map((record) => record.recordId))
                            : new Set(),
                        )
                      }
                    />
                    <span>{t("selectAllPage")}</span>
                  </label>
                  <span>
                    {records.length} / {data.usage.recordCount}
                  </span>
                </div>
                {loading ? (
                  <div className="list-loading">
                    <RefreshCw className="spin" />
                    <span>{t("loading")}</span>
                  </div>
                ) : records.length ? (
                  <>
                    <RecordList
                      records={records}
                      selectedId={selectedId}
                      checked={checked}
                      setChecked={setChecked}
                      onSelect={setSelectedId}
                      locale={locale}
                      t={t}
                    />
                    {nextCursor && (
                      <button
                        className="load-more"
                        disabled={busy}
                        onClick={() => void loadMore()}
                      >
                        {t("loadMore")}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="empty-state">
                    <div className="empty-mascot">
                      <img src="/icons/icon-128.png" alt="" />
                    </div>
                    <h2>{filtered ? t("noResults") : t("emptyTitle")}</h2>
                    <p>{t("emptyBody")}</p>
                    <button
                      className="primary"
                      onClick={() => setManualOpen(true)}
                    >
                      <Plus size={17} />
                      {t("manual")}
                    </button>
                  </div>
                )}
              </section>
              {detail && (
                <Detail
                  key={detail.recordId}
                  record={detail}
                  epoch={data.runtime.vaultEpoch}
                  locale={locale}
                  t={t}
                  onRefresh={refreshDetail}
                  onClose={() => setSelectedId(undefined)}
                  onCompare={() => setCompareOpen(true)}
                  onDelete={() => setDeleteIds([detail.recordId])}
                  announce={announce}
                />
              )}
            </div>
          </>
        )}
        {section === "sites" && (
          <SitesPanel
            data={data}
            locale={locale}
            t={t}
            reload={load}
            setError={setError}
          />
        )}{" "}
        {section === "backup" && (
          <BackupPanel
            data={data}
            locale={locale}
            t={t}
            collectIds={collectAllIds}
            startExport={startExport}
            reload={load}
            announce={announce}
          />
        )}{" "}
        {section === "settings" && (
          <SettingsPanel
            data={data}
            locale={locale}
            t={t}
            reload={load}
            setError={setError}
            announce={announce}
          />
        )}
      </main>
      {manualOpen && (
        <ManualDialog
          epoch={data.runtime.vaultEpoch}
          locale={locale}
          t={t}
          onClose={() => setManualOpen(false)}
          onComplete={async (id) => {
            await load();
            if (id) setSelectedId(id);
          }}
        />
      )}{" "}
      {compareOpen && detail && (
        <CompareDialog
          base={detail}
          records={records}
          epoch={data.runtime.vaultEpoch}
          locale={locale}
          t={t}
          onClose={() => setCompareOpen(false)}
        />
      )}{" "}
      {exportPlan && (
        <ExportDialog
          plan={exportPlan}
          epoch={data.runtime.vaultEpoch}
          locale={locale}
          t={t}
          onClose={() => setExportPlan(undefined)}
          announce={announce}
        />
      )}{" "}
      {deleteIds.length > 0 && (
        <Modal title={t("deleteTitle")} onClose={() => setDeleteIds([])}>
          <div className="alert error">
            <CircleAlert size={18} />
            <span>{t("deleteExplain")}</span>
          </div>
          <ul className="delete-list">
            {records
              .filter((record) => deleteIds.includes(record.recordId))
              .map((record) => (
                <li key={record.recordId}>
                  <bdi>{record.file.name}</bdi>
                  <small>
                    {new Date(record.observedAt).toLocaleString(locale)} ·{" "}
                    {record.page?.origin || t("manualSource")}
                  </small>
                </li>
              ))}
          </ul>
          <div className="modal-actions">
            <button onClick={() => setDeleteIds([])}>{t("cancel")}</button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={deleteRecords}
            >
              <Trash2 size={17} />
              {t("deleteSelected")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
