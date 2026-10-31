import { type StorageResult, StorageError, storageErr, storageOk } from "./errors";
import { CURRENT_SCHEMA_VERSION, DB_NAME, upgradeDatabase } from "./schema";

export interface OpenDatabaseOptions {
  name?: string;
  version?: number;
  onBlocked?: () => void;
  onVersionChange?: () => void;
  blockedTimeoutMs?: number;
}

export async function openDatabase(
  options?: OpenDatabaseOptions
): Promise<StorageResult<IDBDatabase>> {
  let idb: IDBFactory | undefined;
  try {
    idb = typeof window !== "undefined" && typeof indexedDB !== "undefined" ? indexedDB : undefined;
  } catch (err) {
    return storageErr(
      "unavailable",
      err instanceof Error ? err.message : "IndexedDB is restricted in this context",
      err
    );
  }

  if (typeof window === "undefined" || !idb) {
    return storageErr("unavailable", "IndexedDB is not available in server context");
  }

  const name = options?.name ?? DB_NAME;
  const version = options?.version ?? CURRENT_SCHEMA_VERSION;
  const blockedTimeoutMs = options?.blockedTimeoutMs ?? 1000;

  return new Promise<StorageResult<IDBDatabase>>((resolve) => {
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    let migrationError: unknown = null;

    const cleanup = (): void => {
      if (blockedTimer !== null) {
        clearTimeout(blockedTimer);
        blockedTimer = null;
      }
    };

    let request: IDBOpenDBRequest;
    try {
      request = idb.open(name, version);
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Failed to invoke indexedDB.open",
          err
        )
      );
      return;
    }

    request.onblocked = (): void => {
      if (options?.onBlocked) {
        try {
          options.onBlocked();
        } catch {
          // Ignore caller callback exceptions
        }
      }

      if (!blockedTimer && blockedTimeoutMs > 0) {
        blockedTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(
              storageErr(
                "blocked",
                `Database open was blocked by another open connection and did not resolve within ${blockedTimeoutMs}ms`
              )
            );
          }
        }, blockedTimeoutMs);
      }
    };

    request.onupgradeneeded = (event): void => {
      const db = request.result;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion ?? version;
      const transaction = request.transaction;
      try {
        upgradeDatabase(db, oldVersion, newVersion, transaction);
      } catch (err) {
        migrationError = err;
        try {
          transaction?.abort();
        } catch {
          // Ignore abort error
        }
      }
    };

    request.onsuccess = (): void => {
      cleanup();
      if (settled) {
        try {
          request.result.close();
        } catch {
          // Ignore close error on stale connection
        }
        return;
      }
      settled = true;
      const db = request.result;

      db.addEventListener("versionchange", () => {
        if (options?.onVersionChange) {
          try {
            options.onVersionChange();
          } catch {
            // Ignore callback error
          }
        }
        try {
          db.close();
        } catch {
          // Ignore close error
        }
      });

      resolve(storageOk(db));
    };

    request.onerror = (): void => {
      cleanup();
      if (settled) return;
      settled = true;

      const error = request.error;
      const errorName = error?.name;

      if (migrationError) {
        const code =
          migrationError instanceof StorageError
            ? migrationError.code
            : "migration_failed";
        resolve(
          storageErr(
            code,
            migrationError instanceof Error
              ? migrationError.message
              : "Migration failed during database upgrade",
            migrationError
          )
        );
        return;
      }

      if (errorName === "VersionError") {
        resolve(
          storageErr(
            "unsupported_version",
            `Database version on disk is higher than requested version ${version}`,
            error
          )
        );
        return;
      }

      if (errorName === "QuotaExceededError") {
        resolve(
          storageErr(
            "quota_exceeded",
            error?.message ?? "Storage quota exceeded",
            error
          )
        );
        return;
      }

      if (errorName === "AbortError") {
        resolve(
          storageErr(
            "transaction_aborted",
            error?.message ?? "Database transaction was aborted",
            error
          )
        );
        return;
      }

      resolve(
        storageErr(
          "unavailable",
          error?.message ?? "Failed to open database",
          error
        )
      );
    };
  });
}

export function closeDatabase(db: IDBDatabase): void {
  try {
    db.close();
  } catch {
    // Ignore close error
  }
}
