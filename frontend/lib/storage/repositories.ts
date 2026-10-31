import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";
import { type OpenDatabaseOptions, openDatabase, closeDatabase } from "./db";
import { type EncryptedRecord, decryptPayload } from "./crypto";
import {
  type OwnerAccessContext,
  type OwnerMetadata,
  checkOwnerMetaRecord,
} from "./owner-gate";
import { type OperationEnvelope, type OutboxEntry } from "./outbox";
import {
  type PersistOperationInput,
  type PersistOperationResult,
  persistOperationAtomic,
} from "./unit-of-work";

export interface LocalStorageGateway {
  open(): Promise<StorageResult<void>>;
  listPending(
    ctx: OwnerAccessContext
  ): Promise<StorageResult<readonly OperationEnvelope[]>>;
  listPendingOperations(
    ctx: OwnerAccessContext
  ): Promise<StorageResult<readonly OperationEnvelope[]>>;
  persistOperation(
    input: PersistOperationInput
  ): Promise<StorageResult<PersistOperationResult>>;
  getRecord<T>(
    ctx: OwnerAccessContext,
    kind: string,
    id: string
  ): Promise<StorageResult<T | null>>;
  markOperationAcked(
    ctx: OwnerAccessContext,
    operationId: string
  ): Promise<StorageResult<void>>;
  markOperationSynced(
    ctx: OwnerAccessContext,
    operationId: string
  ): Promise<StorageResult<void>>;
  close(): void;
}

export function createLocalStorageGateway(
  options?: OpenDatabaseOptions
): LocalStorageGateway {
  let db: IDBDatabase | null = null;

  async function ensureOpen(): Promise<StorageResult<IDBDatabase>> {
    if (db) {
      return storageOk(db);
    }
    const openRes = await openDatabase(options);
    if (!openRes.ok) {
      return openRes;
    }
    db = openRes.value;
    return storageOk(db);
  }

  return {
    async open(): Promise<StorageResult<void>> {
      const res = await ensureOpen();
      if (!res.ok) {
        return res;
      }
      return storageOk(undefined);
    },

    async persistOperation(
      input: PersistOperationInput
    ): Promise<StorageResult<PersistOperationResult>> {
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      return await persistOperationAtomic(openRes.value, input);
    },

    async listPending(
      ctx: OwnerAccessContext
    ): Promise<StorageResult<readonly OperationEnvelope[]>> {
      return this.listPendingOperations(ctx);
    },

    async listPendingOperations(
      ctx: OwnerAccessContext
    ): Promise<StorageResult<readonly OperationEnvelope[]>> {
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      return await listPendingOperations(openRes.value, ctx);
    },

    async getRecord<T>(
      ctx: OwnerAccessContext,
      kind: string,
      id: string
    ): Promise<StorageResult<T | null>> {
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      return await getRecord<T>(openRes.value, ctx, kind, id);
    },

    async markOperationAcked(
      ctx: OwnerAccessContext,
      operationId: string
    ): Promise<StorageResult<void>> {
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      return await markOperationAcked(openRes.value, ctx, operationId);
    },

    async markOperationSynced(
      ctx: OwnerAccessContext,
      operationId: string
    ): Promise<StorageResult<void>> {
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      return await markOperationSynced(openRes.value, ctx, operationId);
    },

    close(): void {
      if (db) {
        closeDatabase(db);
        db = null;
      }
    },
  };
}

