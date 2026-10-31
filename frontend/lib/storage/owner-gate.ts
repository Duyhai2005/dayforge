import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";
import { encryptPayload, decryptPayload } from "./crypto";

export const OWNER_KEY_SENTINEL_RECORD_ID = "owner-key-sentinel";

interface SentinelPayload {
  kind: "dayforge-owner-key-check";
  format_version: 1;
  owner_id: string;
  key_id: string;
}

interface SentinelSyncMetaRow {
  owner_id: string;
  key: string;
  key_id: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  created_at?: string;
}

export interface OwnerAccessContext {
  readonly ownerId: string;
  readonly keyId: string;
  readonly lockEpoch: number;
  readonly key: CryptoKey;
}

export interface OwnerMetadata {
  owner_id: string;
  lock_epoch: number;
  locked: boolean;
  active_key_id?: string;
}

export async function getOwnerMeta(
  db: IDBDatabase,
  ownerId: string
): Promise<StorageResult<OwnerMetadata | null>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORAGE_STORES.owner_meta, "readonly");
      const store = tx.objectStore(STORAGE_STORES.owner_meta);
      const req = store.get(ownerId);

      req.onsuccess = () => {
        const meta = (req.result as OwnerMetadata) ?? null;
        resolve(storageOk(meta));
      };
      req.onerror = () => {
        resolve(
          storageErr(
            "unavailable",
            req.error?.message ?? "Failed to read owner metadata",
            req.error
          )
        );
      };
      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while reading owner metadata",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error accessing owner_meta store",
          err
        )
      );
    }
  });
}

export async function setOwnerMeta(
  db: IDBDatabase,
  meta: OwnerMetadata
): Promise<StorageResult<void>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORAGE_STORES.owner_meta, "readwrite");
      const store = tx.objectStore(STORAGE_STORES.owner_meta);
      store.put(meta);

      tx.oncomplete = () => resolve(storageOk(undefined));
      tx.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Failed to save owner metadata",
            tx.error
          )
        );
      };
      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while saving owner metadata",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error accessing owner_meta store",
          err
        )
      );
    }
  });
}

export function checkOwnerMetaRecord(
  meta: OwnerMetadata | undefined,
  ctx: OwnerAccessContext
): StorageError | null {
  if (!meta) {
    return new StorageError(
      "locked",
      `Owner '${ctx.ownerId}' has not been initialized or unlocked`
    );
  }
  if (meta.locked) {
    return new StorageError("locked", `Owner '${ctx.ownerId}' is currently locked`);
  }
  if (meta.lock_epoch !== ctx.lockEpoch) {
    return new StorageError(
      "locked",
      `Stale access context: current epoch is ${meta.lock_epoch}, context epoch is ${ctx.lockEpoch}`
    );
  }
  if (!meta.active_key_id || meta.active_key_id !== ctx.keyId) {
    return new StorageError(
      "locked",
      `Stale access context: active key ID is '${meta.active_key_id ?? "missing"}', context key ID is '${ctx.keyId}'`
    );
  }
  return null;
}

export async function validateOwnerAccess(
  db: IDBDatabase,
  ctx: OwnerAccessContext
): Promise<StorageResult<void>> {
  const metaRes = await getOwnerMeta(db, ctx.ownerId);
  if (!metaRes.ok) {
    return metaRes;
  }
  const err = checkOwnerMetaRecord(metaRes.value ?? undefined, ctx);
  if (err) {
    return { ok: false, error: err };
  }
  return storageOk(undefined);
}

export async function isOwnerUnlocked(
  db: IDBDatabase,
  ownerId: string
): Promise<StorageResult<boolean>> {
  const metaRes = await getOwnerMeta(db, ownerId);
  if (!metaRes.ok) {
    return metaRes;
  }
  const meta = metaRes.value;
  return storageOk(Boolean(meta && !meta.locked));
}

