import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";
import { revalidateOwnerContext } from "./read-access";
import { type OpenDatabaseOptions, openDatabase, closeDatabase } from "./db";
import { type EncryptedRecord, decryptPayload } from "./crypto";
import {
  type OwnerAccessContext,
  type OwnerMetadata,
  checkOwnerMetaRecord,
} from "./owner-gate";
import {
  type OperationEnvelope,
  type OutboxEntry,
  type OutboxReplayItem,
  type OutboxStatus,
  HASH_PATTERN,
  UUID_PATTERN,
  computeCanonicalHash,
  validateOperationDraft,
} from "./outbox";
import { validateHlc } from "./clock-state";
import {
  type PersistOperationInput,
  type PersistOperationResult,
  persistOperationAtomic,
} from "./unit-of-work";

export interface LocalStorageGateway {
  open(): Promise<StorageResult<void>>;
  listSendableOperations(
    ctx: OwnerAccessContext
  ): Promise<StorageResult<readonly OperationEnvelope[]>>;
  listOutboxForReplay(
    ctx: OwnerAccessContext
  ): Promise<StorageResult<readonly OutboxReplayItem[]>>;
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
    const openRes = await openDatabase({
      ...options,
      onVersionChange: () => {
        db = null;
        options?.onVersionChange?.();
      },
      onClose: () => {
        db = null;
        options?.onClose?.();
      },
    });
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

    async listSendableOperations(
      ctx: OwnerAccessContext
    ): Promise<StorageResult<readonly OperationEnvelope[]>> {
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      return await listSendableOperations(openRes.value, ctx);
    },

    async listOutboxForReplay(
      ctx: OwnerAccessContext
    ): Promise<StorageResult<readonly OutboxReplayItem[]>> {
      const openRes = await ensureOpen();
      if (!openRes.ok) {
        return openRes;
      }
      return await listOutboxForReplay(openRes.value, ctx);
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

    close(): void {
      if (db) {
        closeDatabase(db);
        db = null;
      }
    },
  };
}

const OUTBOX_STATUSES: ReadonlySet<OutboxStatus> = new Set([
  "queued",
  "sending",
  "ack_waiting_pull",
  "blocked",
  "time_invalid",
  "superseded_by",
  "pending",
]);
const UINT64_MAX = BigInt("18446744073709551615");
const ENCRYPTED_RECORD_FIELDS = new Set([
  "owner_id",
  "store",
  "record_id",
  "key_id",
  "iv",
  "ciphertext",
]);
const ENVELOPE_FIELDS = new Set([
  "protocol_version",
  "reducer_version",
  "operation_id",
  "owner_id",
  "device_id",
  "device_sequence",
  "edit_time",
  "dependencies",
  "commands",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalUint64Sequence(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^[1-9][0-9]*$/.test(value)
  ) {
    return false;
  }
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
}

function hasExactFields(
  value: Record<string, unknown>,
  expectedFields: ReadonlySet<string>
): boolean {
  const fields = Object.keys(value);
  return (
    fields.length === expectedFields.size &&
    fields.every((field) => expectedFields.has(field))
  );
}

function isValidOutboxEntry(
  value: unknown,
  ctx: OwnerAccessContext
): value is OutboxEntry {
  if (!isRecord(value)) return false;
  if (
    value.owner_id !== ctx.ownerId ||
    typeof value.operation_id !== "string" ||
    !UUID_PATTERN.test(value.operation_id) ||
    !isCanonicalUint64Sequence(value.device_sequence) ||
    typeof value.status !== "string" ||
    !OUTBOX_STATUSES.has(value.status as OutboxStatus) ||
    typeof value.request_hash !== "string" ||
    !HASH_PATTERN.test(value.request_hash)
  ) {
    return false;
  }
  if (
    value.superseded_by !== undefined &&
    (typeof value.superseded_by !== "string" ||
      !UUID_PATTERN.test(value.superseded_by))
  ) {
    return false;
  }

  const encrypted = value.encrypted_envelope;
  if (
    !isRecord(encrypted) ||
    !hasExactFields(encrypted, ENCRYPTED_RECORD_FIELDS) ||
    encrypted.owner_id !== ctx.ownerId ||
    encrypted.store !== STORAGE_STORES.operations ||
    encrypted.record_id !== value.operation_id ||
    encrypted.key_id !== ctx.keyId ||
    !(encrypted.iv instanceof Uint8Array) ||
    encrypted.iv.byteLength !== 12 ||
    !(encrypted.ciphertext instanceof Uint8Array) ||
    encrypted.ciphertext.byteLength < 16
  ) {
    return false;
  }
  return true;
}

function isValidPersistedEnvelope(
  value: unknown,
  row: OutboxEntry,
  ctx: OwnerAccessContext
): value is OperationEnvelope {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ENVELOPE_FIELDS) ||
    value.protocol_version !== 1 ||
    value.reducer_version !== 1 ||
    value.operation_id !== row.operation_id ||
    value.owner_id !== ctx.ownerId ||
    value.device_sequence !== row.device_sequence ||
    typeof value.device_id !== "string" ||
    !UUID_PATTERN.test(value.device_id) ||
    !validateHlc(value.edit_time) ||
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.commands)
  ) {
    return false;
  }
  try {
    validateOperationDraft({
      operationId: value.operation_id,
      ownerId: value.owner_id,
      deviceId: value.device_id as string,
      commands: value.commands,
      dependencies: value.dependencies,
      editTime: value.edit_time,
    });
    return true;
  } catch {
    return false;
  }
}

