// Stable application-facing storage API.
export {
  StorageError,
  type StorageErrorCode,
  type StorageResult,
  storageOk,
  storageErr,
} from "./errors";

export {
  type OwnerAccessContext,
} from "./owner-gate";

export {
  type HlcEditTime,
} from "./clock-state";

export {
  type StorageBucketPrecondition,
  type StoragePrecondition,
  type StorageCommand,
  type OperationEnvelope,
  type OutboxReplayItem,
  type OutboxStatus,
  type OutboxEntry,
} from "./outbox";

export {
  type ClockInputParams,
  type PersistOperationInput,
  type PersistOperationResult,
  type RecordOverlayInput,
} from "./unit-of-work";

export {
  type LocalStorageGateway,
  createLocalStorageGateway,
} from "./repositories";

export {
  type StoredViewPreference,
} from "./view-preferences";
