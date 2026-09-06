import React, { useEffect, useRef } from "react";
import { ChevronRight, X } from "lucide-react";
import { library, queryRecords, getRecord } from "../storage/read";
import type { RuntimeState } from "../shared/protocol";
import type {
  RecordQuery,
  SitePolicy,
  SnapshotState,
  StoredRecord,
  SubmissionState,
} from "../shared/model";
import errorCodes from "../shared/error-codes.json";
import { localDateBoundary } from "../preview/utils";
import { dictionaries, type Locale, type MessageKey } from "./i18n";

export const ELIGIBLE_STATES: SnapshotState[] = [
  "ready",
  "metadata_only",
  "interrupted",
  "failed",
];
export type RuntimeView = RuntimeState & {
  budgetBytes: number;
  excludedFileNames: string[];
  locale: Locale;
  theme: "system" | "light" | "dark";
  onboardingComplete?: boolean;
};
export type UsageView = {
  usedBytes: number;
  reservedBytes: number;
  chargedBytes: number;
  budgetBytes: number;
  recordCount: number;
  objectCount: number;
};
export type LibraryView = {
  records: StoredRecord[];
  nextCursor: string | null;
  sites: SitePolicy[];
  runtime: RuntimeView;
  usage: UsageView;
};
export type Filters = {
  text: string;
  origin: string;
  dateFrom: string;
  dateTo: string;
  snapshot: string;
  submission: string;
  tags: string;
  pinned: boolean;
};
export type ExportPlanView = {
  title: string;
  parts: Array<{ recordIds: string[]; estimatedBytes: number }>;
  excludedCount: number;
};
export type ImportReviewView = {
  jobId: string;
  recordCount: number;
  objectCount: number;
  skippedCount: number;
  conflictCount: number;
};
export type DiagnosticsView = {
  databaseVersion: number;
  protocolVersion: number;
  counts: Record<string, number>;
  usage: UsageView;
  runtime: RuntimeState;
};

export const readLibrary = library as unknown as (
  query?: RecordQuery,
) => Promise<LibraryView>;
export const readRecords = queryRecords as unknown as (
  query: RecordQuery,
) => Promise<{ records: StoredRecord[]; nextCursor: string | null }>;
export const readRecord = getRecord as unknown as (
  id: string,
) => Promise<StoredRecord | null>;

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function safeSource(
  input: string,
  mode: "origin_path" | "origin_only" = "origin_path",
): { origin: string; location: string } | null {
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return {
      origin: url.origin,
      location:
        mode === "origin_only" ? url.origin : `${url.origin}${url.pathname}`,
    };
  } catch {
    return null;
  }
}

export function queryFor(
  filters: Filters,
  cursor?: string | null,
): RecordQuery {
  const tags = filters.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    text: filters.text.trim() || undefined,
    origins: filters.origin ? [filters.origin] : undefined,
    dateFrom: localDateBoundary(filters.dateFrom),
    dateTo: localDateBoundary(filters.dateTo, true),
    snapshotStates: filters.snapshot
      ? [filters.snapshot as SnapshotState]
      : undefined,
    submissionStates: filters.submission
      ? [filters.submission as SubmissionState]
      : undefined,
    tags: tags.length ? tags : undefined,
    pinned: filters.pinned || undefined,
    cursor: cursor || undefined,
    limit: 100,
  };
}

export function errorText(
  error: unknown,
  locale: Locale,
  t: (key: MessageKey) => string,
): string {
  const explicitCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const code = explicitCode.startsWith("E_")
    ? explicitCode
    : error instanceof Error
      ? error.message
      : "";
  if (code === "E_ACK_TIMEOUT")
    return locale === "zh-CN"
      ? "响应超时，请刷新确认本次操作结果。"
      : "The response timed out. Refresh to check the result of this operation.";
  if (code === "E_CONFLICT") return t("changedError");
  const known = errorCodes.find((item) => item.code === code);
  return known?.[locale] || t("genericError");
}

export function useLocale(runtime?: RuntimeView) {
  const locale: Locale = runtime?.locale === "en-GB" ? "en-GB" : "zh-CN";
  const dictionary = dictionaries[locale];
  return { locale, t: (key: MessageKey) => dictionary[key] };
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prior =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current
      ?.querySelector<HTMLElement>("button, input, select, textarea")
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const nodes = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ) || []),
        ].filter((node) => node.getClientRects().length > 0);
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={`modal ${wide ? "modal-wide" : ""}`}
      >
        <div className="modal-title">
          <h2 id="dialog-title">{title}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <img src="/icons/icon-128.png" alt="" />
      <span>
        <strong>留底</strong>
        <small>UPLOAD LEDGER</small>
      </span>
    </div>
  );
}

export function StatusBadge({
  kind,
  value,
  t,
}: {
  kind: "snapshot" | "submission";
  value: string;
  t: (key: MessageKey) => string;
}) {
  return (
    <span className={`status-badge ${kind} state-${value}`}>
      {t(`${kind}_${value}` as MessageKey)}
    </span>
  );
}

export function Onboarding({
  t,
  onDone,
}: {
  t: (key: MessageKey) => string;
  onDone: () => void;
}) {
  const [accepted, setAccepted] = React.useState(false);
  return (
    <div className="onboarding">
      <section>
        <Brand />
        <div className="onboarding-mark">✓</div>
        <h1>{t("onboardingTitle")}</h1>
        <p className="lead">{t("onboardingBody")}</p>
        <div className="boundary">
          <span>▣</span>
          <p>{t("onboardingPlain")}</p>
        </div>
        <div className="boundary">
          <span>◎</span>
          <p>{t("onboardingBoundary")}</p>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>{t("onboardingAgree")}</span>
        </label>
        <button className="primary large" disabled={!accepted} onClick={onDone}>
          {t("onboardingContinue")} <ChevronRight size={18} />
        </button>
      </section>
    </div>
  );
}