export async function listPendingOperations(
  db: IDBDatabase,
  ctx: OwnerAccessContext
): Promise<StorageResult<readonly OperationEnvelope[]>> {
  const entries = await new Promise<StorageResult<OutboxEntry[]>>((resolve) => {
    let customError: StorageError | null = null;
    try {
      const tx = db.transaction(
        [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
        "readonly"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const opStore = tx.objectStore(STORAGE_STORES.operations);

      const metaReq = metaStore.get(ctx.ownerId);
      const range = IDBKeyRange.bound(
        [ctx.ownerId, ""],
        [ctx.ownerId, "\uffff"]
      );
      const opReq = opStore.getAll(range);

      let metaChecked = false;
      let rows: OutboxEntry[] = [];
      let opsRead = false;

      const finishIfReady = () => {
        if (metaChecked && opsRead) {
          resolve(storageOk(rows));
        }
      };

      metaReq.onsuccess = () => {
        const meta = metaReq.result as OwnerMetadata | undefined;
        const checkErr = checkOwnerMetaRecord(meta, ctx);
        if (checkErr) {
          customError = checkErr;
          tx.abort();
          return;
        }
        metaChecked = true;
        finishIfReady();
      };
      metaReq.onerror = () => {
        if (!customError) {
          customError = new StorageError(
            "unavailable",
            metaReq.error?.message ?? "Failed to read owner metadata",
            metaReq.error
          );
        }
      };

      opReq.onsuccess = () => {
        rows = (opReq.result as OutboxEntry[]) ?? [];
        opsRead = true;
        finishIfReady();
      };
      opReq.onerror = () => {
        if (!customError) {
          customError = new StorageError(
            "unavailable",
            opReq.error?.message ?? "Failed to read operations",
            opReq.error
          );
        }
      };

      tx.onerror = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "unavailable",
              tx.error?.message ?? "Transaction error reading operations",
              tx.error
            )
          );
        }
      };

      tx.onabort = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "transaction_aborted",
              tx.error?.message ?? "Transaction aborted reading operations",
              tx.error
            )
          );
        }
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error reading operations",
          err
        )
      );
    }
  });

  if (!entries.ok) {
    return entries;
  }

  const pendingRows = entries.value.filter((row) => row.status === "pending");

  const envelopes: OperationEnvelope[] = [];
  for (const row of pendingRows) {
    const decRes = await decryptPayload<OperationEnvelope>(
      ctx.key,
      row.encrypted_envelope,
      ctx.ownerId,
      STORAGE_STORES.operations,
      row.operation_id
    );
    if (!decRes.ok) {
      return decRes;
    }
    envelopes.push(decRes.value);
  }

  envelopes.sort((a, b) => {
    try {
      const diff = BigInt(a.device_sequence) - BigInt(b.device_sequence);
      return diff < BigInt(0) ? -1 : diff > BigInt(0) ? 1 : 0;
    } catch {
      return a.device_sequence.localeCompare(b.device_sequence);
    }
  });

  return storageOk(envelopes);
}

export const listPending = listPendingOperations;

export async function getRecord<T>(
  db: IDBDatabase,
  ctx: OwnerAccessContext,
  kind: string,
  id: string
): Promise<StorageResult<T | null>> {
  const rowResult = await new Promise<
    StorageResult<{
      owner_id: string;
      kind: string;
      id: string;
      key_id: string;
      iv: Uint8Array;
      ciphertext: Uint8Array;
    } | null>
  >((resolve) => {
    let customError: StorageError | null = null;
    try {
      const tx = db.transaction(
        [STORAGE_STORES.owner_meta, STORAGE_STORES.records],
        "readonly"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const recStore = tx.objectStore(STORAGE_STORES.records);

      const metaReq = metaStore.get(ctx.ownerId);
      const recReq = recStore.get([ctx.ownerId, kind, id]);

      let metaChecked = false;
      let recordValue: any = null;
      let recordRead = false;

      const finishIfReady = () => {
        if (metaChecked && recordRead) {
          resolve(storageOk(recordValue));
        }
      };

      metaReq.onsuccess = () => {
        const meta = metaReq.result as OwnerMetadata | undefined;
        const checkErr = checkOwnerMetaRecord(meta, ctx);
        if (checkErr) {
          customError = checkErr;
          tx.abort();
          return;
        }
        metaChecked = true;
        finishIfReady();
      };
      metaReq.onerror = () => {
        if (!customError) {
          customError = new StorageError(
            "unavailable",
            metaReq.error?.message ?? "Failed to read owner metadata",
            metaReq.error
          );
        }
      };

      recReq.onsuccess = () => {
        recordValue = recReq.result ?? null;
        recordRead = true;
        finishIfReady();
      };
      recReq.onerror = () => {
        if (!customError) {
          customError = new StorageError(
            "unavailable",
            recReq.error?.message ?? "Failed to read record",
            recReq.error
          );
        }
      };

      tx.onerror = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "unavailable",
              tx.error?.message ?? "Transaction error reading record",
              tx.error
            )
          );
        }
      };

      tx.onabort = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "transaction_aborted",
              tx.error?.message ?? "Transaction aborted reading record",
              tx.error
            )
          );
        }
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error reading records",
          err
        )
      );
    }
  });

  if (!rowResult.ok) {
    return rowResult;
  }

  const row = rowResult.value;
  if (!row) {
    return storageOk(null);
  }

  const encRecord: EncryptedRecord = {
    owner_id: row.owner_id,
    store: STORAGE_STORES.records,
    record_id: `${kind}:${id}`,
    key_id: row.key_id,
    iv: row.iv,
    ciphertext: row.ciphertext,
  };

  const decRes = await decryptPayload<T>(
    ctx.key,
    encRecord,
    ctx.ownerId,
    STORAGE_STORES.records,
    `${kind}:${id}`
  );

  return decRes;
}