export async function lockOwner(
  db: IDBDatabase,
  ownerId: string
): Promise<StorageResult<number>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [STORAGE_STORES.owner_meta, STORAGE_STORES.crypto_keys],
        "readwrite"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const cryptoStore = tx.objectStore(STORAGE_STORES.crypto_keys);
      let calculatedEpoch = 1;

      const getReq = metaStore.get(ownerId);
      getReq.onsuccess = () => {
        const existing = getReq.result as OwnerMetadata | undefined;
        calculatedEpoch = (existing?.lock_epoch ?? 0) + 1;
        const updatedMeta: OwnerMetadata = {
          owner_id: ownerId,
          lock_epoch: calculatedEpoch,
          locked: true,
          active_key_id: existing?.active_key_id,
        };

        metaStore.put(updatedMeta);

        // Delete keys for owner from crypto_keys
        try {
          const range = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
          cryptoStore.delete(range);
        } catch {
          if (existing?.active_key_id) {
            cryptoStore.delete([ownerId, existing.active_key_id]);
          }
        }
      };

      getReq.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            getReq.error?.message ?? "Failed to read owner metadata for lock",
            getReq.error
          )
        );
      };

      tx.oncomplete = () => {
        resolve(storageOk(calculatedEpoch));
      };

      tx.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while locking owner",
            tx.error
          )
        );
      };

      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while locking owner",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error executing lockOwner transaction",
          err
        )
      );
    }
  });
}

