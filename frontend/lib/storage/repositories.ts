import { type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";
import { type OpenDatabaseOptions, openDatabase, closeDatabase } from "./db";
import { type EncryptedRecord, decryptPayload } from "./crypto";
import { type OwnerAccessContext, validateOwnerAccess } from "./owner-gate";
import { type OperationEnvelope, type OutboxEntry } from "./outbox";
import { type PersistOperationInput, type PersistOperationResult, persistOperationAtomic } from "./unit-of-work";

export interface LocalStorageGateway {
  open(): Promise<StorageResult<void>>;
  listPending(
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
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      const activeDb = openRes.value;

      const valRes = await validateOwnerAccess(activeDb, ctx);
      if (!valRes.ok) {
        return valRes;
      }

      const entries = await new Promise<StorageResult<OutboxEntry[]>>(
        (resolve) => {
          try {
            const tx = activeDb.transaction(
              STORAGE_STORES.operations,
              "readonly"
            );
            const store = tx.objectStore(STORAGE_STORES.operations);
            const range = IDBKeyRange.bound(
              [ctx.ownerId, ""],
              [ctx.ownerId, "\uffff"]
            );
            const req = store.getAll(range);

            req.onsuccess = () => {
              const rows = (req.result as OutboxEntry[]) ?? [];
              resolve(storageOk(rows));
            };
            req.onerror = () => {
              resolve(
                storageErr(
                  "unavailable",
                  req.error?.message ?? "Failed to read operations",
                  req.error
                )
              );
            };
            tx.onabort = () => {
              resolve(
                storageErr(
                  "transaction_aborted",
                  tx.error?.message ?? "Transaction aborted",
                  tx.error
                )
              );
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
        }
      );

      if (!entries.ok) {
        return entries;
      }

      const pendingRows = entries.value.filter(
        (row) => row.status === "pending"
      );

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

      // Sort by device_sequence ascending
      envelopes.sort((a, b) => {
        try {
          const diff = BigInt(a.device_sequence) - BigInt(b.device_sequence);
          return diff < BigInt(0) ? -1 : diff > BigInt(0) ? 1 : 0;
        } catch {
          return a.device_sequence.localeCompare(b.device_sequence);
        }
      });

      return storageOk(envelopes);
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
      const activeDb = openRes.value;

      const valRes = await validateOwnerAccess(activeDb, ctx);
      if (!valRes.ok) {
        return valRes;
      }

      const rowResult = await new Promise<
        StorageResult<{
          owner_id: string;
          kind: string;
          id: string;
          key_id: string;
          store?: string;
          record_id?: string;
          iv: Uint8Array;
          ciphertext: Uint8Array;
        } | null>
      >((resolve) => {
        try {
          const tx = activeDb.transaction(STORAGE_STORES.records, "readonly");
          const store = tx.objectStore(STORAGE_STORES.records);
          const req = store.get([ctx.ownerId, kind, id]);

          req.onsuccess = () => {
            resolve(storageOk(req.result ?? null));
          };
          req.onerror = () => {
            resolve(
              storageErr(
                "unavailable",
                req.error?.message ?? "Failed to read record",
                req.error
              )
            );
          };
          tx.onabort = () => {
            resolve(
              storageErr(
                "transaction_aborted",
                tx.error?.message ?? "Transaction aborted",
                tx.error
              )
            );
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
        store: row.store ?? STORAGE_STORES.records,
        record_id: row.record_id ?? `${kind}:${id}`,
        key_id: row.key_id,
        iv: row.iv,
        ciphertext: row.ciphertext,
      };

      const decRes = await decryptPayload<T>(
        ctx.key,
        encRecord,
        ctx.ownerId,
        encRecord.store,
        encRecord.record_id
      );

      return decRes;
    },

    close(): void {
      if (db) {
        closeDatabase(db);
        db = null;
      }
    },
  };
}
