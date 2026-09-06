import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowDownToLine,
  ChevronRight,
  CircleAlert,
  FileCheck2,
  FileClock,
  FileText,
  Globe2,
  Pin,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { command } from "../shared/client";
import { original } from "../storage/read";
import type { StoredRecord, SubmissionState } from "../shared/model";
import {
  openRecord,
  readRecordBytes,
  verifyRecordBytes,
  type PreviewResource,
} from "../preview";
import {
  boundedLineDiff,
  decodeUtf8,
  IMAGE_MAX_PIXELS,
  previewKind,
  safeDownloadName,
  TEXT_DIFF_BYTES,
  type DiffResult,
} from "../preview/utils";
import { PdfPreview } from "../preview/PdfPreview";
import type { Locale, MessageKey } from "./i18n";
import { errorText, humanSize, Modal, StatusBadge } from "./common";

export function RecordList({
  records,
  selectedId,
  checked,
  setChecked,
  onSelect,
  locale,
  t,
}: {
  records: StoredRecord[];
  selectedId?: string;
  checked: Set<string>;
  setChecked: Dispatch<SetStateAction<Set<string>>>;
  onSelect: (id: string) => void;
  locale: Locale;
  t: (key: MessageKey) => string;
}) {
  const toggle = (id: string) =>
    setChecked((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return (
    <div className="record-list" role="list">
      {records.map((record) => (
        <article
          role="listitem"
          key={record.recordId}
          className={`record-row ${selectedId === record.recordId ? "selected" : ""}`}
        >
          <label className="row-check">
            <input
              aria-label={`${t("selected")} ${record.file.name}`}
              type="checkbox"
              checked={checked.has(record.recordId)}
              onChange={() => toggle(record.recordId)}
            />
          </label>
          <button
            className="record-open"
            onClick={() => onSelect(record.recordId)}
          >
            <span className="file-tile">
              {record.user.pinned ? <Pin size={17} /> : <FileText size={19} />}
            </span>
            <span className="record-main">
              <strong>
                <bdi>{record.user.label || record.file.name}</bdi>
              </strong>
              <small>
                <bdi>
                  {record.page?.title ||
                    record.page?.origin ||
                    t("manualSource")}
                </bdi>{" "}
                · {humanSize(record.file.byteLength)}
              </small>
            </span>
            <span className="record-states">
              <StatusBadge
                kind="snapshot"
                value={record.snapshot.state}
                t={t}
              />
              <StatusBadge
                kind="submission"
                value={record.submission.state}
                t={t}
              />
            </span>
            <time dateTime={record.observedAt}>
              {new Date(record.observedAt).toLocaleString(locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <ChevronRight className="row-chevron" size={18} />
          </button>
        </article>
      ))}
    </div>
  );
}

function Preview({
  record,
  epoch,
  locale,
  t,
}: {
  record: StoredRecord;
  epoch: number;
  locale: Locale;
  t: (key: MessageKey) => string;
}) {
  const [resource, setResource] = useState<PreviewResource>();
  const [error, setError] = useState("");
  const [imageLimited, setImageLimited] = useState(false);
  useEffect(() => {
    let live = true;
    let opened: PreviewResource | undefined;
    setResource(undefined);
    setError("");
    setImageLimited(false);
    if (record.snapshot.state !== "ready") return;
    void openRecord(record, epoch)
      .then((value) => {
        opened = value;
        if (live) setResource(value);
        else void value.dispose();
      })
      .catch((reason) => {
        if (live) setError(errorText(reason, locale, t));
      });
    return () => {
      live = false;
      if (opened) void opened.dispose();
    };
  }, [record.recordId, record.revision, epoch]);
  if (record.snapshot.state !== "ready")
    return (
      <div className="preview-message">
        <FileClock size={28} />
        <p>{t(`snapshot_${record.snapshot.state}` as MessageKey)}</p>
      </div>
    );
  if (error)
    return (
      <div className="preview-message error-text">
        <CircleAlert size={28} />
        <p>{error}</p>
      </div>
    );
  if (!resource)
    return (
      <div className="preview-message">
        <RefreshCw className="spin" size={25} />
        <p>{t("previewLoading")}</p>
      </div>
    );
  if (resource.kind === "unsupported")
    return (
      <div className="preview-message">
        <FileText size={28} />
        <p>{t("previewUnsupported")}</p>
      </div>
    );
  if (resource.kind === "image_limit")
    return (
      <div className="preview-message">
        <CircleAlert size={28} />
        <p>{t("imageLimit")}</p>
      </div>
    );
  if (resource.kind === "text")
    return (
      <div className="text-preview">
        {resource.truncated && (
          <div className="preview-note">{t("previewTruncated")}</div>
        )}
        <pre>{resource.text}</pre>
      </div>
    );
  if (resource.kind === "image")
    return imageLimited ? (
      <div className="preview-message">
        <CircleAlert size={28} />
        <p>{t("imageLimit")}</p>
      </div>
    ) : (
      <div className="image-preview">
        <img
          src={resource.url}
          alt=""
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth * image.naturalHeight > IMAGE_MAX_PIXELS)
              setImageLimited(true);
          }}
        />
      </div>
    );
  return (
    <PdfPreview
      blob={resource.blob}
      labels={{
        failed: t("previewFailed"),
        encrypted: t("previewEncrypted"),
        previous: t("previous"),
        next: t("next"),
        zoomIn: t("zoomIn"),
        zoomOut: t("zoomOut"),
        fit: t("fit"),
        page: t("page"),
      }}
    />
  );
}

export function Detail({
  record,
  epoch,
  locale,
  t,
  onRefresh,
  onClose,
  onCompare,
  onDelete,
  announce,
}: {
  record: StoredRecord;
  epoch: number;
  locale: Locale;
  t: (key: MessageKey) => string;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onCompare: () => void;
  onDelete: () => void;
  announce: (text: string) => void;
}) {
  const [label, setLabel] = useState(record.user.label || "");
  const [note, setNote] = useState(record.user.note);
  const [tags, setTags] = useState(record.user.tags.join(", "));
  const [pinned, setPinned] = useState(record.user.pinned);
  const [submission, setSubmission] = useState<SubmissionState>(
    record.submission.state,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = useRef({ fields: false, submission: false });
  const revisions = useRef({
    fields: record.revision,
    submission: record.revision,
  });
  const syncDraft = (next: StoredRecord) => {
    if (!dirty.current.fields) {
      setLabel(next.user.label || "");
      setNote(next.user.note);
      setTags(next.user.tags.join(", "));
      setPinned(next.user.pinned);
      revisions.current.fields = next.revision;
    } else if (revisions.current.fields !== next.revision)
      setError(t("draftConflict"));
    if (!dirty.current.submission) {
      setSubmission(next.submission.state);
      revisions.current.submission = next.revision;
    } else if (revisions.current.submission !== next.revision)
      setError(t("draftConflict"));
  };
  useEffect(() => {
    syncDraft(record);
  }, [record.recordId, record.revision]);
  const perform = async (
    kind: "fields" | "submission",
    fn: () => Promise<StoredRecord>,
    message?: string,
  ) => {
    setBusy(true);
    setError("");
    const expectedRevision = revisions.current[kind];
    try {
      const updated = await fn();
      dirty.current[kind] = false;
      // A successful local write can advance another local draft based on the
      // same revision. A draft already stale before this write keeps its conflict.
      const other = kind === "fields" ? "submission" : "fields";
      if (revisions.current[other] === expectedRevision)
        revisions.current[other] = updated.revision;
      setError("");
      syncDraft(updated);
      await onRefresh();
      if (message) announce(message);
    } catch (reason) {
      setError(errorText(reason, locale, t));
      await onRefresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setBusy(true);
    setError("");
    let jobId = "";
    let outcome: "completed" | "failed" = "failed";
    try {
      const job = await command<{ jobId: string }>(
        "UI_PREPARE_PREVIEW",
        { recordId: record.recordId },
        epoch,
      );
      jobId = job.jobId;
      const file = await original(record.recordId, job.jobId);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = safeDownloadName(file.name || record.file.name);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      outcome = "completed";
      announce(t("downloadStarted"));
    } catch (reason) {
      setError(errorText(reason, locale, t));
    } finally {
      if (jobId)
        await command("UI_END_JOB", { jobId, outcome }, epoch).catch(
          () => undefined,
        );
      setBusy(false);
    }
  };
  return (
    <aside className="detail-panel" aria-label={t("details")}>
      <div className="detail-heading">
        <div>
          <h2>
            <bdi>{record.user.label || record.file.name}</bdi>
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {error && (
        <div className="alert error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <button
            disabled={busy}
            onClick={() => {
              dirty.current = { fields: false, submission: false };
              syncDraft(record);
              setError("");
            }}
          >
            {t("reloadRecord")}
          </button>
        </div>
      )}
      <div className="state-cards">
        <div>
          <span>{t("copyState")}</span>
          <StatusBadge kind="snapshot" value={record.snapshot.state} t={t} />
        </div>
        <div>
          <span>{t("submitState")}</span>
          <StatusBadge
            kind="submission"
            value={record.submission.state}
            t={t}
          />
        </div>
      </div>
      <section className="preview-card">
        <div className="section-label">
          <span>{t("preview")}</span>
          <span>{humanSize(record.file.byteLength)}</span>
        </div>
        <Preview record={record} epoch={epoch} locale={locale} t={t} />
      </section>
      <div className="detail-actions">
        <button
          className="primary"
          disabled={busy || record.snapshot.state !== "ready"}
          onClick={() => void download()}
        >
          <ArrowDownToLine size={17} />
          {t("download")}
        </button>
        {record.page && (
          <a
            className="button-link"
            href={record.page.location}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Globe2 size={17} />
            {t("openSource")}
          </a>
        )}
        <button
          disabled={record.snapshot.state !== "ready"}
          onClick={onCompare}
        >
          <FileCheck2 size={17} />
          {t("compare")}
        </button>
      </div>
      <section className="detail-section">
        <h3>{t("updateSubmission")}</h3>
        <select
          aria-label={t("submitState")}
          disabled={busy}
          value={submission}
          onChange={(event) => {
            dirty.current.submission = true;
            setSubmission(event.target.value as SubmissionState);
          }}
        >
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
        <button
          disabled={busy || submission === record.submission.state}
          onClick={() =>
            void perform(
              "submission",
              async () =>
                (
                  await command<{ records: StoredRecord[] }>(
                    "UI_SET_SUBMISSION",
                    {
                      records: [
                        {
                          recordId: record.recordId,
                          expectedRevision: revisions.current.submission,
                        },
                      ],
                      state: submission,
                      note: null,
                    },
                    epoch,
                  )
                ).records[0],
              t("save"),
            )
          }
        >
          {t("updateSubmission")}
        </button>
      </section>
      <section className="detail-section">
        <h3>{t("editFields")}</h3>
        <label>
          {t("label")}
          <input
            maxLength={120}
            disabled={busy}
            aria-label={t("label")}
            value={label}
            onChange={(event) => {
              dirty.current.fields = true;
              setLabel(event.target.value);
            }}
          />
        </label>
        <label>
          {t("note")}
          <textarea
            maxLength={4000}
            rows={4}
            disabled={busy}
            aria-label={t("note")}
            value={note}
            onChange={(event) => {
              dirty.current.fields = true;
              setNote(event.target.value);
            }}
          />
        </label>
        <label>
          {t("tags")}
          <input
            disabled={busy}
            aria-label={t("tags")}
            value={tags}
            onChange={(event) => {
              dirty.current.fields = true;
              setTags(event.target.value);
            }}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            disabled={busy}
            checked={pinned}
            onChange={(event) => {
              dirty.current.fields = true;
              setPinned(event.target.checked);
            }}
          />
          {t("pinned")}
        </label>
        <button
          disabled={busy}
          onClick={() =>
            void perform(
              "fields",
              () =>
                command<StoredRecord>(
                  "UI_SET_USER_FIELDS",
                  {
                    recordId: record.recordId,
                    expectedRevision: revisions.current.fields,
                    fields: {
                      label: label.trim() || null,
                      note,
                      tags: tags
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean)
                        .slice(0, 10),
                      pinned,
                    },
                  },
                  epoch,
                ),
              t("save"),
            )
          }
        >
          {t("saveFields")}
        </button>
      </section>
      <section className="detail-section metadata">
        <h3>{t("details")}</h3>
        <dl>
          <dt>{t("originalName")}</dt>
          <dd>
            <bdi>{record.file.name}</bdi>
          </dd>
          <dt>{t("observedAt")}</dt>
          <dd>
            <time dateTime={record.observedAt}>
              {new Date(record.observedAt).toLocaleString(locale)}
              <small>{record.observedAt}</small>
            </time>
          </dd>
          <dt>{t("capturedAt")}</dt>
          <dd>
            {record.snapshot.capturedAt
              ? new Date(record.snapshot.capturedAt).toLocaleString(locale)
              : "—"}
          </dd>
          <dt>{t("source")}</dt>
          <dd>
            <bdi>{record.page?.location || t("manualSource")}</bdi>
          </dd>
          <dt>{t("fileSize")}</dt>
          <dd>{humanSize(record.file.byteLength)}</dd>
          <dt>{t("sha")}</dt>
          <dd className="hash">
            <span>{record.snapshot.objectSha256 || "—"}</span>
            {record.snapshot.objectSha256 && (
              <button
                className="mini-button"
                aria-label="Copy SHA-256"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    record.snapshot.objectSha256!,
                  )
                }
              >
                Copy
              </button>
            )}
          </dd>
          <dt>{t("captureSource")}</dt>
          <dd>{record.source}</dd>
          <dt>{t("importedAt")}</dt>
          <dd>
            {record.importedAt
              ? new Date(record.importedAt).toLocaleString(locale)
              : "—"}
          </dd>
          <dt>{t("revision")}</dt>
          <dd>{record.revision}</dd>
        </dl>
      </section>
      <section className="danger-zone">
        <button className="danger-button" onClick={onDelete}>
          <Trash2 size={17} />
          {t("deleteSelected")}
        </button>
      </section>
    </aside>
  );
}

