import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";

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
  if (meta.active_key_id && meta.active_key_id !== ctx.keyId) {
    return new StorageError(
      "locked",
      `Stale access context: active key ID is '${meta.active_key_id}', context key ID is '${ctx.keyId}'`
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
  if (
    !key ||
    key.type !== "secret" ||
    (key.algorithm as { name?: string })?.name !== "AES-GCM" ||
    key.extractable !== false ||
    !key.usages?.includes("encrypt") ||
    !key.usages?.includes("decrypt")
  ) {
    return storageErr(
      "invalid_data",
      "CryptoKey must be non-extractable AES-GCM with encrypt and decrypt usages"
    );
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [STORAGE_STORES.owner_meta, STORAGE_STORES.crypto_keys],
        "readwrite"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const cryptoStore = tx.objectStore(STORAGE_STORES.crypto_keys);
      let contextResult: OwnerAccessContext | null = null;

      const getReq = metaStore.get(ownerId);
      getReq.onsuccess = () => {
        const existing = getReq.result as OwnerMetadata | undefined;
        let epoch =
          existing?.lock_epoch && existing.lock_epoch > 0
            ? existing.lock_epoch
            : 1;

        // If owner is re-unlocked with a different key without locking, increment epoch
        if (
          existing &&
          !existing.locked &&
          existing.active_key_id &&
          existing.active_key_id !== keyId
        ) {
          epoch = epoch + 1;
        }

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
            getReq.error?.message ?? "Failed to read owner metadata for unlock",
            getReq.error
          )
        );
      };

      tx.oncomplete = () => {
        if (!contextResult) {
          resolve(
            storageErr(
              "transaction_aborted",
              "Failed to construct OwnerAccessContext"
            )
          );
          return;
        }
        resolve(storageOk(contextResult));
      };

      tx.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while unlocking owner",
            tx.error
          )
        );
      };

      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while unlocking owner",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error executing unlockOwner transaction",
          err
        )
      );
    }
  });
}
