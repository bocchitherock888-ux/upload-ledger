import defaults from "../shared/config.defaults.json";
import type {
  ArchiveManifest,
  ArchiveRecord,
  AuditEvent,
  ObjectDescriptor,
  StoredRecord,
} from "../shared/model";

const limits = defaults.backup;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class ArchiveValidationError extends Error {
  constructor(
    public readonly code:
      | "E_ARCHIVE_FORMAT"
      | "E_ARCHIVE_LIMIT"
      | "E_ARCHIVE_REFERENCE"
      | "E_ARCHIVE_PATH"
      | "E_ARCHIVE_HASH",
    message: string,
  ) {
    super(code + ": " + message);
    this.name = "ArchiveValidationError";
  }
}
const invalid = (message: string): never => {
  throw new ArchiveValidationError("E_ARCHIVE_FORMAT", message);
};
const limit = (message: string): never => {
  throw new ArchiveValidationError("E_ARCHIVE_LIMIT", message);
};
const reference = (message: string): never => {
  throw new ArchiveValidationError("E_ARCHIVE_REFERENCE", message);
};
const check: (ok: unknown, message: string) => asserts ok = (ok, message) => {
  if (!ok) invalid(message);
};
const keys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  message: string,
) => {
  const actual = Object.keys(value);
  check(
    actual.length === expected.length &&
      actual.every((key) => expected.includes(key)),
    message,
  );
};
const object = (value: unknown, message: string): Record<string, unknown> => {
  check(
    typeof value === "object" && value !== null && !Array.isArray(value),
    message,
  );
  return value as Record<string, unknown>;
};
const array = (value: unknown, max: number, message: string): unknown[] => {
  check(Array.isArray(value), message);
  if (value.length > max) limit(message);
  return value;
};
const string = (
  value: unknown,
  max: number,
  message: string,
  min = 0,
): string => {
  check(
    typeof value === "string" &&
      [...value].length >= min &&
      [...value].length <= max,
    message,
  );
  return value;
};
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  check(
    Number.isSafeInteger(value) &&
      typeof value === "number" &&
      value >= 0 &&
      value <= max,
    "Invalid integer",
  );
  return value;
};
const utc = (value: unknown): string => {
  const text = string(value, 100, "Invalid UTC date");
  const match = UTC.exec(text);
  check(match && Number.isFinite(Date.parse(text)), "Invalid UTC date");
  const basic = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text)!;
  const date = new Date(0);
  date.setUTCFullYear(Number(basic[1]), Number(basic[2]) - 1, Number(basic[3]));
  date.setUTCHours(Number(basic[4]), Number(basic[5]), Number(basic[6]), 0);
  check(
    date.getUTCFullYear() === Number(basic[1]) &&
      date.getUTCMonth() === Number(basic[2]) - 1 &&
      date.getUTCDate() === Number(basic[3]) &&
      date.getUTCHours() === Number(basic[4]) &&
      date.getUTCMinutes() === Number(basic[5]) &&
      date.getUTCSeconds() === Number(basic[6]),
    "Invalid UTC date",
  );
  return text;
};

