import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import {
  type OwnerAccessContext,
  type OwnerMetadata,
  checkOwnerMetaRecord,
} from "./owner-gate";
import { STORAGE_STORES } from "./schema";

export async function revalidateOwnerContext(
  db: IDBDatabase,
  ctx: OwnerAccessContext
): Promise<StorageResult<void>> {
  return await new Promise((resolve) => {
    let meta: OwnerMetadata | undefined;
    let accessError: StorageError | null = null;
    try {
      const tx = db.transaction(STORAGE_STORES.owner_meta, "readonly");
      const req = tx.objectStore(STORAGE_STORES.owner_meta).get(ctx.ownerId);
      req.onsuccess = () => {
        meta = (req.result as OwnerMetadata | undefined) ?? undefined;
        accessError = checkOwnerMetaRecord(meta, ctx);
      };
      req.onerror = () => {
        accessError = new StorageError(
          "unavailable",
          req.error?.message ?? "Failed to revalidate owner access after decryption",
          req.error
        );
      };
      tx.oncomplete = () => {
        resolve(accessError ? { ok: false, error: accessError } : storageOk(undefined));
      };
      tx.onerror = () => {
        resolve(storageErr("unavailable", tx.error?.message ?? "Owner access validation transaction failed", tx.error));
      };
      tx.onabort = () => {
        resolve(storageErr("transaction_aborted", tx.error?.message ?? "Owner access validation transaction aborted", tx.error));
      };
    } catch (err) {
      resolve(storageErr(
        "unavailable",
        err instanceof Error ? err.message : "Database closed while revalidating owner access",
        err
      ));
    }
  });
}
