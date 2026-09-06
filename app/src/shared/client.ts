import defaults from "./config.defaults.json";
import type { PageContext } from "./model";
import type {
  BeginResult,
  CommandPayloads,
  CommandType,
  ProgressResult,
  Response,
  SessionReference,
} from "./protocol";
import { digest, encode } from "../domain/rules";

const automaticRetryCommands = new Set<CommandType>([
  "CAPTURE_HELLO",
  "CAPTURE_BEGIN",
  "CAPTURE_CHUNK",
  "CAPTURE_FINISH",
  "CAPTURE_RESUME",
  "CAPTURE_ABORT",
  "CAPTURE_SOURCE_GONE",
  "UI_GET_RUNTIME_STATE",
  "UI_GET_SITE_STATUS",
  "UI_GET_DIAGNOSTICS",
  "UI_MANUAL_BEGIN",
  "UI_MANUAL_CHUNK",
  "UI_MANUAL_FINISH",
  "UI_MANUAL_RESUME",
  "UI_MANUAL_ABORT",
]);

export async function command<T = unknown, K extends CommandType = CommandType>(
  type: K,
  payload: CommandPayloads[K],
  vaultEpoch: number | null = null,
): Promise<T> {
  const request = {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    vaultEpoch,
    type,
    payload,
  };
  const mayRetry = automaticRetryCommands.has(type);
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response<T>;
    try {
      response = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("E_ACK_TIMEOUT")),
          defaults.capture.ackTimeoutMs,
        );
        chrome.runtime.sendMessage(request).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    } catch (error) {
      if (!mayRetry || attempt === 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, defaults.capture.retryBackoffMs[attempt]),
      );
      continue;
    }
    if (!response?.ok) {
      const code =
        response && !response.ok ? response.error.code : "E_ACK_TIMEOUT";
      if (
        mayRetry &&
        response &&
        !response.ok &&
        response.error.retryable &&
        attempt < 3
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, defaults.capture.retryBackoffMs[attempt]),
        );
        continue;
      }
      throw new Error(code);
    }
    return response.data;
  }
  throw new Error("E_ACK_TIMEOUT");
}

export interface SendFilesOptions {
  source: "standard_input" | "user_drop" | "manual_snapshot";
  page: PageContext | null;
  vaultEpoch: number;
  batchEventId?: string;
  signal?: AbortSignal;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}
export interface SentFileResult {
  clientFileId: string;
  recordId: string | null;
  state: "committed" | "metadata_only" | "skipped" | "aborted";
  errorCode: string | null;
}
export interface SendFilesResult {
  batchId: string;
  files: SentFileResult[];
}