export async function unlockOwner(
  db: IDBDatabase,
  ownerId: string,
  keyId: string,
  key: CryptoKey
): Promise<StorageResult<OwnerAccessContext>> {
  const algo = key?.algorithm as AesKeyAlgorithm | undefined;
  if (
    !key ||
    key.type !== "secret" ||
    algo?.name !== "AES-GCM" ||
    algo?.length !== 256 ||
    key.extractable !== false ||
    !key.usages?.includes("encrypt") ||
    !key.usages?.includes("decrypt")
  ) {
    return storageErr(
      "invalid_data",
      "CryptoKey must be non-extractable 256-bit AES-GCM with encrypt and decrypt usages"
    );
  }

  // Phase 1: Read existing state
  type Phase1State = {
    meta: OwnerMetadata | null;
    sentinel: SentinelSyncMetaRow | null;
    recordsCount: number;
    operationsCount: number;
  };

  const phase1Result = await new Promise<StorageResult<Phase1State>>((resolve) => {
    try {
      const tx = db.transaction(
        [
          STORAGE_STORES.owner_meta,
          STORAGE_STORES.sync_meta,
          STORAGE_STORES.records,
          STORAGE_STORES.operations,
        ],
        "readonly"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const syncStore = tx.objectStore(STORAGE_STORES.sync_meta);
      const recStore = tx.objectStore(STORAGE_STORES.records);
      const opStore = tx.objectStore(STORAGE_STORES.operations);

      const metaReq = metaStore.get(ownerId);
      const syncReq = syncStore.get([ownerId, OWNER_KEY_SENTINEL_RECORD_ID]);
      const recReq = recStore.index("by_kind").count(IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]));
      const opReq = opStore.count(IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]));

      tx.oncomplete = () => {
        resolve(
          storageOk({
            meta: (metaReq.result as OwnerMetadata) ?? null,
            sentinel: (syncReq.result as SentinelSyncMetaRow) ?? null,
            recordsCount: recReq.result ?? 0,
            operationsCount: opReq.result ?? 0,
          })
        );
      };

      tx.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Failed to read owner state for unlock",
            tx.error
          )
        );
      };

      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while reading owner state",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error executing unlock read transaction",
          err
        )
      );
    }
  });

  if (!phase1Result.ok) {
    return phase1Result;
  }

  const { meta: existing, sentinel, recordsCount, operationsCount } = phase1Result.value;

  // Phase 2: Metadata validation & Key continuity verification
  if (existing) {
    if (!existing.locked) {
      if (!existing.active_key_id) {
        return storageErr(
          "invalid_data",
          `Unlocked owner '${ownerId}' is missing active_key_id; lock and re-unlock required`
        );
      }
      if (existing.active_key_id !== keyId) {
        return storageErr(
          "invalid_data",
          `Cannot switch active key from '${existing.active_key_id}' to '${keyId}' while owner is unlocked`
        );
      }
    } else {
      if (existing.active_key_id && existing.active_key_id !== keyId) {
        return storageErr(
          "invalid_data",
          `Cannot unlock owner with key '${keyId}'; expected stable key '${existing.active_key_id}'`
        );
      }
    }
  }

  let newSentinelRecord: SentinelSyncMetaRow | null = null;

  if (sentinel) {
    // Sentinel exists: verify key continuity by authenticating and decrypting the sentinel
    const decRes = await decryptPayload<SentinelPayload>(
      key,
      {
        owner_id: ownerId,
        store: STORAGE_STORES.sync_meta,
        record_id: OWNER_KEY_SENTINEL_RECORD_ID,
        key_id: sentinel.key_id ?? keyId,
        iv: sentinel.iv,
        ciphertext: sentinel.ciphertext,
      },
      ownerId,
      STORAGE_STORES.sync_meta,
      OWNER_KEY_SENTINEL_RECORD_ID
    );

    if (!decRes.ok) {
      return storageErr(
        "integrity_failed",
        `Key continuity check failed for owner '${ownerId}' and key '${keyId}': provided key cannot authenticate existing data`
      );
    }

    const payload = decRes.value;
    if (
      !payload ||
      payload.kind !== "dayforge-owner-key-check" ||
      payload.owner_id !== ownerId ||
      payload.key_id !== keyId
    ) {
      return storageErr(
        "integrity_failed",
        `Key continuity sentinel payload corrupted for owner '${ownerId}'`
      );
    }
  } else {
    // Sentinel does not exist
    const hasExistingData =
      existing?.active_key_id !== undefined && (recordsCount > 0 || operationsCount > 0);

    if (hasExistingData) {
      return storageErr(
        "integrity_failed",
        `Key sentinel missing for owner '${ownerId}' with existing data; key continuity cannot be verified`
      );
    }

    // Fresh owner initialization: create new encrypted sentinel
    const sentinelPlaintext: SentinelPayload = {
      kind: "dayforge-owner-key-check",
      format_version: 1,
      owner_id: ownerId,
      key_id: keyId,
    };

    const encRes = await encryptPayload(
      key,
      ownerId,
      keyId,
      STORAGE_STORES.sync_meta,
      OWNER_KEY_SENTINEL_RECORD_ID,
      sentinelPlaintext
    );

    if (!encRes.ok) {
      return encRes;
    }

    newSentinelRecord = {
      owner_id: ownerId,
      key: OWNER_KEY_SENTINEL_RECORD_ID,
      key_id: keyId,
      iv: encRes.value.iv,
      ciphertext: encRes.value.ciphertext,
      created_at: new Date().toISOString(),
    };
  }

  // Phase 3: Write Transaction (Atomic Commit)
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [
          STORAGE_STORES.owner_meta,
          STORAGE_STORES.crypto_keys,
          STORAGE_STORES.sync_meta,
        ],
        "readwrite"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const cryptoStore = tx.objectStore(STORAGE_STORES.crypto_keys);
      const syncStore = tx.objectStore(STORAGE_STORES.sync_meta);

      let customError: StorageError | null = null;
      let contextResult: OwnerAccessContext | null = null;

      const getReq = metaStore.get(ownerId);
      getReq.onsuccess = () => {
        const currentMeta = getReq.result as OwnerMetadata | undefined;

        // Anti-TOCTOU: if lock_epoch changed while decrypting, abort!
        if (existing && currentMeta && currentMeta.lock_epoch !== existing.lock_epoch) {
          customError = new StorageError(
            "locked",
            `Owner '${ownerId}' lock epoch changed concurrently (expected ${existing.lock_epoch}, got ${currentMeta.lock_epoch})`
          );
          tx.abort();
          return;
        }

        const epoch =
          currentMeta?.lock_epoch && currentMeta.lock_epoch > 0
            ? currentMeta.lock_epoch
            : 1;

        const updatedMeta: OwnerMetadata = {
          owner_id: ownerId,
          lock_epoch: epoch,
          locked: false,
          active_key_id: keyId,
        };
        metaStore.put(updatedMeta);

        cryptoStore.put({
          owner_id: ownerId,
          key_id: keyId,
          key,
          created_at: new Date().toISOString(),
        });

        if (newSentinelRecord) {
          syncStore.put(newSentinelRecord);
        }

        contextResult = {
          ownerId,
          keyId,
          lockEpoch: epoch,
          key,
        };
      };

      getReq.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            getReq.error?.message ?? "Failed to read owner metadata for unlock commit",
            getReq.error
          )
        );
      };

      tx.oncomplete = () => {
        if (!contextResult) {
          resolve(
            storageErr(
              "transaction_aborted",
              customError?.message ?? "Transaction completed without establishing owner access context",
              customError
            )
          );
          return;
        }
        resolve(storageOk(contextResult));
      };

      tx.onerror = () => {
        resolve(
          storageErr(
            customError ? customError.code : "transaction_aborted",
            customError ? customError.message : tx.error?.message ?? "Transaction aborted while unlocking owner",
            customError ?? tx.error
          )
        );
      };

      tx.onabort = () => {
        resolve(
          storageErr(
            customError ? customError.code : "transaction_aborted",
            customError ? customError.message : "Transaction aborted while unlocking owner",
            customError ?? tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error executing unlock write transaction",
          err
        )
      );
    }
  });
}