type CompareOutput = {
  left: { name: string; size: number; sha: string | null };
  right: { name: string; size: number; sha: string | null };
  diff: DiffResult;
};
function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
export function CompareDialog({
  base,
  records,
  epoch,
  locale,
  t,
  onClose,
}: {
  base: StoredRecord;
  records: StoredRecord[];
  epoch: number;
  locale: Locale;
  t: (key: MessageKey) => string;
  onClose: () => void;
}) {
  const [rightId, setRightId] = useState(
    records.find((item) => item.recordId !== base.recordId)?.recordId || "",
  );
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState<CompareOutput>();
  const compare = async () => {
    setBusy(true);
    setError("");
    setOutput(undefined);
    try {
      const rightRecord = file
        ? undefined
        : records.find((item) => item.recordId === rightId);
      if (!file && !rightRecord) return;
      await verifyRecordBytes(base, epoch);
      if (rightRecord) await verifyRecordBytes(rightRecord, epoch);
      let rightSha: string | null = rightRecord?.snapshot.objectSha256 || null;
      const rightSize = rightRecord?.file.byteLength ?? file!.size;
      const rightName = rightRecord?.file.name ?? file!.name;
      let currentBytes: Uint8Array | undefined;
      if (file) {
        if (file.size > 50 * 1024 * 1024) throw new Error("E_FILE_TOO_LARGE");
        const buffer = await file.arrayBuffer();
        currentBytes = new Uint8Array(buffer);
        rightSha = hex(await crypto.subtle.digest("SHA-256", buffer));
      }
      let diff: DiffResult = { state: "binary", rows: [] };
      if (
        base.snapshot.objectSha256 &&
        rightSha &&
        base.snapshot.objectSha256 === rightSha &&
        base.file.byteLength === rightSize
      )
        diff = { state: "identical", rows: [] };
      else if (
        base.file.byteLength <= TEXT_DIFF_BYTES &&
        rightSize <= TEXT_DIFF_BYTES &&
        previewKind(base.file) === "text" &&
        (file
          ? previewKind({
              name: file.name,
              declaredMime: file.type,
              byteLength: file.size,
              lastModified: file.lastModified,
            }) === "text"
          : rightRecord && previewKind(rightRecord.file) === "text")
      ) {
        const left = await readRecordBytes(base, epoch);
        const rightBytes =
          currentBytes ?? (await readRecordBytes(rightRecord!, epoch)).bytes;
        const leftText = decodeUtf8(left.bytes);
        const rightText = decodeUtf8(rightBytes);
        diff =
          leftText === null || rightText === null
            ? { state: "binary", rows: [] }
            : boundedLineDiff(leftText, rightText);
      }
      setOutput({
        left: {
          name: base.file.name,
          size: base.file.byteLength,
          sha: base.snapshot.objectSha256,
        },
        right: { name: rightName, size: rightSize, sha: rightSha },
        diff,
      });
    } catch (reason) {
      setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("compareTitle")} onClose={onClose} wide>
      <div className="compare-chooser">
        <div>
          <span>{t("left")}</span>
          <b>
            <bdi>{base.file.name}</bdi>
          </b>
          <small>{new Date(base.observedAt).toLocaleString(locale)}</small>
        </div>
        <div>
          <label>
            {t("right")}
            <select
              value={rightId}
              disabled={Boolean(file)}
              onChange={(event) => setRightId(event.target.value)}
            >
              <option value="">{t("chooseRecord")}</option>
              {records
                .filter(
                  (item) =>
                    item.recordId !== base.recordId &&
                    item.snapshot.state === "ready",
                )
                .map((item) => (
                  <option key={item.recordId} value={item.recordId}>
                    {item.file.name} —{" "}
                    {new Date(item.observedAt).toLocaleString(locale)}
                  </option>
                ))}
            </select>
          </label>
          <label className="file-choice">
            {t("chooseCurrent")}
            <input
              type="file"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
          </label>
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <button
        className="primary"
        disabled={busy || (!file && !rightId)}
        onClick={() => void compare()}
      >
        {busy ? t("loading") : t("runCompare")}
      </button>
      {output && (
        <div className="compare-output">
          <div className="compare-summary">
            <div>
              <b>{t("left")}</b>
              <span>
                <bdi>{output.left.name}</bdi>
              </span>
              <small>
                {humanSize(output.left.size)} ·{" "}
                {output.left.sha?.slice(0, 16) || "—"}
              </small>
            </div>
            <div>
              <b>{t("right")}</b>
              <span>
                <bdi>{output.right.name}</bdi>
              </span>
              <small>
                {humanSize(output.right.size)} ·{" "}
                {output.right.sha?.slice(0, 16) || "—"}
              </small>
            </div>
          </div>
          <h3>
            {output.diff.state === "identical"
              ? t("identical")
              : t("different")}
          </h3>
          {output.diff.state === "limited" && <p>{t("diffLimited")}</p>}
          {output.diff.state === "binary" && <p>{t("binaryDiff")}</p>}
          {output.diff.rows.length > 0 && (
            <div className="diff-view" role="table">
              {output.diff.rows.map((row, index) => (
                <div role="row" className={`diff-${row.kind}`} key={index}>
                  <span>
                    {row.kind === "add"
                      ? "+"
                      : row.kind === "remove"
                        ? "−"
                        : " "}
                  </span>
                  <pre>{row.text || " "}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
