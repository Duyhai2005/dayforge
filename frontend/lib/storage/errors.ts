export type StorageErrorCode =
  | "unavailable"
  | "blocked"
  | "quota_exceeded"
  | "locked"
  | "owner_mismatch"
  | "migration_failed"
  | "integrity_failed"
  | "transaction_aborted"
  | "unsupported_version"
  | "invalid_data";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  override readonly cause?: unknown;

  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}

export type StorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StorageError };

export function storageOk<T>(value: T): StorageResult<T> {
  return { ok: true, value };
}

export function storageErr<T = never>(
  code: StorageErrorCode,
  message: string,
  cause?: unknown
): StorageResult<T> {
  return { ok: false, error: new StorageError(code, message, cause) };
}
