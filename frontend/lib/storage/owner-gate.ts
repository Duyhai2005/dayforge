import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";
import { encryptPayload, decryptPayload, type EncryptedRecord } from "./crypto";

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
  iv: Uint8Array | string;
  ciphertext: Uint8Array | string;
  created_at?: string;
}

export interface UnlockOwnerOptions {
  afterPhase1Barrier?: () => Promise<void>;
}

interface LegacyEncryptedSample {
  store: string;
  recordId: string;
  encRecord: EncryptedRecord;
}

interface UnlockSnapshot {
  meta: OwnerMetadata | null;
  sentinel: SentinelSyncMetaRow | null;
  hasExistingData: boolean;
  legacySamples: LegacyEncryptedSample[];
  legacyInventoryErrors: string[];
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

function toUint8Array(val: unknown): Uint8Array | null {
  if (!val) return null;
  if (val instanceof Uint8Array) return val;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (ArrayBuffer.isView(val)) {
    return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  }
  if (typeof val === "string") {
    if (/^[0-9a-fA-F]+$/.test(val) && val.length % 2 === 0) {
      const match = val.match(/.{1,2}/g);
      if (match) {
        return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
      }
    }
    return new TextEncoder().encode(val);
  }
  return null;
}

function sameBinaryOrString(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  const ua = toUint8Array(a);
  const ub = toUint8Array(b);
  if (!ua || !ub) return false;
  if (ua.byteLength !== ub.byteLength) return false;
  for (let i = 0; i < ua.byteLength; i++) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

function sameSentinel(
  a: SentinelSyncMetaRow | null | undefined,
  b: SentinelSyncMetaRow | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.owner_id !== b.owner_id) return false;
  if (a.key !== b.key) return false;
  if (a.key_id !== b.key_id) return false;
  if (!sameBinaryOrString(a.iv, b.iv)) return false;
  if (!sameBinaryOrString(a.ciphertext, b.ciphertext)) return false;
  return true;
}

function sameOwnerMeta(
  a: OwnerMetadata | null | undefined,
  b: OwnerMetadata | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.owner_id === b.owner_id &&
    a.lock_epoch === b.lock_epoch &&
    a.locked === b.locked &&
    a.active_key_id === b.active_key_id
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function collectLegacySample(
  ownerId: string,
  incomingKeyId: string,
  store: string,
  recordId: string,
  row: Record<string, unknown>
): { sample?: LegacyEncryptedSample; error?: string } {
  const label = `${store}/${recordId}`;
  if (row.owner_id !== ownerId) {
    return {
      error: `legacy encrypted row '${label}' belongs to owner '${String(
        row.owner_id
      )}' instead of '${ownerId}'`,
    };
  }
  if (row.key_id !== incomingKeyId) {
    return {
      error: `legacy encrypted row '${label}' uses key ID '${String(
        row.key_id
      )}' instead of '${incomingKeyId}'`,
    };
  }
  const iv = toUint8Array(row.iv);
  if (!iv || iv.byteLength === 0) {
    return { error: `legacy encrypted row '${label}' has a missing or empty IV` };
  }
  const ciphertext = toUint8Array(row.ciphertext);
  if (!ciphertext || ciphertext.byteLength < 16) {
    return {
      error: `legacy encrypted row '${label}' has missing or invalid AES-GCM ciphertext`,
    };
  }
  return {
    sample: {
      store,
      recordId,
      encRecord: {
        owner_id: ownerId,
        store,
        record_id: recordId,
        key_id: incomingKeyId,
        iv,
        ciphertext,
      },
    },
  };
}

interface LegacyExtraction {
  skip?: boolean;
  recordId?: string;
  parts?: Record<string, unknown>;
  error?: string;
}


/**
 * Parse an owner-scoped encrypted row using its IndexedDB storage key, never
 * trusting row-supplied AAD metadata as the source of the record identity.
 * Shared between the legacy snapshot and its commit-time CAS validation.
 */
function extractLegacyRow(
  storeName: string,
  raw: unknown,
  ownerId: string,
  incomingKeyId: string
): { skip?: boolean; sample?: LegacyEncryptedSample; error?: string } {
  const row = asRecord(raw);
  if (!row) {
    return { error: storeName + " store contains a non-object legacy row" };
  }

  let recordId: string | null = null;
  let parts = row;
  if (storeName === STORAGE_STORES.records) {
    if (typeof row.kind === "string" && row.kind.length > 0 &&
        typeof row.id === "string" && row.id.length > 0) {
      recordId = row.kind + ":" + row.id;
    }
  } else if (storeName === STORAGE_STORES.operations) {
    if (typeof row.operation_id === "string" && row.operation_id.length > 0) {
      recordId = row.operation_id;
      const envelope = asRecord(row.encrypted_envelope);
      if (!envelope ||
          envelope.owner_id !== ownerId ||
          envelope.store !== storeName ||
          envelope.record_id !== recordId) {
        return { error: "operations/" + recordId + " encrypted envelope context mismatch" };
      }
      parts = envelope;
    }
  } else if (storeName === STORAGE_STORES.view_preferences) {
    if (typeof row.calendar === "string" && row.calendar.length > 0) {
      recordId = row.calendar;
    }
  } else if (storeName === STORAGE_STORES.drafts) {
    if (typeof row.draft_id === "string" && row.draft_id.length > 0) {
      recordId = row.draft_id;
    }
  } else if (storeName === STORAGE_STORES.sync_meta) {
    if (row.key === OWNER_KEY_SENTINEL_RECORD_ID) return { skip: true };
    if (typeof row.key === "string" && row.key.length > 0) {
      recordId = row.key;
    }
  }

  if (!recordId) {
    return { error: storeName + " store contains an encrypted row without a valid record ID" };
  }
  return collectLegacySample(ownerId, incomingKeyId, storeName, recordId, parts);
}

async function readUnlockSnapshot(
  db: IDBDatabase,
  ownerId: string,
  incomingKeyId: string
): Promise<StorageResult<UnlockSnapshot>> {
  return new Promise((resolve) => {
    let customError: StorageError | null = null;
    try {
      const tx = db.transaction(
        [
          STORAGE_STORES.owner_meta,
          STORAGE_STORES.sync_meta,
          STORAGE_STORES.records,
          STORAGE_STORES.operations,
          STORAGE_STORES.view_preferences,
          STORAGE_STORES.drafts,
        ],
        "readonly"
      );

      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const syncStore = tx.objectStore(STORAGE_STORES.sync_meta);
      const recStore = tx.objectStore(STORAGE_STORES.records);
      const opStore = tx.objectStore(STORAGE_STORES.operations);
      const prefStore = tx.objectStore(STORAGE_STORES.view_preferences);
      const draftStore = tx.objectStore(STORAGE_STORES.drafts);

      const metaReq = metaStore.get(ownerId);
      const sentinelReq = syncStore.get([ownerId, OWNER_KEY_SENTINEL_RECORD_ID]);

      let meta: OwnerMetadata | null = null;
      let sentinel: SentinelSyncMetaRow | null = null;
      let hasExistingData = false;
      const legacySamples: LegacyEncryptedSample[] = [];
      const legacyInventoryErrors: string[] = [];

      const addSample = (
        storeName: string,
        recordId: string,
        parts: Record<string, unknown>
      ) => {
        const collected = collectLegacySample(
          ownerId,
          incomingKeyId,
          storeName,
          recordId,
          parts
        );
        if (collected.sample) {
          legacySamples.push(collected.sample);
        } else if (collected.error) {
          legacyInventoryErrors.push(collected.error);
        }
      };


      // Cursor iteration avoids materializing a second getAll() array per store.
      // The authenticated inventory itself is retained for the CAS comparison.
      const scanStore = (store: IDBObjectStore, storeName: string) => {
        const range = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
        const req = store.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const extracted = extractLegacyRow(
            storeName, cursor.value, ownerId, incomingKeyId
          );
          if (!extracted.skip) {
            hasExistingData = true;
            if (extracted.sample) {
              legacySamples.push(extracted.sample);
            } else {
              legacyInventoryErrors.push(
                extracted.error ?? (storeName + " contains an invalid encrypted row")
              );
            }
          }
          cursor.continue();
        };
        req.onerror = () => {
          if (!customError) {
            customError = new StorageError(
              "unavailable",
              req.error?.message ?? ("Failed to scan " + storeName + " for legacy data"),
              req.error
            );
          }
          tx.abort();
        };
      };

      const scanLegacyInventory = () => {
        scanStore(recStore, STORAGE_STORES.records);
        scanStore(opStore, STORAGE_STORES.operations);
        scanStore(prefStore, STORAGE_STORES.view_preferences);
        scanStore(draftStore, STORAGE_STORES.drafts);
        scanStore(syncStore, STORAGE_STORES.sync_meta);
      };

      metaReq.onsuccess = () => {
        meta = (metaReq.result as OwnerMetadata) ?? null;
      };
      metaReq.onerror = () => {
        if (!customError) {
          customError = new StorageError(
            "unavailable",
            metaReq.error?.message ?? "Failed to read owner metadata",
            metaReq.error
          );
        }
        tx.abort();
      };

      sentinelReq.onsuccess = () => {
        sentinel = (sentinelReq.result as SentinelSyncMetaRow) ?? null;
        if (!sentinel) {
          scanLegacyInventory();
        }
      };
      sentinelReq.onerror = () => {
        if (!customError) {
          customError = new StorageError(
            "unavailable",
            sentinelReq.error?.message ?? "Failed to read owner key sentinel",
            sentinelReq.error
          );
        }
        tx.abort();
      };

      tx.oncomplete = () => {
        resolve(
          storageOk({
            meta,
            sentinel,
            hasExistingData,
            legacySamples,
            legacyInventoryErrors,
          })
        );
      };

      tx.onerror = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
          return;
        }
        resolve(
          storageErr(
            "unavailable",
            tx.error?.message ?? "Failed to read owner snapshot for unlock",
            tx.error
          )
        );
      };

      tx.onabort = () => {
        if (customError) {
          resolve(
            storageErr(customError.code, customError.message, customError.cause)
          );
          return;
        }
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while reading owner snapshot",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error executing snapshot read transaction",
          err
        )
      );
    }
  });
}