export async function markOperationAcked(
  db: IDBDatabase,
  ctx: OwnerAccessContext,
  operationId: string
): Promise<StorageResult<void>> {
  return new Promise((resolve) => {
    let customError: StorageError | null = null;
    try {
      const tx = db.transaction(
        [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
        "readwrite"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const opStore = tx.objectStore(STORAGE_STORES.operations);

      const metaReq = metaStore.get(ctx.ownerId);
      metaReq.onsuccess = () => {
        const meta = metaReq.result as OwnerMetadata | undefined;
        const checkErr = checkOwnerMetaRecord(meta, ctx);
        if (checkErr) {
          customError = checkErr;
          tx.abort();
          return;
        }

        const opReq = opStore.get([ctx.ownerId, operationId]);
        opReq.onsuccess = () => {
          const entry = opReq.result as OutboxEntry | undefined;
          if (!entry) {
            customError = new StorageError(
              "invalid_data",
              `Operation '${operationId}' not found in outbox`
            );
            tx.abort();
            return;
          }
          entry.status = "ack_waiting_pull";
          opStore.put(entry);
        };
        opReq.onerror = () => {
          customError = new StorageError(
            "unavailable",
            opReq.error?.message ?? "Failed to read outbox entry",
            opReq.error
          );
        };
      };
      metaReq.onerror = () => {
        customError = new StorageError(
          "unavailable",
          metaReq.error?.message ?? "Failed to read owner metadata",
          metaReq.error
        );
      };

      tx.oncomplete = () => {
        resolve(storageOk(undefined));
      };

      tx.onerror = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "unavailable",
              tx.error?.message ?? "Transaction error while marking operation acked",
              tx.error
            )
          );
        }
      };

      tx.onabort = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "transaction_aborted",
              tx.error?.message ?? "Transaction aborted while marking operation acked",
              tx.error
            )
          );
        }
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error marking operation acked",
          err
        )
      );
    }
  });
}

export async function markOperationSynced(
  db: IDBDatabase,
  ctx: OwnerAccessContext,
  operationId: string
): Promise<StorageResult<void>> {
  return new Promise((resolve) => {
    let customError: StorageError | null = null;
    try {
      const tx = db.transaction(
        [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
        "readwrite"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const opStore = tx.objectStore(STORAGE_STORES.operations);

      const metaReq = metaStore.get(ctx.ownerId);
      metaReq.onsuccess = () => {
        const meta = metaReq.result as OwnerMetadata | undefined;
        const checkErr = checkOwnerMetaRecord(meta, ctx);
        if (checkErr) {
          customError = checkErr;
          tx.abort();
          return;
        }

        const opReq = opStore.get([ctx.ownerId, operationId]);
        opReq.onsuccess = () => {
          const entry = opReq.result as OutboxEntry | undefined;
          if (!entry) {
            customError = new StorageError(
              "invalid_data",
              `Operation '${operationId}' not found in outbox`
            );
            tx.abort();
            return;
          }
          opStore.delete([ctx.ownerId, operationId]);
        };
        opReq.onerror = () => {
          customError = new StorageError(
            "unavailable",
            opReq.error?.message ?? "Failed to read outbox entry",
            opReq.error
          );
        };
      };
      metaReq.onerror = () => {
        customError = new StorageError(
          "unavailable",
          metaReq.error?.message ?? "Failed to read owner metadata",
          metaReq.error
        );
      };

      tx.oncomplete = () => {
        resolve(storageOk(undefined));
      };

      tx.onerror = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "unavailable",
              tx.error?.message ?? "Transaction error while marking operation synced",
              tx.error
            )
          );
        }
      };

      tx.onabort = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
        } else {
          resolve(
            storageErr(
              "transaction_aborted",
              tx.error?.message ?? "Transaction aborted while marking operation synced",
              tx.error
            )
          );
        }
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error marking operation synced",
          err
        )
      );
    }
  });
}
