import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  FileArchive,
  Upload,
} from "lucide-react";
import { sendFiles } from "../shared/client";
import { exportBackup } from "../backup/client";
import type { Locale, MessageKey } from "./i18n";
import {
  errorText,
  humanSize,
  Modal,
  safeSource,
  type ExportPlanView,
} from "./common";
import { safeDownloadName } from "../preview/utils";

export function ManualDialog({
  epoch,
  locale,
  t,
  onClose,
  onComplete,
}: {
  epoch: number;
  locale: Locale;
  t: (key: MessageKey) => string;
  onClose: () => void;
  onComplete: (recordId?: string) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const abort = useRef<AbortController | null>(null);
  const close = () => {
    abort.current?.abort();
    onClose();
  };
  useEffect(() => () => abort.current?.abort(), []);
  const upload = async () => {
    const cleaned = source.trim() ? safeSource(source) : null;
    if (source.trim() && !cleaned) {
      setError(errorText(new Error("E_INVALID_URL"), locale, t));
      return;
    }
    setBusy(true);
    setError("");
    abort.current = new AbortController();
    try {
      const result = await sendFiles(files, {
        source: "manual_snapshot",
        page: cleaned
          ? {
              ...cleaned,
              locationMode: "origin_path",
              title: title.trim() || null,
            }
          : null,
        vaultEpoch: epoch,
        signal: abort.current.signal,
        onProgress: (done: number, total: number) =>
          setProgress(`${humanSize(done)} / ${humanSize(total)}`),
      });
      const recordId =
        result.files.find((item) => item.recordId)?.recordId || undefined;
      await onComplete(recordId || undefined);
      onClose();
    } catch (reason) {
      if ((reason as Error)?.name !== "AbortError")
        setError(errorText(reason, locale, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("manualTitle")} onClose={close}>
      <label className="file-drop">
        <Upload size={28} />
        <span>{t("chooseFiles")}</span>
        <input
          disabled={busy}
          aria-label={t("chooseFiles")}
          type="file"
          multiple
          onChange={(event) => setFiles(Array.from(event.target.files || []))}
        />
        <small>
          {files.length} {t("chosenFiles")}
        </small>
      </label>
      <label>
        {t("optionalSource")}
        <input
          disabled={busy}
          type="url"
          value={source}
          placeholder="https://example.com/path"
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <label>
        {t("optionalTitle")}
        <input
          disabled={busy}
          maxLength={256}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {progress && (
        <p className="progress-text" role="status">
          {t("uploading")} · {progress}
        </p>
      )}
      <div className="modal-actions">
        <button onClick={close}>{t("cancel")}</button>
        <button
          className="primary"
          disabled={busy || files.length === 0}
          onClick={() => void upload()}
        >
          {busy ? t("uploading") : t("upload")}
        </button>
      </div>
    </Modal>
  );
}

export function ExportDialog({
  plan,
  epoch,
  locale,
  t,
  onClose,
  announce,
}: {
  plan: ExportPlanView;
  epoch: number;
  locale: Locale;
  t: (key: MessageKey) => string;
  onClose: () => void;
  announce: (text: string) => void;
}) {
  const [running, setRunning] = useState<number>();
  const [done, setDone] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const close = () => {
    abort.current?.abort();
    onClose();
  };
  useEffect(() => () => abort.current?.abort(), []);
  const savePart = async (
    part: ExportPlanView["parts"][number],
    index: number,
  ) => {
    setRunning(index);
    setError("");
    abort.current = new AbortController();
    try {
      const picker = (
        window as Window & {
          showSaveFilePicker?: (options: Record<string, unknown>) => Promise<{
            createWritable: () => Promise<WritableStream<Uint8Array>>;
          }>;
        }
      ).showSaveFilePicker;
      let writable: WritableStream<Uint8Array> | undefined;
      if (picker) {
        const handle = await picker({
          suggestedName: `upload-ledger-backup-part-${index + 1}.zip`,
          types: [
            {
              description: "ZIP archive",
              accept: { "application/zip": [".zip"] },
            },
          ],
        });
        writable = await handle.createWritable();
      }
      const result = await exportBackup(part.recordIds, epoch, {
        signal: abort.current.signal,
        writable,
        onProgress: (value, total) =>
          setProgress(`${humanSize(value)} / ${humanSize(total)}`),
      });
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = safeDownloadName(result.fileName);
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setDone((previous) => new Set(previous).add(index));
      announce(t("backupDone"));
    } catch (reason) {
      if ((reason as Error)?.name !== "AbortError")
        setError(errorText(reason, locale, t));
    } finally {
      setRunning(undefined);
      setProgress("");
    }
  };
  return (
    <Modal title={t("exportPlan")} onClose={close}>
      <div className="backup-kind">
        <FileArchive size={24} />
        <div>
          <b>{plan.excludedCount ? t("partialBackup") : t("completeBackup")}</b>
          <p>
            {plan.excludedCount
              ? `${plan.excludedCount} ${t("excluded")}`
              : `${plan.parts.reduce((sum, part) => sum + part.recordIds.length, 0)} ${t("records")}`}
          </p>
        </div>
      </div>
      <div className="alert neutral">
        <span>{t("backupPlain")}</span>
      </div>
      <p>
        {plan.parts.length} {t("parts")}
      </p>
      <div className="part-list">
        {plan.parts.map((part, index) => (
          <div key={index}>
            <span>
              <b>{index + 1}</b>
              <small>
                {part.recordIds.length} {t("records")} ·{" "}
                {humanSize(part.estimatedBytes)}
              </small>
            </span>
            <button
              className={done.has(index) ? "success-button" : ""}
              disabled={running !== undefined || done.has(index)}
              onClick={() => void savePart(part, index)}
            >
              {done.has(index) ? (
                <Check size={16} />
              ) : (
                <ArrowDownToLine size={16} />
              )}{" "}
              {done.has(index) ? t("backupDone") : t("exportPart")}
            </button>
          </div>
        ))}
      </div>
      {running !== undefined && (
        <div className="progress-text" role="status">
          {t("exportProgress")} · {progress}
          <button
            className="text-button"
            onClick={() => abort.current?.abort()}
          >
            {t("cancel")}
          </button>
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          <CircleAlert size={17} />
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button onClick={close}>{t("close")}</button>
      </div>
    </Modal>
  );
}
