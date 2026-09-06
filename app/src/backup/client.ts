import { sha256 } from "@noble/hashes/sha2.js";
import {
  BlobReader,
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  ZipReader,
  ZipWriter,
  configure,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";
import defaults from "../shared/config.defaults.json";
import type { ArchiveManifest } from "../shared/model";
import type { JobResult } from "../shared/protocol";
import { command } from "../shared/client";
import { digest, encode, hex } from "../domain/rules";
import {
  getJobManifest,
  getRecord,
  iterateObjectChunks,
  library,
} from "../storage/read";
import { ArchiveValidationError, parseAndValidateManifest } from "./manifest";

configure({ useWebWorkers: false });
const limits = defaults.backup;
const CHUNK = defaults.capture.rawChunkBytes;
const pathPattern = /^objects\/[0-9a-f]{64}\.bin$/;
const abort = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
};
const zipOverhead = (names: string[]) =>
  22 +
  names.reduce(
    (sum, name) =>
      sum + 30 + 46 + 2 * new TextEncoder().encode(name).byteLength + 40,
    0,
  );
// Reserve the full permitted manifest size so each planned part remains exportable
// when a small record set has unusually large audit histories or metadata.
const estimatedManifest = () => limits.maxManifestBytes;

export async function planBackup(
  recordIds: string[],
  vaultEpoch: number,
): Promise<{
  parts: Array<{ recordIds: string[]; estimatedBytes: number }>;
  excludedCount: number;
}> {
  const unique = [...new Set(recordIds)];
  const snapshot = await library();
  if (snapshot.runtime.clearing) throw new Error("E_CLEARING");
  if (snapshot.runtime.vaultEpoch !== vaultEpoch)
    throw new Error("E_VAULT_EPOCH");
  const records = [];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const found = await Promise.all(
      unique.slice(offset, offset + 50).map((recordId) => getRecord(recordId)),
    );
    records.push(...found.filter((record) => record !== null));
  }
  const eligible = records.filter((record) =>
    ["ready", "metadata_only", "interrupted", "failed"].includes(
      record.snapshot.state,
    ),
  );
  let excludedCount = unique.length - eligible.length;
  const parts: Array<{ recordIds: string[]; estimatedBytes: number }> = [];
  let ids: string[] = [],
    objects = new Map<string, number>(),
    bytes = estimatedManifest() + zipOverhead(["manifest.json"]);
  const flush = () => {
    if (ids.length) parts.push({ recordIds: ids, estimatedBytes: bytes });
    ids = [];
    objects = new Map();
    bytes = estimatedManifest() + zipOverhead(["manifest.json"]);
  };
  for (const record of eligible) {
    const sha = record.snapshot.objectSha256;
    const objectCost = () =>
      sha && !objects.has(sha)
        ? record.file.byteLength + zipOverhead([`objects/${sha}.bin`])
        : 0;
    let candidate = bytes + objectCost();
    if (ids.length && candidate > limits.blobFallbackMaxBytes) {
      flush();
      candidate = bytes + objectCost();
    }
    if (candidate > limits.blobFallbackMaxBytes) {
      excludedCount++;
      continue;
    }
    ids.push(record.recordId);
    bytes = candidate;
    if (sha) objects.set(sha, record.file.byteLength);
  }
  flush();
  return { parts, excludedCount };
}