export async function sendFiles(
  files: readonly File[],
  options: SendFilesOptions,
): Promise<SendFilesResult> {
  if (
    !files.length ||
    files.length > defaults.capture.maxBatchFiles ||
    files.reduce((total, file) => total + file.size, 0) >
      defaults.capture.maxBatchBytes
  )
    throw new Error("E_BATCH_LIMIT");
  const candidates = files.map((file) => ({
    clientFileId: crypto.randomUUID(),
    name: file.name,
    byteLength: file.size,
    declaredMime: file.type.slice(0, 256),
    lastModified: file.lastModified,
  }));
  const manual = options.source === "manual_snapshot";
  let beginResult: BeginResult;
  if (options.source === "manual_snapshot") {
    beginResult = await command<BeginResult>(
      "UI_MANUAL_BEGIN",
      {
        batchEventId: options.batchEventId ?? crypto.randomUUID(),
        page: options.page,
        files: candidates,
      },
      options.vaultEpoch,
    );
  } else {
    beginResult = await command<BeginResult>(
      "CAPTURE_BEGIN",
      {
        batchEventId: options.batchEventId ?? crypto.randomUUID(),
        source: options.source,
        page: options.page!,
        files: candidates,
      },
      options.vaultEpoch,
    );
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  let doneBytes = 0;
  const output: SentFileResult[] = [];
  for (let fileIndex = 0; fileIndex < beginResult.files.length; fileIndex++) {
    const accepted = beginResult.files[fileIndex];
    const file = files[fileIndex];
    if (!accepted.sessionId || !accepted.token) {
      output.push({
        clientFileId: accepted.clientFileId,
        recordId: accepted.recordId,
        state: accepted.state === "skipped" ? "skipped" : "metadata_only",
        errorCode: accepted.errorCode,
      });
      continue;
    }
    const ref: SessionReference = {
      sessionId: accepted.sessionId,
      token: accepted.token,
    };
    const resumeType = manual ? "UI_MANUAL_RESUME" : "CAPTURE_RESUME";
    const chunkType = manual ? "UI_MANUAL_CHUNK" : "CAPTURE_CHUNK";
    const finishType = manual ? "UI_MANUAL_FINISH" : "CAPTURE_FINISH";
    const abortType = manual ? "UI_MANUAL_ABORT" : "CAPTURE_ABORT";
    try {
      let status = accepted.state;
      let nextIndex = accepted.nextChunkIndex;
      while (status === "queued") {
        if (options.signal?.aborted)
          throw new DOMException("Cancelled", "AbortError");
        const resumed = await command<ProgressResult>(
          resumeType,
          ref,
          options.vaultEpoch,
        );
        status = resumed.state === "queued" ? "queued" : "capturing";
        nextIndex = resumed.nextChunkIndex;
        if (status === "queued")
          await new Promise((resolve) =>
            setTimeout(resolve, resumed.retryAfterMs ?? 250),
          );
      }
      let index = nextIndex;
      while (index < Math.ceil(file.size / defaults.capture.rawChunkBytes)) {
        if (options.signal?.aborted)
          throw new DOMException("Cancelled", "AbortError");
        const bytes = new Uint8Array(
          await file
            .slice(
              index * defaults.capture.rawChunkBytes,
              (index + 1) * defaults.capture.rawChunkBytes,
            )
            .arrayBuffer(),
        );
        const expected = Math.min(
          defaults.capture.rawChunkBytes,
          file.size - index * defaults.capture.rawChunkBytes,
        );
        if (bytes.byteLength !== expected) throw new Error("E_SOURCE_CHANGED");
        try {
          await command<ProgressResult>(
            chunkType,
            {
              ...ref,
              index,
              rawLength: bytes.byteLength,
              base64: encode(bytes),
              chunkSha256: digest(bytes),
            },
            options.vaultEpoch,
          );
          doneBytes += bytes.byteLength;
          options.onProgress?.(doneBytes, totalBytes);
          index++;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "E_CHUNK_ORDER")
            throw error;
          const resumed = await command<ProgressResult>(
            resumeType,
            ref,
            options.vaultEpoch,
          );
          index = resumed.nextChunkIndex;
        }
      }
      const finished = await command<ProgressResult>(
        finishType,
        ref,
        options.vaultEpoch,
      );
      output.push({
        clientFileId: accepted.clientFileId,
        recordId: accepted.recordId,
        state: finished.state === "committed" ? "committed" : "aborted",
        errorCode: finished.state === "committed" ? null : "E_STORAGE_WRITE",
      });
    } catch (error) {
      const reason =
        error instanceof DOMException && error.name === "AbortError"
          ? "user_cancelled"
          : error instanceof Error && error.message === "E_SOURCE_CHANGED"
            ? "source_changed"
            : "read_failed";
      await command(abortType, { ...ref, reason }, options.vaultEpoch).catch(
        () => undefined,
      );
      output.push({
        clientFileId: accepted.clientFileId,
        recordId: accepted.recordId,
        state: "aborted",
        errorCode: error instanceof Error ? error.message : "E_READ_FAILED",
      });
    }
  }
  return { batchId: beginResult.batchId, files: output };
}
