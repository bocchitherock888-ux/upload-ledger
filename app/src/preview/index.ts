import { command } from "../shared/client";
import { original, iterateObjectChunks } from "../storage/read";
import type { StoredRecord } from "../shared/model";
import {
  decodeUtf8,
  exceedsImagePixelLimit,
  imageDimensions,
  previewKind,
  TEXT_PREVIEW_BYTES,
} from "./utils";

export type PreviewResource =
  | {
      kind: "text";
      text: string;
      truncated: boolean;
      jobId: string;
      dispose: () => Promise<void>;
    }
  | {
      kind: "image";
      url: string;
      blob: Blob;
      jobId: string;
      dispose: () => Promise<void>;
    }
  | { kind: "image_limit"; jobId: string; dispose: () => Promise<void> }
  | { kind: "pdf"; blob: Blob; jobId: string; dispose: () => Promise<void> }
  | { kind: "unsupported"; jobId: string; dispose: () => Promise<void> };

const activePreviews = new Map<string, Set<Promise<PreviewResource>>>();

/** Checks durable bytes in bounded chunks before making a byte-equality claim. */
export async function verifyRecordBytes(
  record: StoredRecord,
  vaultEpoch: number,
): Promise<void> {
  if (record.snapshot.state !== "ready" || !record.snapshot.objectSha256)
    throw new Error("E_INVALID_STATE");
  const job = await command<{ jobId: string }>(
    "UI_PREPARE_PREVIEW",
    { recordId: record.recordId },
    vaultEpoch,
  );
  let outcome: "completed" | "failed" = "failed";
  try {
    for await (const block of iterateObjectChunks(
      record.snapshot.objectSha256,
      job.jobId,
    )) {
      void block;
    }
    outcome = "completed";
  } catch (error) {
    if (
      error instanceof Error &&
      ["E_INTEGRITY", "E_OBJECT_MISSING"].includes(error.message)
    ) {
      await command(
        "UI_MARK_OBJECT_CORRUPT",
        { recordId: record.recordId, reason: "hash_mismatch" },
        vaultEpoch,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await command(
      "UI_END_JOB",
      { jobId: job.jobId, outcome },
      vaultEpoch,
    ).catch(() => undefined);
  }
}

async function openRecordInternal(
  record: StoredRecord,
  vaultEpoch: number,
): Promise<PreviewResource> {
  if (record.snapshot.state !== "ready") throw new Error("E_INVALID_STATE");
  const prepared = await command<{ jobId: string }>(
    "UI_PREPARE_PREVIEW",
    { recordId: record.recordId },
    vaultEpoch,
  );
  let outcome: "completed" | "failed" = "failed";
  let objectUrl: string | null = null;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    await command(
      "UI_END_JOB",
      { jobId: prepared.jobId, outcome },
      vaultEpoch,
    ).catch(() => undefined);
  };
  try {
    const { blob } = await original(record.recordId, prepared.jobId);
    const kind = previewKind(record.file);
    outcome = "completed";
    if (kind === "text") {
      const truncated = blob.size > TEXT_PREVIEW_BYTES;
      const bytes = new Uint8Array(
        await blob.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer(),
      );
      const text = decodeUtf8(bytes);
      if (text === null)
        return { kind: "unsupported", jobId: prepared.jobId, dispose };
      return { kind: "text", text, truncated, jobId: prepared.jobId, dispose };
    }
    if (kind === "image") {
      const header = new Uint8Array(
        await blob.slice(0, 512 * 1024).arrayBuffer(),
      );
      const dimensions = imageDimensions(header);
      if (!dimensions)
        return { kind: "unsupported", jobId: prepared.jobId, dispose };
      if (exceedsImagePixelLimit(dimensions))
        return { kind: "image_limit", jobId: prepared.jobId, dispose };
      objectUrl = URL.createObjectURL(blob);
      return {
        kind: "image",
        url: objectUrl,
        blob,
        jobId: prepared.jobId,
        dispose,
      };
    }
    if (kind === "pdf")
      return { kind: "pdf", blob, jobId: prepared.jobId, dispose };
    return { kind: "unsupported", jobId: prepared.jobId, dispose };
  } catch (error) {
    await dispose();
    if (
      error instanceof Error &&
      ["E_INTEGRITY", "E_OBJECT_MISSING"].includes(error.message)
    ) {
      await command(
        "UI_MARK_OBJECT_CORRUPT",
        { recordId: record.recordId, reason: "hash_mismatch" },
        vaultEpoch,
      ).catch(() => undefined);
    }
    throw error;
  }
}

export function openRecord(
  record: StoredRecord,
  vaultEpoch: number,
): Promise<PreviewResource> {
  const set =
    activePreviews.get(record.recordId) || new Set<Promise<PreviewResource>>();
  let opening: Promise<PreviewResource>;
  opening = openRecordInternal(record, vaultEpoch).then((resource) => {
    const originalDispose = resource.dispose;
    return {
      ...resource,
      dispose: async () => {
        await originalDispose();
        set.delete(opening);
        if (!set.size) activePreviews.delete(record.recordId);
      },
    } as PreviewResource;
  });
  set.add(opening);
  activePreviews.set(record.recordId, set);
  void opening.catch(() => {
    set.delete(opening);
    if (!set.size) activePreviews.delete(record.recordId);
  });
  return opening;
}

/** Ends active and in-flight preview leases before a destructive record operation. */
export async function releaseRecordPreviews(recordId: string): Promise<void> {
  const openings = [...(activePreviews.get(recordId) || [])];
  const settled = await Promise.allSettled(openings);
  await Promise.all(
    settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.dispose()] : [],
    ),
  );
  activePreviews.delete(recordId);
}

export async function readRecordBytes(
  record: StoredRecord,
  vaultEpoch: number,
): Promise<{ bytes: Uint8Array; name: string }> {
  if (record.snapshot.state !== "ready") throw new Error("E_INVALID_STATE");
  const prepared = await command<{ jobId: string }>(
    "UI_PREPARE_PREVIEW",
    { recordId: record.recordId },
    vaultEpoch,
  );
  let outcome: "completed" | "failed" = "failed";
  try {
    const result = await original(record.recordId, prepared.jobId);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    outcome = "completed";
    return { bytes, name: result.name };
  } finally {
    await command(
      "UI_END_JOB",
      { jobId: prepared.jobId, outcome },
      vaultEpoch,
    ).catch(() => undefined);
  }
}