function objectStream(
  sha: string,
  jobId: string,
  expected: number,
  signal: AbortSignal | undefined,
  progress: (count: number) => void,
  guard: () => void,
) {
  const iterator = iterateObjectChunks(sha, jobId)[Symbol.asyncIterator]();
  const hash = sha256.create();
  let count = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        abort(signal);
        guard();
        const next = await iterator.next();
        if (next.done) {
          if (count !== expected || hex(hash.digest()) !== sha)
            throw new ArchiveValidationError(
              "E_ARCHIVE_HASH",
              "Stored object integrity failed",
            );
          controller.close();
          return;
        }
        const bytes = next.value;
        count += bytes.byteLength;
        if (count > expected)
          throw new ArchiveValidationError(
            "E_ARCHIVE_HASH",
            "Stored object exceeds descriptor",
          );
        hash.update(bytes);
        progress(bytes.byteLength);
        controller.enqueue(bytes);
      } catch (error) {
        controller.error(error);
        await iterator.return?.();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export async function exportBackup(
  recordIds: string[],
  vaultEpoch: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    writable?: WritableStream<Uint8Array>;
  } = {},
): Promise<{ blob: Blob | null; fileName: string; recordCount: number }> {
  abort(options.signal);
  const prepared = await command<JobResult>(
    "UI_PREPARE_EXPORT",
    { recordIds },
    vaultEpoch,
  );
  let outcome: "completed" | "cancelled" | "failed" = "failed";
  let destination: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let heartbeatError: unknown;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const manifest = await getJobManifest(prepared.jobId);
    await command("UI_HEARTBEAT_JOB", { jobId: prepared.jobId }, vaultEpoch);
    heartbeatTimer = setInterval(() => {
      void command(
        "UI_HEARTBEAT_JOB",
        { jobId: prepared.jobId },
        vaultEpoch,
      ).catch((error) => {
        heartbeatError = error;
      });
    }, 30_000);
    const guard = () => {
      if (heartbeatError) throw heartbeatError;
    };
    const raw = new TextEncoder().encode(JSON.stringify(manifest));
    parseAndValidateManifest(raw);
    const names = [
      "manifest.json",
      ...manifest.objects.map((object) => object.path),
    ];
    const upper =
      raw.byteLength +
      manifest.objects.reduce((sum, object) => sum + object.byteLength, 0) +
      zipOverhead(names);
    if (upper > limits.blobFallbackMaxBytes)
      throw new ArchiveValidationError(
        "E_ARCHIVE_LIMIT",
        "Package exceeds part limit",
      );
    let written = 0;
    const total = manifest.objects.reduce(
      (sum, object) => sum + object.byteLength,
      0,
    );
    const report = (amount: number) => {
      written += amount;
      options.onProgress?.(written, total);
    };
    let blobWriter: BlobWriter | undefined;
    let count = 0;
    let output: WritableStream<Uint8Array> | BlobWriter;
    if (options.writable) {
      destination = options.writable.getWriter();
      const sink = destination;
      output = new WritableStream<Uint8Array>({
        write(chunk) {
          guard();
          count += chunk.byteLength;
          if (count > limits.blobFallbackMaxBytes)
            throw new ArchiveValidationError(
              "E_ARCHIVE_LIMIT",
              "ZIP exceeds package limit",
            );
          return sink.write(chunk);
        },
        close() {
          return sink.close();
        },
        abort(reason) {
          return sink.abort(reason);
        },
      });
    } else {
      blobWriter = new BlobWriter("application/zip");
      output = blobWriter;
    }
    const writer = new ZipWriter(output, { useWebWorkers: false });
    await writer.add("manifest.json", new Uint8ArrayReader(raw), {
      level: 0,
      signal: options.signal,
    });
    for (const object of manifest.objects) {
      abort(options.signal);
      guard();
      await writer.add(
        object.path,
        objectStream(
          object.sha256,
          prepared.jobId,
          object.byteLength,
          options.signal,
          report,
          guard,
        ),
        { level: 0, signal: options.signal },
      );
    }
    await writer.close();
    const blob = blobWriter ? await blobWriter.getData() : null;
    if (blob && blob.size > limits.blobFallbackMaxBytes)
      throw new ArchiveValidationError(
        "E_ARCHIVE_LIMIT",
        "ZIP exceeds Blob fallback limit",
      );
    outcome = "completed";
    return {
      blob,
      fileName: `upload-ledger-backup-${manifest.createdAt.slice(0, 10)}-${manifest.archiveId}.zip`,
      recordCount: manifest.records.length,
    };
  } catch (error) {
    outcome = options.signal?.aborted ? "cancelled" : "failed";
    if (destination) await destination.abort(error).catch(() => {});
    throw error;
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    await command(
      "UI_END_JOB",
      { jobId: prepared.jobId, outcome },
      vaultEpoch,
    ).catch(() => {});
  }
}

type StrictEntry = FileEntry & { filename: string };
function inspectEntries(entries: Entry[]) {
  if (entries.length > limits.maxObjectCount + 1)
    throw new ArchiveValidationError("E_ARCHIVE_LIMIT", "Too many ZIP entries");
  const names = new Set<string>();
  let total = 0;
  let manifest: StrictEntry | undefined;
  const objects = new Map<string, StrictEntry>();
  for (const entry of entries) {
    const name = entry.filename;
    if (names.has(name))
      throw new ArchiveValidationError("E_ARCHIVE_PATH", "Duplicate ZIP entry");
    names.add(name);
    if (
      entry.directory ||
      entry.symlink ||
      entry.encrypted ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      (name !== "manifest.json" && !pathPattern.test(name))
    )
      throw new ArchiveValidationError("E_ARCHIVE_PATH", "Unsafe ZIP entry");
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
      throw new ArchiveValidationError(
        "E_ARCHIVE_FORMAT",
        "Unsupported compression",
      );
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0
    )
      throw new ArchiveValidationError("E_ARCHIVE_LIMIT", "Invalid ZIP size");
    total += entry.uncompressedSize;
    if (total > limits.maxArchiveUncompressedBytes)
      throw new ArchiveValidationError(
        "E_ARCHIVE_LIMIT",
        "Archive output too large",
      );
    if (name === "manifest.json") manifest = entry as StrictEntry;
    else objects.set(name, entry as StrictEntry);
  }
  if (!manifest)
    throw new ArchiveValidationError("E_ARCHIVE_FORMAT", "Missing manifest");
  if (manifest.uncompressedSize > limits.maxManifestBytes)
    throw new ArchiveValidationError("E_ARCHIVE_LIMIT", "Manifest too large");
  return { manifest, objects, total, names };
}

