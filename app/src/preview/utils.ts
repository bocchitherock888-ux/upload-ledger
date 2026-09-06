import type { FileMetadata } from "../shared/model";

export const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export const TEXT_DIFF_BYTES = 1024 * 1024;
export const IMAGE_MAX_PIXELS = 40_000_000;

export type ImageDimensions = { width: number; height: number };

export type DiffRow = { kind: "same" | "add" | "remove"; text: string };
export type DiffResult = {
  state: "identical" | "different" | "limited" | "binary";
  rows: DiffRow[];
};

const textExtensions = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "yml",
  "yaml",
  "toml",
  "ini",
  "conf",
  "log",
  "sql",
  "sh",
  "zsh",
  "bash",
  "py",
  "rb",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "rs",
  "go",
  "swift",
  "kt",
  "properties",
  "rtf",
]);

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function previewKind(
  file: FileMetadata,
): "image" | "text" | "pdf" | "unsupported" {
  const mime = file.declaredMime.toLowerCase().split(";", 1)[0].trim();
  const ext = extension(file.name);
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime))
    return "image";
  if (
    mime === "image/svg+xml" ||
    mime.startsWith("text/") ||
    textExtensions.has(ext)
  )
    return "text";
  return "unsupported";
}

function u16be(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 256 + bytes[offset + 1];
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65_536;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 16_777_216 +
    bytes[offset + 1] * 65_536 +
    bytes[offset + 2] * 256 +
    bytes[offset + 3]
  );
}

/** Reads dimensions from supported image headers without asking the browser to decode hostile pixels. */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return {
      width: bytes[6] + bytes[7] * 256,
      height: bytes[8] + bytes[9] * 256,
    };
  }
  if (
    bytes.length >= 30 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === "VP8X")
      return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const packed =
        bytes[21] +
        bytes[22] * 256 +
        bytes[23] * 65_536 +
        bytes[24] * 16_777_216;
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }
    if (
      kind === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: (bytes[26] + bytes[27] * 256) & 0x3fff,
        height: (bytes[28] + bytes[29] * 256) & 0x3fff,
      };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        offset += 2;
        continue;
      }
      const length = u16be(bytes, offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return null;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        return {
          width: u16be(bytes, offset + 7),
          height: u16be(bytes, offset + 5),
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export function exceedsImagePixelLimit(
  dimensions: ImageDimensions | null,
  limit = IMAGE_MAX_PIXELS,
): boolean {
  return Boolean(
    dimensions &&
    (dimensions.width <= 0 ||
      dimensions.height <= 0 ||
      dimensions.width > Math.floor(limit / dimensions.height)),
  );
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // NUL is a strong binary signal. Other control characters remain valid text.
    return value.includes("\0") ? null : value.replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

export function safeDownloadName(name: string): string {
  const cleaned = name
    .replace(/^(?:\.\.[\\/])+/, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "＿")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/^\.+/, "")
    .trim();
  const fallback = "upload-ledger-file";
  const bounded = (cleaned || fallback).slice(0, 180).trim();
  return bounded || fallback;
}

export function localDateBoundary(
  value: string,
  endOfDay = false,
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  if (
    !Number.isFinite(start.getTime()) ||
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day
  )
    return undefined;
  if (!endOfDay) return start.toISOString();
  const end = new Date(year, month - 1, day + 1);
  end.setMilliseconds(-1);
  return end.toISOString();
}

function splitLines(value: string): string[] {
  return value.split(/(?<=\n)/);
}

/** A bounded, deterministic line diff. Look-ahead is capped, so adversarial input stays O(n). */
export function boundedLineDiff(
  left: string,
  right: string,
  maxBytes = TEXT_DIFF_BYTES,
): DiffResult {
  const encoder = new TextEncoder();
  if (
    encoder.encode(left).byteLength > maxBytes ||
    encoder.encode(right).byteLength > maxBytes
  ) {
    return { state: "limited", rows: [] };
  }
  if (left === right)
    return {
      state: "identical",
      rows: left
        ? splitLines(left).map((text) => ({ kind: "same", text }))
        : [],
    };
  const a = splitLines(left);
  const b = splitLines(right);
  if (a.length > 25_000 || b.length > 25_000)
    return { state: "limited", rows: [] };
  const rows: DiffRow[] = [];
  const lookAhead = 32;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i++] });
      j += 1;
      continue;
    }
    let rightMatch = -1;
    let leftMatch = -1;
    for (let offset = 1; offset <= lookAhead; offset += 1) {
      if (
        rightMatch < 0 &&
        i < a.length &&
        j + offset < b.length &&
        a[i] === b[j + offset]
      )
        rightMatch = offset;
      if (
        leftMatch < 0 &&
        j < b.length &&
        i + offset < a.length &&
        b[j] === a[i + offset]
      )
        leftMatch = offset;
      if (rightMatch >= 0 || leftMatch >= 0) break;
    }
    if (rightMatch >= 0 && (leftMatch < 0 || rightMatch <= leftMatch)) {
      for (let n = 0; n < rightMatch; n += 1)
        rows.push({ kind: "add", text: b[j++] });
    } else if (leftMatch >= 0) {
      for (let n = 0; n < leftMatch; n += 1)
        rows.push({ kind: "remove", text: a[i++] });
    } else {
      if (i < a.length) rows.push({ kind: "remove", text: a[i++] });
      if (j < b.length) rows.push({ kind: "add", text: b[j++] });
    }
  }
  return { state: "different", rows };
}
