/** Normative data contract. Validate all values at runtime. */
export type UUID = string;
export type SHA256 = string;
export type ISODateTime = string;
export type CaptureSource = 'standard_input' | 'user_drop' | 'manual_snapshot';
export type LocationMode = 'origin_path' | 'origin_only';
export type SnapshotState = 'capturing' | 'finalising' | 'ready' | 'metadata_only' | 'interrupted' | 'failed' | 'corrupt';
export type SubmissionState = 'unknown' | 'user_confirmed' | 'user_reported_failed' | 'user_reported_cancelled';
export interface PolicyEpoch { global: number; site: number }
export interface PageContext {
  origin: string;
  location: string;
  locationMode: LocationMode;
  title: string | null;
}
export interface FileMetadata {
  name: string;
  byteLength: number;
  declaredMime: string;
  lastModified: number | null;
}
export interface Snapshot {
  state: SnapshotState;
  objectSha256: SHA256 | null;
  capturedAt: ISODateTime | null;
  errorCode: string | null;
}
export interface Submission {
  state: SubmissionState;
  updatedAt: ISODateTime | null;
}
export interface UserFields {
  label: string | null;
  note: string;
  tags: string[];
  pinned: boolean;
}
export interface LedgerRecord {
  recordId: UUID;
  batchId: UUID;
  observedAt: ISODateTime;
  source: CaptureSource;
  page: PageContext | null;
  file: FileMetadata;
  snapshot: Snapshot;
  submission: Submission;
  user: UserFields;
  revision: number;
  importedAt: ISODateTime | null;
}
export interface StoredRecord extends LedgerRecord {
  /** Internal visibility marker; omitted from a backup. */
  importJobId: UUID | null;
}
export interface ContentObject {
  sha256: SHA256;
  byteLength: number;
  payloadId: UUID;
  chunkCount: number;
  refCount: number;
  createdAt: ISODateTime;
  integrityState: 'verified' | 'corrupt';
}
export interface StoredChunk {
  payloadId: UUID;
  index: number;
  bytes: ArrayBuffer;
  rawLength: number;
  chunkSha256: SHA256;
}
export interface CallerBinding {
  kind: 'capture' | 'ui';
  tabId: number | null;
  documentId: string;
  frameId: number;
  origin: string;
}
export interface CaptureSession {
  vaultEpoch: number;
  sessionId: UUID;
  recordId: UUID;
  batchId: UUID;
  payloadId: UUID;
  token: string;
  caller: CallerBinding;
  policyEpoch: PolicyEpoch;
  status: 'queued' | 'capturing' | 'finalising' | 'committed' | 'aborted';
  expectedBytes: number;
  nextChunkIndex: number;
  receivedBytes: number;
  reservedRemainingBytes: number;
  createdAt: ISODateTime;
  lastProgressAt: ISODateTime;
  expiresAt: ISODateTime;
  absoluteExpiresAt: ISODateTime;
}
export interface SitePolicy {
  exactOrigin: string;
  enabled: boolean;
  dropEnabled: boolean;
  locationMode: LocationMode;
  saveTitle: boolean;
  permissionPattern: string;
  sitePolicyEpoch: number;
}
export type AuditType = 'snapshot_saved' | 'snapshot_failed' | 'submission_changed' | 'user_fields_changed' | 'integrity_failed' | 'imported';
export interface AuditEvent {
  eventId: UUID;
  recordId: UUID;
  createdAt: ISODateTime;
  actor: 'system' | 'user';
  type: AuditType;
  from: string | null;
  to: string | null;
  note: string | null;
}
export interface ObjectDescriptor {
  sha256: SHA256;
  byteLength: number;
  path: string;
}
export interface ArchiveRecord extends Omit<LedgerRecord, 'snapshot'> {
  snapshot: Omit<Snapshot, 'state'> & {
    state: 'ready' | 'metadata_only' | 'interrupted' | 'failed';
  };
}
export interface ArchiveManifest {
  format: 'upload-ledger-backup';
  formatVersion: 1;
  archiveId: UUID;
  createdAt: ISODateTime;
  appVersion: string;
  schemaVersion: 1;
  records: ArchiveRecord[];
  objects: ObjectDescriptor[];
  audit: AuditEvent[];
}
export interface Job {
  vaultEpoch: number;
  jobId: UUID;
  kind: 'preview' | 'export' | 'import';
  status: 'staging' | 'validated' | 'committed' | 'cancelled' | 'failed';
  leaseUntil: ISODateTime;
  objectRefs: SHA256[];
  stagedRecordIds: UUID[];
  /** IDB-only metadata snapshot. Never return a large manifest in runtime messaging. */
  manifest: ArchiveManifest | null;
}
export interface RecordQuery {
  text?: string;
  origins?: string[];
  dateFrom?: ISODateTime;
  dateTo?: ISODateTime;
  snapshotStates?: SnapshotState[];
  submissionStates?: SubmissionState[];
  tags?: string[];
  pinned?: boolean;
  cursor?: string;
  limit?: number;
}
export interface ReadRepository {
  queryRecords(query: RecordQuery): Promise<{ records: LedgerRecord[]; nextCursor: string | null }>;
  getRecord(id: UUID): Promise<LedgerRecord | null>;
  getObject(sha256: SHA256, jobId: UUID): Promise<ContentObject>;
  iterateObjectChunks(sha256: SHA256, jobId: UUID): AsyncIterable<Uint8Array>;
  getJobManifest(jobId: UUID): Promise<ArchiveManifest>;
}