async function readEntry(
  entry: StrictEntry,
  max: number,
  signal: AbortSignal | undefined,
  onChunk?: (chunk: Uint8Array) => Promise<void>,
) {
  const chunks: Uint8Array[] = [];
  let count = 0;
  const writable = new WritableStream<Uint8Array>({
    async write(value) {
      abort(signal);
      for (let offset = 0; offset < value.byteLength; offset += CHUNK) {
        const chunk = value.slice(
          offset,
          Math.min(offset + CHUNK, value.byteLength),
        );
        count += chunk.byteLength;
        if (count > max || count > entry.uncompressedSize)
          throw new ArchiveValidationError(
            "E_ARCHIVE_LIMIT",
            "Actual ZIP output exceeds limit",
          );
        if (onChunk) await onChunk(chunk);
        else chunks.push(chunk);
      }
    },
  });
  await entry.getData(writable, {
    checkSignature: true,
    checkLocalDirectory: true,
    strictness: "strict",
    signal,
    useWebWorkers: false,
  });
  if (count !== entry.uncompressedSize)
    throw new ArchiveValidationError("E_ARCHIVE_FORMAT", "ZIP length mismatch");
  if (onChunk) return new Uint8Array();
  const result = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function inspectBackup(
  file: File,
  vaultEpoch: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{
  jobId: string;
  recordCount: number;
  objectCount: number;
  skippedCount: number;
  conflictCount: number;
}> {
  abort(options.signal);
  if (file.size > limits.maxArchiveUncompressedBytes + 64 * 1024 * 1024)
    throw new ArchiveValidationError(
      "E_ARCHIVE_LIMIT",
      "Archive file too large",
    );
  const reader = new ZipReader(new BlobReader(file), {
    strictness: "strict",
    useWebWorkers: false,
  });
  let jobId: string | undefined;
  try {
    const entries = await reader.getEntries({ strictness: "strict" });
    const inspected = inspectEntries(entries);
    const raw = await readEntry(
      inspected.manifest,
      limits.maxManifestBytes,
      options.signal,
    );
    const manifest = parseAndValidateManifest(raw);
    const expected = new Set([
      "manifest.json",
      ...manifest.objects.map((object) => object.path),
    ]);
    if (
      expected.size !== inspected.names.size ||
      [...expected].some((name) => !inspected.names.has(name))
    )
      throw new ArchiveValidationError(
        "E_ARCHIVE_REFERENCE",
        "ZIP and manifest objects differ",
      );
    for (const object of manifest.objects) {
      const entry = inspected.objects.get(object.path);
      if (!entry || entry.uncompressedSize !== object.byteLength)
        throw new ArchiveValidationError(
          "E_ARCHIVE_REFERENCE",
          "Object size mismatch",
        );
    }
    const begun = await command<{ jobId: string }>(
      "UI_IMPORT_BEGIN",
      {
        manifestByteLength: raw.byteLength,
        archiveByteLength: inspected.total,
      },
      vaultEpoch,
    );
    jobId = begun.jobId;
    const activeJobId = jobId;
    let index = 0;
    for (let offset = 0; offset < raw.byteLength; offset += CHUNK) {
      abort(options.signal);
      const chunk = raw.slice(offset, Math.min(offset + CHUNK, raw.byteLength));
      await command(
        "UI_IMPORT_MANIFEST_CHUNK",
        {
          jobId: activeJobId,
          index,
          rawLength: chunk.byteLength,
          base64: encode(chunk),
          chunkSha256: digest(chunk),
        },
        vaultEpoch,
      );
      index++;
    }
    let status = await command<{
      recordCount: number;
      objectCount: number;
      skippedCount: number;
      conflictCount: number;
      status: string;
    }>("UI_IMPORT_MANIFEST_FINISH", { jobId: activeJobId }, vaultEpoch);
    let done = raw.byteLength;
    options.onProgress?.(done, inspected.total);
    for (const object of manifest.objects) {
      abort(options.signal);
      const started = await command<{
        sessionId: string;
        token: string;
        nextChunkIndex: number;
      }>(
        "UI_IMPORT_OBJECT_BEGIN",
        {
          jobId: activeJobId,
          sha256: object.sha256,
          byteLength: object.byteLength,
        },
        vaultEpoch,
      );
      let chunkIndex = 0;
      await readEntry(
        inspected.objects.get(object.path)!,
        object.byteLength,
        options.signal,
        async (chunk) => {
          const payload = {
            jobId: activeJobId,
            sessionId: started.sessionId,
            token: started.token,
            index: chunkIndex,
            rawLength: chunk.byteLength,
            base64: encode(chunk),
            chunkSha256: digest(chunk),
          };
          await command("UI_IMPORT_OBJECT_CHUNK", payload, vaultEpoch);
          chunkIndex++;
          done += chunk.byteLength;
          options.onProgress?.(done, inspected.total);
        },
      );
      status = await command(
        "UI_IMPORT_OBJECT_FINISH",
        {
          jobId: activeJobId,
          sessionId: started.sessionId,
          token: started.token,
        },
        vaultEpoch,
      );
    }
    if (status.status !== "validated")
      throw new ArchiveValidationError(
        "E_ARCHIVE_FORMAT",
        "Import did not validate",
      );
    return {
      jobId,
      recordCount: status.recordCount,
      objectCount: status.objectCount,
      skippedCount: status.skippedCount,
      conflictCount: status.conflictCount,
    };
  } catch (error) {
    if (jobId)
      await command("UI_IMPORT_ABORT", { jobId }, vaultEpoch).catch(() => {});
    throw error;
  } finally {
    await reader.close();
  }
}

export function publishBackup(
  jobId: string,
  vaultEpoch: number,
): Promise<{
  recordCount: number;
  objectCount: number;
  skippedCount: number;
  conflictCount: number;
}> {
  return command("UI_IMPORT_PUBLISH", { jobId }, vaultEpoch);
}
export async function cancelBackup(
  jobId: string,
  vaultEpoch: number,
): Promise<void> {
  await command("UI_IMPORT_ABORT", { jobId }, vaultEpoch);
}

/** Test/support entry point: validates ZIP structure, manifest, output limits, lengths and hashes without staging it. */
export async function validateBackupFile(file: File, signal?: AbortSignal) {
  const reader = new ZipReader(new BlobReader(file), {
    strictness: "strict",
    useWebWorkers: false,
  });
  try {
    const entries = await reader.getEntries({ strictness: "strict" });
    const inspected = inspectEntries(entries);
    const raw = await readEntry(
      inspected.manifest,
      limits.maxManifestBytes,
      signal,
    );
    const manifest = parseAndValidateManifest(raw);
    const expected = new Set([
      "manifest.json",
      ...manifest.objects.map((object) => object.path),
    ]);
    if (
      expected.size !== inspected.names.size ||
      [...expected].some((name) => !inspected.names.has(name))
    )
      throw new ArchiveValidationError(
        "E_ARCHIVE_REFERENCE",
        "ZIP and manifest objects differ",
      );
    let actual = raw.byteLength;
    for (const object of manifest.objects) {
      const entry = inspected.objects.get(object.path);
      if (!entry || entry.uncompressedSize !== object.byteLength)
        throw new ArchiveValidationError(
          "E_ARCHIVE_REFERENCE",
          "Object size mismatch",
        );
      const hash = sha256.create();
      let size = 0;
      await readEntry(entry, object.byteLength, signal, async (chunk) => {
        size += chunk.byteLength;
        actual += chunk.byteLength;
        if (actual > limits.maxArchiveUncompressedBytes)
          throw new ArchiveValidationError(
            "E_ARCHIVE_LIMIT",
            "Actual archive output exceeds limit",
          );
        hash.update(chunk);
      });
      if (size !== object.byteLength || hex(hash.digest()) !== object.sha256)
        throw new ArchiveValidationError(
          "E_ARCHIVE_HASH",
          "Object digest mismatch",
        );
    }
    return {
      manifest,
      recordCount: manifest.records.length,
      objectCount: manifest.objects.length,
      uncompressedBytes: actual,
    };
  } finally {
    await reader.close();
  }
}
