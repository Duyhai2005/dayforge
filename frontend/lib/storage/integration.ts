// Explicit low-level surface for storage integrations (T09/T11).
export {
  DB_NAME,
  CURRENT_SCHEMA_VERSION,
  STORAGE_STORES,
  type StorageStoreName,
} from "./schema";

export {
  openDatabase,
  closeDatabase,
  type OpenDatabaseOptions,
} from "./db";

export {
  type OwnerAccessContext,
  type OwnerMetadata,
  type UnlockOwnerOptions,
  getOwnerMeta,
  checkOwnerMetaRecord,
  validateOwnerAccess,
  unlockOwner,
  lockOwner,
  isOwnerUnlocked,
} from "./owner-gate";

export {
  type EncryptedRecord,
  createAad,
  encryptPayload,
  decryptPayload,
  importRawKey,
  getCryptoKey,
} from "./crypto";

export {
  type HlcEditTime,
  validateHlc,
  advanceHlc,
} from "./clock-state";

export {
  UUID_PATTERN,
  HASH_PATTERN,
  DATE_PATTERN,
  MAX_OPERATION_WIRE_BYTES,
  isCanonicalLocalDate,
  isCanonicalInt64,
  isoWeekdayFromLocalDate,
  SUPPORTED_ACTIONS,
  type SupportedAction,
  type SupportedRootKind,
  type StorageBucketPrecondition,
  type StoragePrecondition,
  type StorageCommand,
  type OperationEnvelope,
  type OutboxReplayItem,
  type OutboxStatus,
  type OutboxEntry,
  canonicalizeJson,
  canonicalizeCommandsForStorage,
  assertOperationWireSize,
  sha256Hex,
  computeCanonicalHash,
  validateCommand,
  validateOperationDraft,
} from "./outbox";

export {
  confirmPulledOperationInTx,
} from "./repositories";

export {
  type StoredViewPreference,
  readOwnerViewPreference,
  writeOwnerViewPreference,
  migrateLegacyViewPreferences,
  isValidCalendarDate,
  MIN_CALENDAR_DATE,
  MAX_CALENDAR_DATE,
} from "./view-preferences";