/** A deliberately small JSON parser. It exists so duplicate properties are rejected before values are materialised. */
export function parseStrictJSON(text: string): unknown {
  let at = 0;
  const MAX_DEPTH = 64;
  const MAX_PROPERTIES = 64;
  const ws = () => {
    while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++;
  };
  const parseString = (): string => {
    const start = at;
    check(text[at++] === '"', "Expected JSON string");
    let escaped = false;
    while (at < text.length) {
      const c = text.charCodeAt(at++);
      if (c < 0x20) invalid("Control character in JSON string");
      if (!escaped && c === 0x22) {
        try {
          return JSON.parse(text.slice(start, at));
        } catch {
          return invalid("Invalid JSON string");
        }
      }
      if (!escaped && c === 0x5c) {
        escaped = true;
        continue;
      }
      escaped = false;
    }
    return invalid("Unterminated JSON string");
  };
  const value = (depth = 0): unknown => {
    if (depth > MAX_DEPTH) limit("JSON nesting is too deep");
    ws();
    const c = text[at];
    if (c === '"') return parseString();
    if (c === "{") {
      at++;
      ws();
      const result: Record<string, unknown> = {};
      const seen = new Set<string>();
      if (text[at] === "}") {
        at++;
        return result;
      }
      while (true) {
        if (seen.size >= MAX_PROPERTIES)
          limit("JSON object has too many properties");
        ws();
        const key = parseString();
        check(!seen.has(key), "Duplicate JSON property");
        seen.add(key);
        ws();
        check(text[at++] === ":", "Expected colon");
        Object.defineProperty(result, key, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[at] === "}") {
          at++;
          return result;
        }
        check(text[at++] === ",", "Expected comma");
      }
    }
    if (c === "[") {
      at++;
      ws();
      const result: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return result;
      }
      while (true) {
        if (result.length >= limits.maxAuditEvents)
          limit("JSON array has too many items");
        result.push(value(depth + 1));
        ws();
        if (text[at] === "]") {
          at++;
          return result;
        }
        check(text[at++] === ",", "Expected comma");
      }
    }
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(token, at)) {
        at += token.length;
        return result;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(at),
    );
    check(match, "Invalid JSON value");
    at += match[0].length;
    const result = Number(match[0]);
    check(Number.isFinite(result), "Non-finite JSON number");
    return result;
  };
  const result = value();
  ws();
  check(at === text.length, "Trailing JSON content");
  return result;
}