function integrityError(): StorageResult<never> {
  return storageErr("integrity_failed", "Outbox entry failed integrity validation");
}

async function listOutboxOperations(
  db: IDBDatabase,
  ctx: OwnerAccessContext,
  includeStatus: (status: OutboxStatus) => boolean
): Promise<StorageResult<readonly OutboxReplayItem[]>> {
  const entries = await new Promise<StorageResult<unknown[]>>((resolve) => {
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
      let rows: unknown[] = [];
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
        rows = Array.isArray(opReq.result) ? opReq.result : [];
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

  if (!Array.isArray(entries.value)) {
    return integrityError();
  }
  const validatedRows: OutboxEntry[] = [];
  for (const row of entries.value) {
    if (!isValidOutboxEntry(row, ctx)) {
      return integrityError();
    }
    validatedRows.push(row);
  }

  const visibleRows = validatedRows.filter((row) => includeStatus(row.status));

  const replayItems: OutboxReplayItem[] = [];
  for (const row of visibleRows) {
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
    if (!isValidPersistedEnvelope(decRes.value, row, ctx)) {
      return integrityError();
    }
    let computedHash: string;
    try {
      computedHash = (await computeCanonicalHash(decRes.value)).hash;
    } catch {
      return integrityError();
    }
    if (computedHash !== row.request_hash) {
      return integrityError();
    }
    replayItems.push({
      envelope: decRes.value,
      status: row.status,
      requestHash: row.request_hash,
    });
  }

  // Revalidate after decryption; a concurrent close or upgrade stays typed.
  const accessRes = await revalidateOwnerContext(db, ctx);
  if (!accessRes.ok) {
    return accessRes;
  }

  replayItems.sort((a, b) => {
    const left = BigInt(a.envelope.device_sequence);
    const right = BigInt(b.envelope.device_sequence);
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return storageOk(replayItems);
}

export async function listSendableOperations(
  db: IDBDatabase,
  ctx: OwnerAccessContext
): Promise<StorageResult<readonly OperationEnvelope[]>> {
  const result = await listOutboxOperations(
    db,
    ctx,
    (status) =>
      status === "queued" ||
      status === "sending" ||
      status === "pending"
  );
  if (!result.ok) return result;
  return storageOk(result.value.map((item) => item.envelope));
}

export async function listOutboxForReplay(
  db: IDBDatabase,
  ctx: OwnerAccessContext
): Promise<StorageResult<readonly OutboxReplayItem[]>> {
  return listOutboxOperations(
    db,
    ctx,
    (status) =>
      status === "queued" ||
      status === "sending" ||
      status === "blocked" ||
      status === "ack_waiting_pull" ||
      status === "time_invalid" ||
      status === "pending"
  );
}

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

  if (!decRes.ok) {
    return decRes;
  }

  // Revalidate after decryption; a concurrent close or upgrade stays typed.
  const accessRes = await revalidateOwnerContext(db, ctx);
  if (!accessRes.ok) {
    return accessRes;
  }

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
          if (
            entry.status !== "queued" &&
            entry.status !== "sending" &&
            entry.status !== "pending"
          ) {
            customError = new StorageError(
              "invalid_data",
              `Invalid state transition for operation '${operationId}': cannot ACK from status '${entry.status}'`
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

export function confirmPulledOperationInTx(
  tx: IDBTransaction,
  ctx: OwnerAccessContext,
  operationId: string,
  expectedRequestHash: string,
  callbacks?: {
    onError?: (error: StorageError) => void;
  }
): void {
  const fail = (error: StorageError) => {
    callbacks?.onError?.(error);
    try {
      tx.abort();
    } catch {
      // The transaction may already be inactive; the owning flow will observe
      // its abort/error path.
    }
  };

  if (
    !ctx ||
    typeof ctx.ownerId !== "string" ||
    typeof ctx.keyId !== "string" ||
    typeof ctx.lockEpoch !== "number" ||
    !ctx.key
  ) {
    fail(
      new StorageError(
        "invalid_data",
        "confirmPulledOperationInTx requires a valid OwnerAccessContext"
      )
    );
    return;
  }

  if (
    typeof expectedRequestHash !== "string" ||
    !HASH_PATTERN.test(expectedRequestHash)
  ) {
    fail(
      new StorageError(
        "invalid_data",
        `expectedRequestHash must be a lowercase 64-hex SHA-256 hash: got '${expectedRequestHash}'`
      )
    );
    return;
  }

  if (typeof operationId !== "string" || operationId.length === 0) {
    fail(
      new StorageError(
        "invalid_data",
        "confirmPulledOperationInTx requires a non-empty operation ID"
      )
    );
    return;
  }

  let metaStore: IDBObjectStore;
  let opStore: IDBObjectStore;
  try {
    metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
    opStore = tx.objectStore(STORAGE_STORES.operations);
  } catch (err) {
    fail(
      new StorageError(
        "invalid_data",
        "confirmPulledOperationInTx requires a transaction covering owner_meta and operations",
        err
      )
    );
    return;
  }

  // Owner-gate validation happens inside the caller-owned transaction, before
  // the outbox mutation. A locked/stale/foreign context must never delete a row.
  const metaReq = metaStore.get(ctx.ownerId);
  metaReq.onsuccess = () => {
    const checkErr = checkOwnerMetaRecord(
      (metaReq.result as OwnerMetadata | undefined) ?? undefined,
      ctx
    );
    if (checkErr) {
      fail(checkErr);
      return;
    }

    const opReq = opStore.get([ctx.ownerId, operationId]);
    opReq.onsuccess = () => {
      const entry = opReq.result as OutboxEntry | undefined;
      if (!entry) {
        fail(
          new StorageError(
            "invalid_data",
            `Operation '${operationId}' not found in outbox`
          )
        );
        return;
      }
      if (entry.status !== "ack_waiting_pull") {
        fail(
          new StorageError(
            "invalid_data",
            `Invalid state transition for operation '${operationId}': cannot mark synced before ACK (current status: '${entry.status}')`
          )
        );
        return;
      }
      if (entry.request_hash !== expectedRequestHash) {
        fail(
          new StorageError(
            "integrity_failed",
            `Pull confirmation request_hash mismatch for operation '${operationId}': expected '${expectedRequestHash}', got '${entry.request_hash}'`
          )
        );
        return;
      }
      opStore.delete([ctx.ownerId, operationId]);
    };
    opReq.onerror = () => {
      fail(
        new StorageError(
          "unavailable",
          opReq.error?.message ?? "Failed to read outbox entry",
          opReq.error
        )
      );
    };
  };
  metaReq.onerror = () => {
    fail(
      new StorageError(
        "unavailable",
        metaReq.error?.message ?? "Failed to read owner metadata",
        metaReq.error
      )
    );
  };
}
