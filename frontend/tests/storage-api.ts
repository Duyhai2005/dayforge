import { StorageError, storageErr, storageOk } from "../lib/storage/errors";
import type { StorageResult } from "../lib/storage/errors";
import { STORAGE_STORES } from "../lib/storage/schema";
import { openDatabase, closeDatabase, type OpenDatabaseOptions } from "../lib/storage/db";
import { createLocalStorageGateway as createProductionGateway, type LocalStorageGateway } from "../lib/storage/repositories";
import { confirmPulledOperationInTx, getRecord, listOutboxForReplay, listSendableOperations, markOperationAcked } from "../lib/storage/repositories";
import { persistOperationAtomic, type PersistOperationInput, type PersistOperationResult } from "../lib/storage/unit-of-work";
import type { OwnerAccessContext } from "../lib/storage/owner-gate";

export * from "../lib/storage/errors";
export * from "../lib/storage/schema";
export * from "../lib/storage/migration";
export * from "../lib/storage/db";
export * from "../lib/storage/owner-gate";
export * from "../lib/storage/clock-state";
export * from "../lib/storage/outbox";
export * from "../lib/storage/view-preferences";
export * from "../lib/storage/migrations/auth-state-v2";
export { type EncryptedRecord, createAad, encryptPayload, decryptPayload, importRawKey, storeCryptoKey, getCryptoKey, removeCryptoKey } from "../lib/storage/crypto";
export { type ClockInputParams, type PersistOperationInput, type PersistOperationResult, type RecordOverlayInput, type DeviceMetadata } from "../lib/storage/unit-of-work";
export { confirmPulledOperationInTx, getRecord, listOutboxForReplay, listSendableOperations, markOperationAcked, persistOperationAtomic };
export type { LocalStorageGateway };

export async function generateTestKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

type TestHooks = { _abortForTest?: boolean; _simulateQuotaExceeded?: boolean };
type TestGateway = LocalStorageGateway & {
  listPending(ctx: OwnerAccessContext): ReturnType<LocalStorageGateway["listSendableOperations"]>;
  listPendingOperations(ctx: OwnerAccessContext): ReturnType<LocalStorageGateway["listSendableOperations"]>;
  markOperationSynced(ctx: OwnerAccessContext, operationId: string, expectedRequestHash: string): Promise<StorageResult<void>>;
  persistOperation(input: PersistOperationInput & TestHooks): Promise<StorageResult<PersistOperationResult>>;
};

export function createLocalStorageGateway(options?: OpenDatabaseOptions): TestGateway {
  const gateway = createProductionGateway(options);
  const productionPersistOperation = gateway.persistOperation.bind(gateway);
  return Object.assign(gateway, {
    listPending: gateway.listSendableOperations.bind(gateway),
    listPendingOperations: gateway.listSendableOperations.bind(gateway),
    async persistOperation(input: PersistOperationInput & TestHooks): Promise<StorageResult<PersistOperationResult>> {
      const { _abortForTest, _simulateQuotaExceeded, ...cleanInput } = input;
      if (!_abortForTest && !_simulateQuotaExceeded) return await productionPersistOperation(cleanInput);
      const opened = await openDatabase(options);
      if (!opened.ok) return { ok: false as const, error: opened.error };
      try {
        return await persistOperationAtomic(opened.value, cleanInput, {
          abort: _abortForTest,
          simulateQuotaExceeded: _simulateQuotaExceeded,
        });
      } finally {
        closeDatabase(opened.value);
      }
    },
    async markOperationSynced(ctx: OwnerAccessContext, operationId: string, expectedRequestHash: string): Promise<StorageResult<void>> {
      const opened = await openDatabase(options);
      if (!opened.ok) return { ok: false, error: opened.error };
      const db = opened.value;
      return await new Promise<StorageResult<void>>((resolve) => {
        let customError: StorageError | null = null;
        let settled = false;
        const finish = (result: StorageResult<void>) => {
          if (settled) return;
          settled = true;
          closeDatabase(db);
          resolve(result);
        };
        try {
          const tx = db.transaction([STORAGE_STORES.owner_meta, STORAGE_STORES.operations], "readwrite");
          confirmPulledOperationInTx(tx, ctx, operationId, expectedRequestHash, { onError: (error) => { customError = error; } });
          tx.oncomplete = () => finish(storageOk(undefined));
          tx.onerror = () => finish(storageErr(customError?.code ?? "unavailable", customError?.message ?? tx.error?.message ?? "Pull confirmation failed", customError ?? tx.error));
          tx.onabort = () => finish({ ok: false, error: customError ?? new StorageError("transaction_aborted", tx.error?.message ?? "Pull confirmation transaction aborted", tx.error) });
        } catch (error) {
          finish(storageErr("unavailable", error instanceof Error ? error.message : "Pull confirmation failed", error));
        }
      });
    },
  });
}
