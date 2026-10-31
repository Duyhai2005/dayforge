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
  legacySample: LegacyEncryptedSample | null;
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

async function readUnlockSnapshot(
  db: IDBDatabase,
  ownerId: string,
  incomingKeyId: string
): Promise<StorageResult<UnlockSnapshot>> {
  return new Promise((resolve) => {
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

      let hasExistingData = false;
      let legacySample: LegacyEncryptedSample | null = null;

      // Scan records
      const recRange = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
      const recReq = recStore.openCursor(recRange);
      recReq.onsuccess = () => {
        const cursor = recReq.result;
        if (cursor) {
          hasExistingData = true;
          if (!legacySample) {
            const row = cursor.value;
            const iv = toUint8Array(row?.iv);
            const ct = toUint8Array(row?.ciphertext);
            if (row && row.kind && row.id && iv && ct) {
              legacySample = {
                store: STORAGE_STORES.records,
                recordId: `${row.kind}:${row.id}`,
                encRecord: {
                  owner_id: ownerId,
                  store: STORAGE_STORES.records,
                  record_id: `${row.kind}:${row.id}`,
                  key_id: row.key_id ?? incomingKeyId,
                  iv,
                  ciphertext: ct,
                },
              };
            }
          }
        }
      };

      // Scan operations
      const opRange = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
      const opReq = opStore.openCursor(opRange);
      opReq.onsuccess = () => {
        const cursor = opReq.result;
        if (cursor) {
          hasExistingData = true;
          if (!legacySample) {
            const row = cursor.value;
            const env = row?.encrypted_envelope;
            const iv = toUint8Array(env?.iv ?? row?.iv);
            const ct = toUint8Array(env?.ciphertext ?? row?.ciphertext);
            if (row && row.operation_id && iv && ct) {
              legacySample = {
                store: STORAGE_STORES.operations,
                recordId: row.operation_id,
                encRecord: {
                  owner_id: ownerId,
                  store: STORAGE_STORES.operations,
                  record_id: row.operation_id,
                  key_id: env?.key_id ?? row?.key_id ?? incomingKeyId,
                  iv,
                  ciphertext: ct,
                },
              };
            }
          }
        }
      };

      // Scan view_preferences
      const prefRange = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
      const prefReq = prefStore.openCursor(prefRange);
      prefReq.onsuccess = () => {
        const cursor = prefReq.result;
        if (cursor) {
          hasExistingData = true;
          if (!legacySample) {
            const row = cursor.value;
            const iv = toUint8Array(row?.iv);
            const ct = toUint8Array(row?.ciphertext);
            if (row && row.calendar && iv && ct) {
              legacySample = {
                store: STORAGE_STORES.view_preferences,
                recordId: row.calendar,
                encRecord: {
                  owner_id: ownerId,
                  store: STORAGE_STORES.view_preferences,
                  record_id: row.calendar,
                  key_id: row.key_id ?? incomingKeyId,
                  iv,
                  ciphertext: ct,
                },
              };
            }
          }
        }
      };

      // Scan drafts
      const draftRange = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
      const draftReq = draftStore.openCursor(draftRange);
      draftReq.onsuccess = () => {
        const cursor = draftReq.result;
        if (cursor) {
          hasExistingData = true;
          if (!legacySample) {
            const row = cursor.value;
            const iv = toUint8Array(row?.iv);
            const ct = toUint8Array(row?.ciphertext);
            if (row && row.draft_id && iv && ct) {
              legacySample = {
                store: STORAGE_STORES.drafts,
                recordId: row.draft_id,
                encRecord: {
                  owner_id: ownerId,
                  store: STORAGE_STORES.drafts,
                  record_id: row.draft_id,
                  key_id: row.key_id ?? incomingKeyId,
                  iv,
                  ciphertext: ct,
                },
              };
            }
          }
        }
      };

      // Scan sync_meta excluding sentinel
      const syncRange = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
      const syncCursorReq = syncStore.openCursor(syncRange);
      syncCursorReq.onsuccess = () => {
        const cursor = syncCursorReq.result;
        if (cursor) {
          const row = cursor.value;
          if (row && row.key !== OWNER_KEY_SENTINEL_RECORD_ID) {
            hasExistingData = true;
            if (!legacySample) {
              const iv = toUint8Array(row?.iv);
              const ct = toUint8Array(row?.ciphertext);
              if (iv && ct) {
                legacySample = {
                  store: STORAGE_STORES.sync_meta,
                  recordId: row.key,
                  encRecord: {
                    owner_id: ownerId,
                    store: STORAGE_STORES.sync_meta,
                    record_id: row.key,
                    key_id: row.key_id ?? incomingKeyId,
                    iv,
                    ciphertext: ct,
                  },
                };
              }
            }
          } else {
            cursor.continue();
          }
        }
      };

      tx.oncomplete = () => {
        resolve(
          storageOk({
            meta: (metaReq.result as OwnerMetadata) ?? null,
            sentinel: (sentinelReq.result as SentinelSyncMetaRow) ?? null,
            hasExistingData,
            legacySample,
          })
        );
      };

      tx.onerror = () => {
        resolve(
          storageErr(
            "unavailable",
            tx.error?.message ?? "Failed to read owner snapshot for unlock",
            tx.error
          )
        );
      };

      tx.onabort = () => {
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
      // Sentinel exists: verify key continuity by authenticating and decrypting sentinel
      const sentinelIv = toUint8Array(snap.sentinel.iv);
      const sentinelCiphertext = toUint8Array(snap.sentinel.ciphertext);
      if (!sentinelIv || !sentinelCiphertext) {
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
          key_id: snap.sentinel.key_id ?? keyId,
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
      // Sentinel missing but legacy data exists: verify key against legacy sample
      if (!snap.legacySample) {
        return storageErr(
          "integrity_failed",
          `Key sentinel missing for owner '${ownerId}' with existing data; key continuity cannot be verified`
        );
      }

      const sample = snap.legacySample;
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
          `Key continuity check failed for owner '${ownerId}' with legacy data: provided key cannot authenticate existing data in store '${sample.store}'`
        );
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

        const metaReq = metaStore.get(ownerId);
        const syncReq = syncStore.get([ownerId, OWNER_KEY_SENTINEL_RECORD_ID]);

        let metaDone = false;
        let syncDone = false;
        let currentMeta: OwnerMetadata | null = null;
        let currentSentinel: SentinelSyncMetaRow | null = null;

        const checkAndCommit = () => {
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