const MAX_UNLOCK_ATTEMPTS = 3;

export async function unlockOwner(
  db: IDBDatabase,
  ownerId: string,
  keyId: string,
  key: CryptoKey,
  _optionsForTest?: UnlockOwnerOptions
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

  for (let attempt = 0; attempt < MAX_UNLOCK_ATTEMPTS; attempt++) {
    // Phase 1: Read existing state snapshot
    const snapRes = await readUnlockSnapshot(db, ownerId, keyId);
    if (!snapRes.ok) {
      return snapRes;
    }
    const snap = snapRes.value;

    if (_optionsForTest?.afterPhase1Barrier) {
      await _optionsForTest.afterPhase1Barrier();
    }

    // Phase 2: Metadata validation & Key continuity verification
    if (snap.meta) {
      if (!snap.meta.locked) {
        if (!snap.meta.active_key_id) {
          return storageErr(
            "invalid_data",
            `Unlocked owner '${ownerId}' is missing active_key_id; lock and re-unlock required`
          );
        }
        if (snap.meta.active_key_id !== keyId) {
          return storageErr(
            "invalid_data",
            `Cannot switch active key from '${snap.meta.active_key_id}' to '${keyId}' while owner is unlocked`
          );
        }
      } else {
        if (snap.meta.active_key_id && snap.meta.active_key_id !== keyId) {
          return storageErr(
            "invalid_data",
            `Cannot unlock owner with key '${keyId}'; expected stable key '${snap.meta.active_key_id}'`
          );
        }
      }
    }

    let newSentinelRecord: SentinelSyncMetaRow | null = null;

    if (snap.sentinel) {
      // Sentinel exists: verify key continuity by authenticating and decrypting sentinel.
      // Malformed persisted metadata must fail closed; never substitute the caller's key ID.
      if (
        snap.sentinel.owner_id !== ownerId ||
        snap.sentinel.key !== OWNER_KEY_SENTINEL_RECORD_ID
      ) {
        return storageErr(
          "integrity_failed",
          `Key continuity sentinel row context is invalid for owner '${ownerId}'`
        );
      }
      if (
        typeof snap.sentinel.key_id !== "string" ||
        snap.sentinel.key_id.length === 0
      ) {
        return storageErr(
          "integrity_failed",
          `Key continuity sentinel is missing its key ID for owner '${ownerId}'`
        );
      }
      if (snap.sentinel.key_id !== keyId) {
        return storageErr(
          "integrity_failed",
          `Key continuity sentinel uses key ID '${snap.sentinel.key_id}' instead of '${keyId}' for owner '${ownerId}'`
        );
      }

      const sentinelIv = toUint8Array(snap.sentinel.iv);
      const sentinelCiphertext = toUint8Array(snap.sentinel.ciphertext);
      if (
        !sentinelIv ||
        sentinelIv.byteLength === 0 ||
        !sentinelCiphertext ||
        sentinelCiphertext.byteLength < 16
      ) {
        return storageErr(
          "integrity_failed",
          `Key continuity sentinel payload corrupted for owner '${ownerId}'`
        );
      }

      const decRes = await decryptPayload<SentinelPayload>(
        key,
        {
          owner_id: ownerId,
          store: STORAGE_STORES.sync_meta,
          record_id: OWNER_KEY_SENTINEL_RECORD_ID,
          key_id: snap.sentinel.key_id,
          iv: sentinelIv,
          ciphertext: sentinelCiphertext,
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
        payload.format_version !== 1 ||
        payload.owner_id !== ownerId ||
        payload.key_id !== keyId
      ) {
        return storageErr(
          "integrity_failed",
          `Key continuity sentinel payload corrupted for owner '${ownerId}'`
        );
      }
    } else if (snap.hasExistingData) {
      // Sentinel missing but legacy data exists: verify the incoming key against the
      // owner's entire encrypted inventory before installing a sentinel. A single
      // sample is not proof that the whole dataset is readable with this key.
      if (snap.legacyInventoryErrors.length > 0) {
        return storageErr(
          "integrity_failed",
          `Legacy encrypted inventory for owner '${ownerId}' is incomplete or malformed: ${snap.legacyInventoryErrors[0]}`
        );
      }
      if (snap.legacySamples.length === 0) {
        return storageErr(
          "integrity_failed",
          `Legacy data exists for owner '${ownerId}' but no authenticated ciphertext could be inventoried`
        );
      }

      for (const sample of snap.legacySamples) {
        const decRes = await decryptPayload(
          key,
          sample.encRecord,
          ownerId,
          sample.store,
          sample.recordId
        );

        if (!decRes.ok) {
          return storageErr(
            "integrity_failed",
            `Key continuity check failed for owner '${ownerId}' with legacy data: provided key cannot authenticate existing data in store '${sample.store}' record '${sample.recordId}'`
          );
        }
      }

      // Legacy key verified! Backfill sentinel
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
    } else {
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

    // Phase 3: Write Transaction (Atomic Commit with CAS)
    interface Phase3Outcome {
      conflict: boolean;
      context?: OwnerAccessContext;
      error?: StorageError;
    }

    const phase3Outcome = await new Promise<Phase3Outcome>((resolve) => {
      let isConflict = false;
      let customError: StorageError | null = null;
      let contextResult: OwnerAccessContext | null = null;

      try {
        const tx = db.transaction(
          newSentinelRecord
            ? [
                STORAGE_STORES.owner_meta,
                STORAGE_STORES.crypto_keys,
                STORAGE_STORES.sync_meta,
                STORAGE_STORES.records,
                STORAGE_STORES.operations,
                STORAGE_STORES.view_preferences,
                STORAGE_STORES.drafts,
              ]
            : [
                STORAGE_STORES.owner_meta,
                STORAGE_STORES.crypto_keys,
                STORAGE_STORES.sync_meta,
              ],
          "readwrite"
        );
        const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
        const cryptoStore = tx.objectStore(STORAGE_STORES.crypto_keys);
        const syncStore = tx.objectStore(STORAGE_STORES.sync_meta);

        const metaReq = metaStore.get(ownerId);
        const syncReq = syncStore.get([ownerId, OWNER_KEY_SENTINEL_RECORD_ID]);

        let metaDone = false;
        let syncDone = false;
        // A new sentinel must be committed only if *all* ciphertext verified
        // in Phase 1 is still exactly the ciphertext present at commit time.
        let inventoryDone = newSentinelRecord === null;
        let inventoryMatches = true;
        let currentMeta: OwnerMetadata | null = null;
        let currentSentinel: SentinelSyncMetaRow | null = null;

        const checkAndCommit = () => {
          if (!metaDone || !syncDone || !inventoryDone) return;
          if (!inventoryMatches) {
            isConflict = true;
            tx.abort();
            return;
          }
          // Detect concurrent lockOwner
          if (
            currentMeta?.locked &&
            (!snap.meta || !snap.meta.locked || currentMeta.lock_epoch !== snap.meta.lock_epoch)
          ) {
            customError = new StorageError(
              "locked",
              `Owner '${ownerId}' was locked concurrently during unlock (lock epoch changed to ${currentMeta.lock_epoch})`
            );
            tx.abort();
            return;
          }

          // Compare against Phase 1 snapshot
          if (
            !sameOwnerMeta(currentMeta, snap.meta) ||
            !sameSentinel(currentSentinel, snap.sentinel)
          ) {
            isConflict = true;
            tx.abort();
            return;
          }

          const currentEpoch = currentMeta?.lock_epoch ?? 0;
          // Installing a sentinel over a pre-existing owner state is a generation
          // change: invalidate every context created before the sentinel existed.
          const requiresGenerationChange =
            newSentinelRecord !== null &&
            (snap.hasExistingData || snap.meta !== null);
          const epoch = requiresGenerationChange
            ? Math.max(1, currentEpoch + 1)
            : currentEpoch > 0
              ? currentEpoch
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


        if (newSentinelRecord) {
          // All five owner ciphertext stores are included in this readwrite
          // transaction. Existing writers finish before our scan; new writers
          // are blocked until the epoch bump/sentinel has committed.
          const expected = new Map<string, LegacyEncryptedSample>();
          for (const sample of snap.legacySamples) {
            expected.set(sample.store + "\u0000" + sample.recordId, sample);
          }
          const seen = new Set<string>();
          const stores = [
            STORAGE_STORES.records,
            STORAGE_STORES.operations,
            STORAGE_STORES.view_preferences,
            STORAGE_STORES.drafts,
            STORAGE_STORES.sync_meta,
          ] as const;
          let remaining = stores.length;
          const markConflict = () => {
            inventoryMatches = false;
            isConflict = true;
            tx.abort();
          };

          for (const storeName of stores) {
            const range = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
            const req = tx.objectStore(storeName).openCursor(range);
            req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor) {
                remaining--;
                if (remaining === 0) {
                  inventoryDone = seen.size === expected.size;
                  if (!inventoryDone) {
                    markConflict();
                    return;
                  }
                  checkAndCommit();
                }
                return;
              }
              const extracted = extractLegacyRow(
                storeName, cursor.value, ownerId, keyId
              );
              if (!extracted.skip) {
                const actual = extracted.sample;
                const itemKey = actual
                  ? actual.store + "\u0000" + actual.recordId
                  : "";
                const original = expected.get(itemKey);
                if (
                  extracted.error || !actual || !original ||
                  seen.has(itemKey) ||
                  actual.encRecord.owner_id !== original.encRecord.owner_id ||
                  actual.encRecord.key_id !== original.encRecord.key_id ||
                  !sameBinaryOrString(actual.encRecord.iv, original.encRecord.iv) ||
                  !sameBinaryOrString(
                    actual.encRecord.ciphertext,
                    original.encRecord.ciphertext
                  )
                ) {
                  markConflict();
                  return;
                }
                seen.add(itemKey);
              }
              cursor.continue();
            };
            req.onerror = () => {
              customError = new StorageError(
                "transaction_aborted",
                req.error?.message ?? ("Failed to recheck " + storeName + " during unlock"),
                req.error
              );
              tx.abort();
            };
          }
        }

        metaReq.onsuccess = () => {
          currentMeta = (metaReq.result as OwnerMetadata) ?? null;
          metaDone = true;
          if (syncDone) checkAndCommit();
        };
        metaReq.onerror = () => {
          customError = new StorageError(
            "unavailable",
            metaReq.error?.message ?? "Failed to read owner metadata for unlock commit",
            metaReq.error
          );
        };

        syncReq.onsuccess = () => {
          currentSentinel = (syncReq.result as SentinelSyncMetaRow) ?? null;
          syncDone = true;
          if (metaDone) checkAndCommit();
        };
        syncReq.onerror = () => {
          customError = new StorageError(
            "unavailable",
            syncReq.error?.message ?? "Failed to read sentinel for unlock commit",
            syncReq.error
          );
        };

        tx.oncomplete = () => {
          if (!contextResult) {
            resolve({
              conflict: false,
              error: new StorageError(
                "transaction_aborted",
                "Transaction completed without establishing owner access context"
              ),
            });
            return;
          }
          resolve({ conflict: false, context: contextResult });
        };

        tx.onabort = () => {
          if (customError) {
            resolve({ conflict: false, error: customError });
            return;
          }
          if (isConflict) {
            resolve({ conflict: true });
            return;
          }
          resolve({
            conflict: false,
            error: new StorageError(
              "transaction_aborted",
              tx.error?.message ?? "Transaction aborted while unlocking owner",
              tx.error
            ),
          });
        };

        tx.onerror = () => {
          if (customError) {
            resolve({ conflict: false, error: customError });
            return;
          }
          if (isConflict) {
            resolve({ conflict: true });
            return;
          }
          resolve({
            conflict: false,
            error: new StorageError(
              "transaction_aborted",
              tx.error?.message ?? "Transaction error while unlocking owner",
              tx.error
            ),
          });
        };
      } catch (err) {
        resolve({
          conflict: false,
          error: new StorageError(
            "unavailable",
            err instanceof Error ? err.message : "Error executing unlock write transaction",
            err
          ),
        });
      }
    });

    if (phase3Outcome.conflict) {
      continue;
    }
    if (phase3Outcome.error) {
      return { ok: false, error: phase3Outcome.error };
    }
    return storageOk(phase3Outcome.context!);
  }

  return storageErr(
    "transaction_aborted",
    `Concurrent unlock state changed; maximum retries exceeded (${MAX_UNLOCK_ATTEMPTS})`
  );
}