function validatePage(value: unknown, source: string) {
  if (value === null) {
    check(
      source === "manual_snapshot",
      "Automatic record requires page context",
    );
    return;
  }
  const page = object(value, "Invalid page");
  keys(
    page,
    ["origin", "location", "locationMode", "title"],
    "Invalid page fields",
  );
  const origin = string(page.origin, 4096, "Invalid page origin"),
    location = string(page.location, 4096, "Invalid page location");
  check(
    page.locationMode === "origin_path" || page.locationMode === "origin_only",
    "Invalid location mode",
  );
  check(
    page.title === null ||
      (typeof page.title === "string" && [...page.title].length <= 256),
    "Invalid page title",
  );
  for (const address of [origin, location])
    check(!/[\x00-\x1f\\?#]/.test(address), "Unsafe page URL");
  let a: URL, b: URL;
  try {
    a = new URL(origin);
    b = new URL(location);
  } catch {
    return invalid("Invalid page URL");
  }
  for (const url of [a, b])
    check(
      (url.protocol === "http:" || url.protocol === "https:") &&
        !!url.hostname &&
        !url.username &&
        !url.password,
      "Unsupported page URL",
    );
  check(
    (a.pathname === "" || a.pathname === "/") && !a.search && !a.hash,
    "Origin contains path",
  );
  const authority = (url: URL) =>
    `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  check(authority(a) === authority(b), "Page origin mismatch");
  if (page.locationMode === "origin_only")
    check(location === origin, "origin_only mismatch");
}

function validateRecord(value: unknown): ArchiveRecord {
  const r = object(value, "Invalid record");
  keys(
    r,
    [
      "recordId",
      "batchId",
      "observedAt",
      "source",
      "page",
      "file",
      "snapshot",
      "submission",
      "user",
      "revision",
      "importedAt",
    ],
    "Invalid record fields",
  );
  check(
    typeof r.recordId === "string" &&
      UUID.test(r.recordId) &&
      typeof r.batchId === "string" &&
      UUID.test(r.batchId),
    "Invalid record identifier",
  );
  utc(r.observedAt);
  check(
    r.source === "standard_input" ||
      r.source === "user_drop" ||
      r.source === "manual_snapshot",
    "Invalid record source",
  );
  validatePage(r.page, r.source);
  const file = object(r.file, "Invalid file");
  keys(
    file,
    ["name", "byteLength", "declaredMime", "lastModified"],
    "Invalid file fields",
  );
  string(file.name, 1024, "Invalid file name", 1);
  integer(file.byteLength);
  string(file.declaredMime, 255, "Invalid MIME");
  check(
    file.lastModified === null ||
      (Number.isSafeInteger(file.lastModified) &&
        typeof file.lastModified === "number" &&
        file.lastModified >= 0),
    "Invalid lastModified",
  );
  const snapshot = object(r.snapshot, "Invalid snapshot");
  keys(
    snapshot,
    ["state", "objectSha256", "capturedAt", "errorCode"],
    "Invalid snapshot fields",
  );
  check(
    ["ready", "metadata_only", "interrupted", "failed"].includes(
      snapshot.state as string,
    ),
    "Invalid snapshot state",
  );
  if (snapshot.state === "ready") {
    check(
      typeof snapshot.objectSha256 === "string" &&
        SHA.test(snapshot.objectSha256),
      "Ready record lacks digest",
    );
    utc(snapshot.capturedAt);
    check(snapshot.errorCode === null, "Ready record has error");
  } else {
    check(
      snapshot.objectSha256 === null && snapshot.capturedAt === null,
      "Non-ready record has object",
    );
    check(
      snapshot.errorCode === null ||
        (typeof snapshot.errorCode === "string" &&
          [...snapshot.errorCode].length <= 80),
      "Invalid error code",
    );
  }
  const submission = object(r.submission, "Invalid submission");
  keys(submission, ["state", "updatedAt"], "Invalid submission fields");
  check(
    [
      "unknown",
      "user_confirmed",
      "user_reported_failed",
      "user_reported_cancelled",
    ].includes(submission.state as string),
    "Invalid submission state",
  );
  check(
    submission.updatedAt === null || typeof submission.updatedAt === "string",
    "Invalid submission date",
  );
  if (submission.updatedAt !== null) utc(submission.updatedAt);
  const user = object(r.user, "Invalid user fields");
  keys(user, ["label", "note", "tags", "pinned"], "Invalid user fields");
  check(
    user.label === null ||
      (typeof user.label === "string" && [...user.label].length <= 120),
    "Invalid label",
  );
  string(user.note, 4000, "Invalid note");
  const tags = array(user.tags, 10, "Invalid tags");
  const seen = new Set<string>();
  for (const tag of tags) {
    const t = string(tag, 32, "Invalid tag", 1);
    check(!seen.has(t), "Duplicate tag");
    seen.add(t);
  }
  check(typeof user.pinned === "boolean", "Invalid pinned");
  integer(r.revision);
  check(
    r.importedAt === null || typeof r.importedAt === "string",
    "Invalid importedAt",
  );
  if (r.importedAt !== null) utc(r.importedAt);
  return r as unknown as ArchiveRecord;
}

function validateObject(value: unknown): ObjectDescriptor {
  const obj = object(value, "Invalid object");
  keys(obj, ["sha256", "byteLength", "path"], "Invalid object fields");
  check(
    typeof obj.sha256 === "string" && SHA.test(obj.sha256),
    "Invalid object digest",
  );
  integer(obj.byteLength, limits.maxObjectBytes);
  check(obj.path === `objects/${obj.sha256}.bin`, "Object path mismatch");
  return obj as unknown as ObjectDescriptor;
}

function validateAudit(value: unknown): AuditEvent {
  const event = object(value, "Invalid audit");
  keys(
    event,
    ["eventId", "recordId", "createdAt", "actor", "type", "from", "to", "note"],
    "Invalid audit fields",
  );
  check(
    typeof event.eventId === "string" &&
      UUID.test(event.eventId) &&
      typeof event.recordId === "string" &&
      UUID.test(event.recordId),
    "Invalid audit identifier",
  );
  utc(event.createdAt);
  check(
    event.actor === "system" || event.actor === "user",
    "Invalid audit actor",
  );
  check(
    [
      "snapshot_saved",
      "snapshot_failed",
      "submission_changed",
      "user_fields_changed",
      "integrity_failed",
      "imported",
    ].includes(event.type as string),
    "Invalid audit type",
  );
  for (const field of ["from", "to"] as const)
    check(
      event[field] === null ||
        (typeof event[field] === "string" && [...event[field]].length <= 80),
      "Invalid audit transition",
    );
  check(
    event.note === null ||
      (typeof event.note === "string" && [...event.note].length <= 4000),
    "Invalid audit note",
  );
  return event as unknown as AuditEvent;
}

export function validateManifest(
  value: unknown,
  manifestBytes?: number,
): ArchiveManifest {
  if (manifestBytes !== undefined && manifestBytes > limits.maxManifestBytes)
    limit("Manifest too large");
  const root = object(value, "Manifest must be an object");
  keys(
    root,
    [
      "format",
      "formatVersion",
      "archiveId",
      "createdAt",
      "appVersion",
      "schemaVersion",
      "records",
      "objects",
      "audit",
    ],
    "Invalid manifest fields",
  );
  check(
    root.format === "upload-ledger-backup" &&
      root.formatVersion === 1 &&
      root.schemaVersion === 1,
    "Unsupported backup format",
  );
  check(
    typeof root.archiveId === "string" && UUID.test(root.archiveId),
    "Invalid archive identifier",
  );
  utc(root.createdAt);
  check(
    typeof root.appVersion === "string" &&
      root.appVersion.length <= 100 &&
      SEMVER.test(root.appVersion),
    "Invalid app version",
  );
  const records = array(
    root.records,
    limits.maxRecords,
    "Too many records",
  ).map(validateRecord);
  const objects = array(
    root.objects,
    limits.maxObjectCount,
    "Too many objects",
  ).map(validateObject);
  const audit = array(
    root.audit,
    limits.maxAuditEvents,
    "Too many audit events",
  ).map(validateAudit);
  const recordIds = new Set<string>();
  for (const r of records) {
    if (recordIds.has(r.recordId)) invalid("Duplicate record identifier");
    recordIds.add(r.recordId);
  }
  const objectMap = new Map<string, ObjectDescriptor>();
  let total = manifestBytes ?? 0;
  for (const obj of objects) {
    if (objectMap.has(obj.sha256)) invalid("Duplicate object descriptor");
    objectMap.set(obj.sha256, obj);
    total += obj.byteLength;
    if (total > limits.maxArchiveUncompressedBytes)
      limit("Archive output too large");
  }
  const references = new Set<string>();
  for (const r of records) {
    if (r.snapshot.state === "ready") {
      const sha = r.snapshot.objectSha256!;
      const obj = objectMap.get(sha);
      if (!obj || obj.byteLength !== r.file.byteLength)
        reference("Record/object mismatch");
      references.add(sha);
    }
  }
  if (
    references.size !== objectMap.size ||
    objects.some((obj) => !references.has(obj.sha256))
  )
    reference("Unreferenced object descriptor");
  const eventIds = new Set<string>();
  for (const event of audit) {
    if (!recordIds.has(event.recordId)) reference("Orphan audit event");
    if (eventIds.has(event.eventId)) invalid("Duplicate audit identifier");
    eventIds.add(event.eventId);
  }
  return {
    format: "upload-ledger-backup",
    formatVersion: 1,
    archiveId: root.archiveId as string,
    createdAt: root.createdAt as string,
    appVersion: root.appVersion as string,
    schemaVersion: 1,
    records,
    objects,
    audit,
  };
}

export function parseAndValidateManifest(bytes: Uint8Array): ArchiveManifest {
  if (bytes.byteLength > limits.maxManifestBytes) limit("Manifest too large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("Manifest is not UTF-8");
  }
  return validateManifest(parseStrictJSON(text), bytes.byteLength);
}

/** Compares the source fact, file identity and captured object while deliberately excluding local mutable user state. */
export function sameImmutableRecord(
  local: StoredRecord,
  archived: ArchiveRecord,
): boolean {
  const pageEqual =
    local.page === null || archived.page === null
      ? local.page === archived.page
      : local.page.origin === archived.page.origin &&
        local.page.location === archived.page.location &&
        local.page.locationMode === archived.page.locationMode &&
        local.page.title === archived.page.title;
  return (
    local.recordId === archived.recordId &&
    local.batchId === archived.batchId &&
    local.observedAt === archived.observedAt &&
    local.source === archived.source &&
    pageEqual &&
    local.file.name === archived.file.name &&
    local.file.byteLength === archived.file.byteLength &&
    local.file.declaredMime === archived.file.declaredMime &&
    local.file.lastModified === archived.file.lastModified &&
    local.snapshot.state === archived.snapshot.state &&
    local.snapshot.objectSha256 === archived.snapshot.objectSha256 &&
    local.snapshot.capturedAt === archived.snapshot.capturedAt &&
    local.snapshot.errorCode === archived.snapshot.errorCode
  );
}
