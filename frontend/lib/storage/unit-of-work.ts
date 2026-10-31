import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";
import { type EncryptedRecord, encryptPayload } from "./crypto";
import { type OwnerAccessContext, type OwnerMetadata } from "./owner-gate";
import { type HlcEditTime, validateHlc } from "./clock-state";
import { type OperationEnvelope, type OutboxEntry, type OutboxStatus, canonicalizeJson, sha256Hex } from "./outbox";

export interface RecordOverlayInput {
  kind: string;
  id: string;
  payload: unknown;
}

export interface PersistOperationInput {
  context: OwnerAccessContext;
  deviceId: string;
  operationId: string;
  commands: readonly unknown[];
  dependencies: readonly string[];
  editTime: HlcEditTime;
  recordOverlays?: readonly RecordOverlayInput[];
  _abortForTest?: boolean;
  _simulateQuotaExceeded?: boolean;
}

export interface PersistOperationResult {
  operationId: string;
  deviceSequence: string;
  durability: "committed_to_indexeddb";
}

export interface DeviceMetadata {
  owner_id: string;
  device_id: string;
  last_sequence: string;
  last_hlc?: HlcEditTime;
  updated_at?: string;
}

export async function persistOperationAtomic(
  db: IDBDatabase,
  input: PersistOperationInput
): Promise<StorageResult<PersistOperationResult>> {
  if (!input.operationId || typeof input.operationId !== "string") {
    return storageErr("invalid_data", "Operation ID is required and must be a string");
  }

  if (!input.deviceId || typeof input.deviceId !== "string") {
    return storageErr("invalid_data", "Device ID is required and must be a string");
  }

  if (!validateHlc(input.editTime)) {
    return storageErr("invalid_data", "Invalid HLC edit time structure or values");
  }

  // Pre-encrypt record overlays before opening transaction
  const overlays = input.recordOverlays ?? [];
  const preEncryptedOverlays: {
    kind: string;
    id: string;
    encrypted: EncryptedRecord;
  }[] = [];

  for (const overlay of overlays) {
    const encRes = await encryptPayload(
      input.context.key,
      input.context.ownerId,
      input.context.keyId,
      STORAGE_STORES.records,
      `${overlay.kind}:${overlay.id}`,
      overlay.payload
    );
    if (!encRes.ok) {
      return encRes;
    }
    preEncryptedOverlays.push({
      kind: overlay.kind,
      id: overlay.id,
      encrypted: encRes.value,
    });
  }

  return new Promise((resolve) => {
    let resolved = false;
    let customError: StorageError | null = null;

    const safeResolve = (res: StorageResult<PersistOperationResult>) => {
      if (!resolved) {
        resolved = true;
        resolve(res);
      }
    };

    try {
      const tx = db.transaction(
        [
          STORAGE_STORES.owner_meta,
          STORAGE_STORES.device_meta,
          STORAGE_STORES.operations,
          STORAGE_STORES.records,
        ],
        "readwrite"
      );

      const ownerStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const devStore = tx.objectStore(STORAGE_STORES.device_meta);
      const opStore = tx.objectStore(STORAGE_STORES.operations);
      const recordsStore = tx.objectStore(STORAGE_STORES.records);

      let allocatedSequence = "1";

      // Keep transaction active during async crypto calculation
      let cryptoKeepAliveActive = true;
      const keepAlivePing = () => {
        if (!cryptoKeepAliveActive) return;
        try {
          const pingReq = ownerStore.get("__dayforge_keep_alive__");
          pingReq.onsuccess = () => {
            if (cryptoKeepAliveActive) keepAlivePing();
          };
          pingReq.onerror = () => {
            if (cryptoKeepAliveActive) keepAlivePing();
          };
        } catch {
          // Transaction could be committing or aborted
        }
      };

      // 1. Read owner metadata to validate access and lock epoch
      const ownerReq = ownerStore.get(input.context.ownerId);

      ownerReq.onsuccess = () => {
        const meta = ownerReq.result as OwnerMetadata | undefined;
        if (!meta) {
          customError = new StorageError(
            "locked",
            `Owner '${input.context.ownerId}' has not been initialized or unlocked`
          );
          tx.abort();
          return;
        }
        if (meta.locked) {
          customError = new StorageError(
            "locked",
            `Owner '${input.context.ownerId}' is currently locked`
          );
          tx.abort();
          return;
        }
        if (meta.lock_epoch !== input.context.lockEpoch) {
          customError = new StorageError(
            "locked",
            `Stale access context: current epoch is ${meta.lock_epoch}, context epoch is ${input.context.lockEpoch}`
          );
          tx.abort();
          return;
        }

        // 2. Check for duplicate operation_id
        const opCheckReq = opStore.get([input.context.ownerId, input.operationId]);

        opCheckReq.onsuccess = () => {
          if (opCheckReq.result) {
            customError = new StorageError(
              "invalid_data",
              `Duplicate operation ID: '${input.operationId}' already exists in outbox`
            );
            tx.abort();
            return;
          }

          // 3. Read device sequence
          const devReq = devStore.get([input.context.ownerId, input.deviceId]);

          devReq.onsuccess = async () => {
            const devMeta = devReq.result as DeviceMetadata | undefined;
            if (devMeta && devMeta.last_sequence) {
              try {
                const currentSeq = BigInt(devMeta.last_sequence);
                allocatedSequence = (currentSeq + BigInt(1)).toString();
              } catch {
                allocatedSequence = "1";
              }
            } else {
              allocatedSequence = "1";
            }

            // Construct operation envelope
            const envelope: OperationEnvelope = {
              protocol_version: 1,
              reducer_version: 1,
              operation_id: input.operationId,
              owner_id: input.context.ownerId,
              device_id: input.deviceId,
              device_sequence: allocatedSequence,
              edit_time: input.editTime,
              dependencies: input.dependencies,
              commands: input.commands,
            };

            // Start keepalive for async crypto
            keepAlivePing();

            try {
              const canonicalJson = canonicalizeJson(envelope);
              const hashHex = await sha256Hex(canonicalJson);
              const encRes = await encryptPayload(
                input.context.key,
                input.context.ownerId,
                input.context.keyId,
                STORAGE_STORES.operations,
                input.operationId,
                envelope
              );

              cryptoKeepAliveActive = false;

              if (!encRes.ok) {
                customError = encRes.error;
                tx.abort();
                return;
              }

              // Determine outbox entry status (untrusted clock quality -> 'time_invalid')
              const status: OutboxStatus =
                input.editTime.quality === "untrusted"
                  ? "time_invalid"
                  : "pending";

              const outboxEntry: OutboxEntry = {
                owner_id: input.context.ownerId,
                operation_id: input.operationId,
                device_sequence: allocatedSequence,
                status,
                request_hash: hashHex,
                encrypted_envelope: encRes.value,
                created_at: new Date().toISOString(),
              };

              if (input._simulateQuotaExceeded) {
                customError = new StorageError(
                  "quota_exceeded",
                  "Storage quota exceeded"
                );
                tx.abort();
                return;
              }

              const opReq = opStore.put(outboxEntry);
              opReq.onerror = () => {
                if (opReq.error?.name === "QuotaExceededError") {
                  customError = new StorageError(
                    "quota_exceeded",
                    opReq.error.message,
                    opReq.error
                  );
                }
              };

              // Put record overlays
              for (const item of preEncryptedOverlays) {
                const recReq = recordsStore.put({
                  owner_id: input.context.ownerId,
                  kind: item.kind,
                  id: item.id,
                  key_id: item.encrypted.key_id,
                  store: STORAGE_STORES.records,
                  record_id: `${item.kind}:${item.id}`,
                  iv: item.encrypted.iv,
                  ciphertext: item.encrypted.ciphertext,
                });
                recReq.onerror = () => {
                  if (recReq.error?.name === "QuotaExceededError") {
                    customError = new StorageError(
                      "quota_exceeded",
                      recReq.error.message,
                      recReq.error
                    );
                  }
                };
              }

              // Update device_meta with new sequence and HLC
              const updatedDevMeta: DeviceMetadata = {
                owner_id: input.context.ownerId,
                device_id: input.deviceId,
                last_sequence: allocatedSequence,
                last_hlc: input.editTime,
                updated_at: new Date().toISOString(),
              };
              const devPutReq = devStore.put(updatedDevMeta);
              devPutReq.onerror = () => {
                if (devPutReq.error?.name === "QuotaExceededError") {
                  customError = new StorageError(
                    "quota_exceeded",
                    devPutReq.error.message,
                    devPutReq.error
                  );
                }
              };

              if (input._abortForTest) {
                customError = new StorageError(
                  "transaction_aborted",
                  "Transaction aborted for test"
                );
                tx.abort();
              }
            } catch (err) {
              cryptoKeepAliveActive = false;
              if (
                (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "QuotaExceededError") ||
                (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "QuotaExceededError")
              ) {
                customError = new StorageError(
                  "quota_exceeded",
                  err instanceof Error ? err.message : "Storage quota exceeded",
                  err
                );
              } else {
                customError =
                  err instanceof StorageError
                    ? err
                    : new StorageError(
                        "transaction_aborted",
                        err instanceof Error ? err.message : "Error during atomic persist",
                        err
                      );
              }
              try {
                tx.abort();
              } catch {
                // Ignore abort error if already aborting
              }
            }
          };

          devReq.onerror = () => {
            customError = new StorageError(
              "transaction_aborted",
              devReq.error?.message ?? "Failed to read device metadata",
              devReq.error
            );
          };
        };

        opCheckReq.onerror = () => {
          customError = new StorageError(
            "transaction_aborted",
            opCheckReq.error?.message ?? "Failed to check existing operation",
            opCheckReq.error
          );
        };
      };

      ownerReq.onerror = () => {
        customError = new StorageError(
          "transaction_aborted",
          ownerReq.error?.message ?? "Failed to read owner metadata",
          ownerReq.error
        );
      };

      tx.oncomplete = () => {
        cryptoKeepAliveActive = false;
        safeResolve(
          storageOk({
            operationId: input.operationId,
            deviceSequence: allocatedSequence,
            durability: "committed_to_indexeddb",
          })
        );
      };

      tx.onerror = () => {
        cryptoKeepAliveActive = false;
        if (customError) {
          safeResolve({ ok: false, error: customError });
        } else if (tx.error?.name === "QuotaExceededError") {
          safeResolve(
            storageErr(
              "quota_exceeded",
              tx.error?.message ?? "Storage quota exceeded",
              tx.error
            )
          );
        } else {
          safeResolve(
            storageErr(
              "transaction_aborted",
              tx.error?.message ?? "Transaction aborted while persisting operation",
              tx.error
            )
          );
        }
      };

      tx.onabort = () => {
        cryptoKeepAliveActive = false;
        if (customError) {
          safeResolve({ ok: false, error: customError });
        } else if (tx.error?.name === "QuotaExceededError") {
          safeResolve(
            storageErr(
              "quota_exceeded",
              tx.error?.message ?? "Storage quota exceeded",
              tx.error
            )
          );
        } else {
          safeResolve(
            storageErr(
              "transaction_aborted",
              tx.error?.message ?? "Transaction aborted while persisting operation",
              tx.error
            )
          );
        }
      };
    } catch (err) {
      if (
        (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "QuotaExceededError") ||
        (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "QuotaExceededError")
      ) {
        safeResolve(
          storageErr(
            "quota_exceeded",
            err instanceof Error ? err.message : "Storage quota exceeded initiating persist transaction",
            err
          )
        );
      } else {
        safeResolve(
          storageErr(
            "unavailable",
            err instanceof Error ? err.message : "Error initiating persist transaction",
            err
          )
        );
      }
    }
  });
}
