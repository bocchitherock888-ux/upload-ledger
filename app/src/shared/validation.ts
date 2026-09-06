import { z } from "zod";
import defaults from "./config.defaults.json";
import type { Request } from "./protocol";

const uuid = z.uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const empty = z.strictObject({});
const origin = z.string().min(1).max(defaults.limits.pageLocationChars);
const page = z.strictObject({
  origin,
  location: z.string().min(1).max(defaults.limits.pageLocationChars),
  locationMode: z.enum(["origin_path", "origin_only"]),
  title: z.string().max(defaults.limits.pageTitleChars).nullable(),
});
const file = z.strictObject({
  clientFileId: uuid,
  name: z.string().min(1).max(defaults.limits.fileNameChars),
  byteLength: integer,
  declaredMime: z.string().max(256),
  lastModified: integer.nullable(),
});
const files = z.array(file).min(1).max(defaults.capture.maxBatchFiles);
const referenceShape = {
  sessionId: uuid,
  token: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/),
};
const revision = z.strictObject({ recordId: uuid, expectedRevision: integer });
const revisions = z.array(revision).min(1).max(10_000);
const userFields = z.strictObject({
  label: z.string().max(defaults.limits.userLabelChars).nullable(),
  note: z.string().max(defaults.limits.noteChars),
  tags: z
    .array(z.string().min(1).max(defaults.limits.tagChars))
    .max(defaults.limits.tagsPerRecord)
    .refine((values) => new Set(values).size === values.length),
  pinned: z.boolean(),
});
const chunk = z.strictObject({
  ...referenceShape,
  index: integer.max(
    Math.ceil(defaults.capture.maxFileBytes / defaults.capture.rawChunkBytes),
  ),
  rawLength: integer.min(1).max(defaults.capture.rawChunkBytes),
  base64: z.string().max(4 * Math.ceil(defaults.capture.rawChunkBytes / 3)),
  chunkSha256: sha,
});
const abortReason = z.enum([
  "read_failed",
  "source_changed",
  "source_gone",
  "user_cancelled",
]);
const settingsPatch = z
  .strictObject({
    budgetBytes: integer
      .min(defaults.storage.minimumBudgetBytes)
      .max(defaults.storage.maximumBudgetBytes)
      .optional(),
    excludedFileNames: z
      .array(
        z
          .string()
          .min(1)
          .max(120)
          .regex(/^[^\u0000-\u001f\u007f]+$/),
      )
      .max(100)
      .optional(),
    locale: z.enum(["zh-CN", "zh-TW", "en-GB"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

const schemas = {
  CAPTURE_HELLO: empty,
  CAPTURE_BEGIN: z.strictObject({
    batchEventId: uuid,
    source: z.enum(["standard_input", "user_drop"]),
    page,
    files,
  }),
  CAPTURE_CHUNK: chunk,
  CAPTURE_FINISH: z.strictObject(referenceShape),
  CAPTURE_RESUME: z.strictObject(referenceShape),
  CAPTURE_ABORT: z.strictObject({ ...referenceShape, reason: abortReason }),
  CAPTURE_SOURCE_GONE: z.strictObject({
    batchEventIds: z.array(uuid).max(defaults.capture.maxBatchFiles),
  }),
  UI_GET_RUNTIME_STATE: empty,
  UI_SET_SETTINGS: z.strictObject({
    expectedSettingsRevision: integer,
    patch: settingsPatch,
  }),
  UI_GET_SITE_STATUS: z.strictObject({ origin }),
  UI_SET_SITE_POLICY: z.strictObject({
    origin,
    enabled: z.boolean(),
    dropEnabled: z.boolean(),
    locationMode: z.enum(["origin_path", "origin_only"]),
    saveTitle: z.boolean(),
  }),
  UI_SET_GLOBAL_PAUSE: z.strictObject({ paused: z.boolean() }),
  UI_SET_USER_FIELDS: z.strictObject({
    recordId: uuid,
    expectedRevision: integer,
    fields: userFields,
  }),
  UI_SET_SUBMISSION: z.strictObject({
    records: revisions,
    state: z.enum([
      "unknown",
      "user_confirmed",
      "user_reported_failed",
      "user_reported_cancelled",
    ]),
    note: z.string().max(defaults.limits.noteChars).nullable(),
  }),
  UI_DELETE_RECORDS: z.strictObject({ records: revisions }),
  UI_REQUEST_CLEAR_CHALLENGE: empty,
  UI_CLEAR_ALL: z.strictObject({
    challenge: z
      .string()
      .length(36)
      .regex(/^[a-f0-9]+$/),
  }),
  UI_MANUAL_BEGIN: z.strictObject({
    batchEventId: uuid,
    page: page.nullable(),
    files,
  }),
  UI_MANUAL_CHUNK: chunk,
  UI_MANUAL_FINISH: z.strictObject(referenceShape),
  UI_MANUAL_RESUME: z.strictObject(referenceShape),
  UI_MANUAL_ABORT: z.strictObject({ ...referenceShape, reason: abortReason }),
  UI_PREPARE_EXPORT: z.strictObject({
    recordIds: z.array(uuid).min(1).max(defaults.backup.maxRecords),
  }),
  UI_PREPARE_PREVIEW: z.strictObject({ recordId: uuid }),
  UI_HEARTBEAT_JOB: z.strictObject({ jobId: uuid }),
  UI_END_JOB: z.strictObject({
    jobId: uuid,
    outcome: z.enum(["completed", "cancelled", "failed"]),
  }),
  UI_IMPORT_BEGIN: z.strictObject({
    manifestByteLength: integer.max(defaults.backup.maxManifestBytes),
    archiveByteLength: integer.max(defaults.backup.maxArchiveUncompressedBytes),
  }),
  UI_IMPORT_MANIFEST_CHUNK: z.strictObject({
    jobId: uuid,
    index: integer,
    rawLength: integer.min(1).max(defaults.capture.rawChunkBytes),
    base64: z.string().max(4 * Math.ceil(defaults.capture.rawChunkBytes / 3)),
    chunkSha256: sha,
  }),
  UI_IMPORT_MANIFEST_FINISH: z.strictObject({ jobId: uuid }),
  UI_IMPORT_OBJECT_BEGIN: z.strictObject({
    jobId: uuid,
    sha256: sha,
    byteLength: integer.max(defaults.backup.maxObjectBytes),
  }),
  UI_IMPORT_OBJECT_CHUNK: z.strictObject({
    jobId: uuid,
    ...referenceShape,
    index: integer,
    rawLength: integer.min(1).max(defaults.capture.rawChunkBytes),
    base64: z.string().max(4 * Math.ceil(defaults.capture.rawChunkBytes / 3)),
    chunkSha256: sha,
  }),
  UI_IMPORT_OBJECT_FINISH: z.strictObject({ jobId: uuid, ...referenceShape }),
  UI_IMPORT_PUBLISH: z.strictObject({ jobId: uuid }),
  UI_IMPORT_ABORT: z.strictObject({ jobId: uuid }),
  UI_MARK_OBJECT_CORRUPT: z.strictObject({
    recordId: uuid,
    reason: z.enum(["missing_chunk", "size_mismatch", "hash_mismatch"]),
  }),
  UI_GET_DIAGNOSTICS: empty,
} as const;

const commandTypes = Object.keys(schemas) as [
  keyof typeof schemas,
  ...(keyof typeof schemas)[],
];
export const envelope = z.strictObject({
  v: z.literal(1),
  requestId: uuid,
  vaultEpoch: integer.nullable(),
  type: z.enum(commandTypes),
  payload: z.unknown(),
});

export function validate(raw: unknown): Request {
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(raw));
  } catch {
    throw new Error("E_BAD_MESSAGE");
  }
  if (encoded.byteLength > defaults.capture.maxWireMessageBytes)
    throw new Error("E_MESSAGE_TOO_LARGE");
  const message = envelope.parse(raw);
  return {
    ...message,
    payload: schemas[message.type].parse(message.payload),
  } as Request;
}
