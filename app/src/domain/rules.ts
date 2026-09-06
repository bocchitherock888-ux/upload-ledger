import { sha256 } from "@noble/hashes/sha2.js";
import defaults from "../shared/config.defaults.json";
export const CHUNK = defaults.capture.rawChunkBytes;
export const MAX_FILE = defaults.capture.maxFileBytes;
export const digest = (bytes: Uint8Array) =>
  Array.from(sha256(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
export function fail(code: string): never {
  throw new Error(code);
}
export function cleanURL(value: string, mode = "origin_path") {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return fail("E_INVALID_URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) fail("E_INVALID_URL");
  return (u.origin + (mode === "origin_only" ? "" : u.pathname)).slice(0, 4096);
}
export function permissionPattern(origin: string) {
  const u = new URL(cleanURL(origin));
  return `${u.protocol}//${u.hostname}/*`;
}
export function excluded(
  name: string,
  patterns: readonly string[] = defaults.excludedFileNames,
) {
  return patterns.some((pattern) =>
    new RegExp(
      "^" +
        pattern
          .split("")
          .map((c) =>
            c === "*"
              ? ".*"
              : c === "?"
                ? "."
                : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("") +
        "$",
      "i",
    ).test(name),
  );
}
export function safeName(name: string) {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f/:*?"<>|]/g, "_").trim();
  return cleaned &&
    !/^(?:\.|\.\.|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(cleaned)
    ? cleaned.slice(0, 180)
    : "download.bin";
}
export function encode(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function decode(value: string, length: number) {
  if (
    value.length !== 4 * Math.ceil(length / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail("E_BAD_MESSAGE");
  const decoded = atob(value);
  const b = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++)
    b[index] = decoded.charCodeAt(index);
  if (b.length !== length || encode(b) !== value) fail("E_BAD_MESSAGE");
  return b;
}
