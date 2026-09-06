/** JSON-only messages. Runtime schemas must reject unexpected properties. */
import type { UUID, SHA256, PageContext, FileMetadata, CaptureSource, PolicyEpoch,
  UserFields, SubmissionState, LocationMode } from './model';

export interface FileCandidate extends FileMetadata { clientFileId: UUID }
export interface ChunkPayload {
  sessionId: UUID;
  token: string;
  index: number;
  rawLength: number;
  base64: string;
  chunkSha256: SHA256;
}
export interface SessionReference { sessionId: UUID; token: string }
export interface VersionedRecord { recordId: UUID; expectedRevision: number }
export interface BeginPayload {
  batchEventId: UUID;
  source: Extract<CaptureSource, 'standard_input' | 'user_drop'>;
  page: PageContext;
  files: FileCandidate[];
}
export interface SettingsPatch {
  budgetBytes?: number;
  excludedFileNames?: string[];
  locale?: 'zh-CN' | 'en-GB';
  theme?: 'system' | 'light' | 'dark';
}
export interface RuntimeState {
  vaultEpoch: number;
  globalPolicyEpoch: number;
  paused: boolean;
  clearing: boolean;
  settingsRevision: number;
}
export interface CommandPayloads {
  CAPTURE_HELLO: Record<string, never>;
  CAPTURE_BEGIN: BeginPayload;
  CAPTURE_CHUNK: ChunkPayload;
  CAPTURE_FINISH: SessionReference;
  CAPTURE_RESUME: SessionReference;
  CAPTURE_ABORT: SessionReference & { reason: 'read_failed' | 'source_changed' | 'source_gone' | 'user_cancelled' };
  CAPTURE_SOURCE_GONE: { batchEventIds: UUID[] };
  UI_GET_RUNTIME_STATE: Record<string, never>;
  UI_SET_SETTINGS: { expectedSettingsRevision: number; patch: SettingsPatch };
  UI_GET_SITE_STATUS: { origin: string };
  UI_SET_SITE_POLICY: { origin: string; enabled: boolean; dropEnabled: boolean; locationMode: LocationMode; saveTitle: boolean };
  UI_SET_GLOBAL_PAUSE: { paused: boolean };
  UI_SET_USER_FIELDS: VersionedRecord & { fields: UserFields };
  UI_SET_SUBMISSION: { records: VersionedRecord[]; state: SubmissionState; note: string | null };
  UI_DELETE_RECORDS: { records: VersionedRecord[] };
  UI_REQUEST_CLEAR_CHALLENGE: Record<string, never>;
  UI_CLEAR_ALL: { challenge: string };
  UI_MANUAL_BEGIN: { batchEventId: UUID; page: PageContext | null; files: FileCandidate[] };
  UI_MANUAL_CHUNK: ChunkPayload;
  UI_MANUAL_FINISH: SessionReference;
  UI_MANUAL_RESUME: SessionReference;
  UI_MANUAL_ABORT: SessionReference & { reason: 'read_failed' | 'source_changed' | 'source_gone' | 'user_cancelled' };
  UI_PREPARE_EXPORT: { recordIds: UUID[] };
  UI_PREPARE_PREVIEW: { recordId: UUID };
  UI_HEARTBEAT_JOB: { jobId: UUID };
  UI_END_JOB: { jobId: UUID; outcome: 'completed' | 'cancelled' | 'failed' };
  UI_IMPORT_BEGIN: { manifestByteLength: number; archiveByteLength: number };
  UI_IMPORT_MANIFEST_CHUNK: { jobId: UUID; index: number; rawLength: number; base64: string; chunkSha256: SHA256 };
  UI_IMPORT_MANIFEST_FINISH: { jobId: UUID };
  UI_IMPORT_OBJECT_BEGIN: { jobId: UUID; sha256: SHA256; byteLength: number };
  UI_IMPORT_OBJECT_CHUNK: ChunkPayload & { jobId: UUID };
  UI_IMPORT_OBJECT_FINISH: SessionReference & { jobId: UUID };
  UI_IMPORT_PUBLISH: { jobId: UUID };
  UI_IMPORT_ABORT: { jobId: UUID };
  UI_MARK_OBJECT_CORRUPT: { recordId: UUID; reason: 'missing_chunk' | 'size_mismatch' | 'hash_mismatch' };
  UI_GET_DIAGNOSTICS: Record<string, never>;
}
export type CommandType = keyof CommandPayloads;
export type Request<T extends CommandType = CommandType> = T extends CommandType ? {
  v: 1; requestId: UUID; vaultEpoch: number | null; type: T; payload: CommandPayloads[T];
} : never;
export interface WireError { code: string; retryable: boolean; messageKey: string }
export type Response<T> =
  | { v: 1; requestId: UUID; ok: true; data: T }
  | { v: 1; requestId: UUID; ok: false; error: WireError };
export interface FileAcceptance {
  clientFileId: UUID;
  recordId: UUID | null;
  sessionId: UUID | null;
  token: string | null;
  state: 'queued' | 'capturing' | 'metadata_only' | 'skipped';
  nextChunkIndex: number;
  errorCode: string | null;
}
export interface BeginResult { batchId: UUID; files: FileAcceptance[] }
export interface ProgressResult {
  recordId: UUID;
  state: 'queued' | 'capturing' | 'finalising' | 'committed' | 'aborted';
  nextChunkIndex: number;
  receivedBytes: number;
  retryAfterMs: number | null;
}
export interface HelloResult {
  vaultEpoch: number;
  allowed: boolean;
  paused: boolean;
  policyEpoch: PolicyEpoch;
  dropEnabled: boolean;
  maxFileBytes: number;
  rawChunkBytes: number;
}
export interface JobResult {
  jobId: UUID;
  recordCount: number;
  objectCount: number;
  totalBytes: number;
}
export const CAPTURE_COMMANDS = [
  'CAPTURE_HELLO', 'CAPTURE_BEGIN', 'CAPTURE_CHUNK', 'CAPTURE_FINISH',
  'CAPTURE_RESUME', 'CAPTURE_ABORT', 'CAPTURE_SOURCE_GONE'
] as const;
