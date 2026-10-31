// Storage Error Handling
export {
  StorageError,
  type StorageErrorCode,
  type StorageResult,
  storageOk,
  storageErr,
} from "./errors";

// Schema & Stores
export {
  DB_NAME,
  CURRENT_SCHEMA_VERSION,
  STORAGE_STORES,
  type StorageStoreName,
  type StoreIndexDefinition,
  type StoreDefinition,
  STORE_DEFINITIONS,
  upgradeDatabase,
} from "./schema";

// Migration Framework
export {
  type MigrationStep,
  registerMigrationStep,
  clearMigrationSteps,
  getRegisteredMigrationSteps,
  getMaxSupportedVersion,
  isVersionSupported,
  checkVersionCompatibility,
  executeMigrations,
} from "./migration";

// Database Connection Lifecycle
export {
  openDatabase,
  closeDatabase,
  type OpenDatabaseOptions,
} from "./db";

// Cryptographic Primitives & Envelope Encryption
export {
  type EncryptedRecord,
  createAad,
  encryptPayload,
  decryptPayload,
  generateTestKey,
  importRawKey,
  storeCryptoKey,
  getCryptoKey,
  removeCryptoKey,
} from "./crypto";

// Owner Gate & Access Context
export {
  type OwnerAccessContext,
  type OwnerMetadata,
  getOwnerMeta,
  setOwnerMeta,
  checkOwnerMetaRecord,
  validateOwnerAccess,
  unlockOwner,
  lockOwner,
  isOwnerUnlocked,
} from "./owner-gate";

// Hybrid Logical Clock (HLC)
export {
  type HlcEditTime,
  validateHlc,
  advanceHlc,
} from "./clock-state";

// Outbox, Commands & Canonicalization
export {
  UUID_PATTERN,
  HASH_PATTERN,
  DATE_PATTERN,
  SUPPORTED_ACTIONS,
  type SupportedAction,
  type SupportedRootKind,
  type StorageBucketPrecondition,
  type StoragePrecondition,
  type StorageCommand,
  type OperationEnvelope,
  type OutboxStatus,
  type OutboxEntry,
  canonicalizeJson,
  sha256Hex,
  computeCanonicalHash,
  validateCommand,
  validateOperationDraft,
} from "./outbox";

// Atomic Unit of Work
export {
  type ClockInputParams,
  type PersistOperationInput,
  type PersistOperationResult,
  type RecordOverlayInput,
  type DeviceMetadata,
  persistOperationAtomic,
} from "./unit-of-work";

// Gateway & Store Repositories
export {
  type LocalStorageGateway,
  createLocalStorageGateway,
  getRecord,
  listPending,
  listPendingOperations,
  markOperationAcked,
  markOperationSynced,
} from "./repositories";

// Encrypted View Preferences Primitive
export {
  type StoredViewPreference,
  readOwnerViewPreference,
  writeOwnerViewPreference,
  migrateLegacyViewPreferences,
  isValidCalendarDate,
  MIN_CALENDAR_DATE,
  MAX_CALENDAR_DATE,
} from "./view-preferences";


