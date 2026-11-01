import { type StorageResult, storageErr, storageOk } from "./errors";
import { listOutboxForReplay } from "./repositories";
import { lockOwnerInTransaction, type OwnerAccessContext, type OwnerMetadata } from "./owner-gate";
import { STORAGE_STORES } from "./schema";

export type PendingLogoutTicket = Readonly<{
  key: string;
  kind: "logout";
  session_id: string;
  owner_id?: string;
  ticket: string;
  created_at: string;
}>;

export type PendingLogoutRecovery = Readonly<{
  tickets: readonly PendingLogoutTicket[];
  lockedOwnerIds: readonly string[];
}>;

function isPendingLogoutTicket(value: unknown): value is PendingLogoutTicket {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PendingLogoutTicket>;
  return row.kind === "logout" && typeof row.key === "string" &&
    typeof row.session_id === "string" && typeof row.ticket === "string" &&
    typeof row.created_at === "string" && row.key === `logout:${row.session_id}` &&
    (row.owner_id === undefined || (typeof row.owner_id === "string" && row.owner_id.length > 0));
}

/** Commit a pending server revoke and the corresponding local vault lock together. */
export async function queueLogoutAndLockOwner(
  db: IDBDatabase,
  ownerId: string,
  pending: Readonly<{ sessionId: string; ticket: string }> | null,
  now = new Date()
): Promise<StorageResult<number>> {
  if (
    !ownerId ||
    (pending !== null && (!pending.sessionId || !pending.ticket)) ||
    ![STORAGE_STORES.auth_state, STORAGE_STORES.owner_meta, STORAGE_STORES.crypto_keys]
      .every(store => db.objectStoreNames.contains(store))
  ) return storageErr("invalid_data", "Pending logout or owner lock is invalid");

  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [STORAGE_STORES.auth_state, STORAGE_STORES.owner_meta, STORAGE_STORES.crypto_keys],
        "readwrite"
      );
      const lock = lockOwnerInTransaction(tx, ownerId);
      if (pending) {
        tx.objectStore(STORAGE_STORES.auth_state).put({
          key: `logout:${pending.sessionId}`,
          kind: "logout",
          session_id: pending.sessionId,
          owner_id: ownerId,
          ticket: pending.ticket,
          created_at: now.toISOString(),
        } satisfies PendingLogoutTicket);
      }
      tx.oncomplete = () => resolve(storageOk(lock.lockEpoch()));
      const fail = (message: string, error?: DOMException | null) =>
        resolve(storageErr("transaction_aborted", message, error));
      tx.onerror = () => fail(tx.error?.message ?? "Could not commit pending logout and local lock", tx.error);
      tx.onabort = () => fail(tx.error?.message ?? "Could not commit pending logout and local lock", tx.error);
    } catch (error) {
      resolve(storageErr(
        "unavailable",
        error instanceof Error ? error.message : "Could not commit pending logout and local lock",
        error
      ));
    }
  });
}

/** Lock all local owners covered by queued tickets before any ticket is replayed. */
export async function ensureQueuedLogoutOwnersLocked(
  db: IDBDatabase
): Promise<StorageResult<PendingLogoutRecovery>> {
  if (
    ![STORAGE_STORES.auth_state, STORAGE_STORES.owner_meta, STORAGE_STORES.crypto_keys]
      .every(store => db.objectStoreNames.contains(store))
  ) return storageErr("unavailable", "Logout recovery storage is unavailable");

  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [STORAGE_STORES.auth_state, STORAGE_STORES.owner_meta, STORAGE_STORES.crypto_keys],
        "readwrite"
      );
      const ticketsRequest = tx.objectStore(STORAGE_STORES.auth_state).getAll();
      const ownersRequest = tx.objectStore(STORAGE_STORES.owner_meta).getAll();
      let tickets: PendingLogoutTicket[] = [];
      let lockedOwnerIds: string[] = [];

      ticketsRequest.onsuccess = () => {
        tickets = (ticketsRequest.result as unknown[]).filter(isPendingLogoutTicket);
      };
      ownersRequest.onsuccess = () => {
        if (tickets.length === 0) return;
        const owners = (ownersRequest.result as OwnerMetadata[])
          .filter(owner => owner && typeof owner.owner_id === "string" && owner.owner_id.length > 0);
        const legacyTicketExists = tickets.some(ticket => ticket.owner_id === undefined);
        const targetIds = new Set(legacyTicketExists
          ? owners.map(owner => owner.owner_id)
          : tickets.flatMap(ticket => ticket.owner_id ? [ticket.owner_id] : []));
        for (const owner of owners) {
          if (!targetIds.has(owner.owner_id)) continue;
          lockOwnerInTransaction(tx, owner.owner_id, { incrementEpoch: owner.locked !== true });
        }
        for (const ownerId of targetIds) {
          if (!owners.some(owner => owner.owner_id === ownerId)) {
            lockOwnerInTransaction(tx, ownerId);
          }
        }
        lockedOwnerIds = [...targetIds];
      };

      tx.oncomplete = () => resolve(storageOk({ tickets, lockedOwnerIds }));
      const fail = (message: string, error?: DOMException | null) =>
        resolve(storageErr("transaction_aborted", message, error));
      tx.onerror = () => fail(tx.error?.message ?? "Could not recover pending logout locks", tx.error);
      tx.onabort = () => fail(tx.error?.message ?? "Could not recover pending logout locks", tx.error);
    } catch (error) {
      resolve(storageErr(
        "unavailable",
        error instanceof Error ? error.message : "Could not recover pending logout locks",
        error
      ));
    }
  });
}

export type OwnerChangeSummary = Readonly<{
  pendingOperations: number;
  drafts: number;
}>;

export async function storePendingLogoutTicket(
  db: IDBDatabase,
  sessionId: string,
  ticket: string,
  now = new Date()
): Promise<StorageResult<void>> {
  if (!sessionId || !ticket || !db.objectStoreNames.contains(STORAGE_STORES.auth_state)) {
    return storageErr("invalid_data", "Pending logout ticket is invalid");
  }
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([STORAGE_STORES.auth_state], "readwrite");
      tx.objectStore(STORAGE_STORES.auth_state).put({
        key: `logout:${sessionId}`,
        kind: "logout",
        session_id: sessionId,
        ticket,
        created_at: now.toISOString(),
      } satisfies PendingLogoutTicket);
      tx.oncomplete = () => resolve(storageOk(undefined));
      tx.onerror = () => resolve(storageErr("transaction_aborted", "Could not store pending logout ticket", tx.error));
      tx.onabort = () => resolve(storageErr("transaction_aborted", "Could not store pending logout ticket", tx.error));
    } catch {
      resolve(storageErr("unavailable", "Could not store pending logout ticket"));
    }
  });
}

export async function listPendingLogoutTickets(
  db: IDBDatabase
): Promise<StorageResult<readonly PendingLogoutTicket[]>> {
  if (!db.objectStoreNames.contains(STORAGE_STORES.auth_state)) {
    return storageErr("unavailable", "Authentication state storage is unavailable");
  }
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([STORAGE_STORES.auth_state], "readonly");
      const request = tx.objectStore(STORAGE_STORES.auth_state).getAll();
      request.onsuccess = () => {
        const rows = (request.result as unknown[]).filter(isPendingLogoutTicket);
        resolve(storageOk(rows));
      };
      request.onerror = () => resolve(storageErr("unavailable", "Could not read pending logout tickets", request.error));
    } catch {
      resolve(storageErr("unavailable", "Could not read pending logout tickets"));
    }
  });
}

export async function removePendingLogoutTicket(
  db: IDBDatabase,
  key: string
): Promise<StorageResult<void>> {
  if (!db.objectStoreNames.contains(STORAGE_STORES.auth_state)) return storageErr("unavailable", "Authentication state storage is unavailable");
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([STORAGE_STORES.auth_state], "readwrite");
      tx.objectStore(STORAGE_STORES.auth_state).delete(key);
      tx.oncomplete = () => resolve(storageOk(undefined));
      tx.onerror = () => resolve(storageErr("transaction_aborted", "Could not clear pending logout ticket", tx.error));
      tx.onabort = () => resolve(storageErr("transaction_aborted", "Could not clear pending logout ticket", tx.error));
    } catch {
      resolve(storageErr("unavailable", "Could not clear pending logout ticket"));
    }
  });
}

export async function countOwnerChanges(
  db: IDBDatabase,
  context: OwnerAccessContext | null,
  ownerId = context?.ownerId
): Promise<StorageResult<OwnerChangeSummary>> {
  if (!ownerId) return storageErr("invalid_data", "Owner ID is required");
  let pendingOperations = 0;
  if (context) {
    const pending = await listOutboxForReplay(db, context);
    if (!pending.ok) return pending;
    pendingOperations = pending.value.length;
  }
  return await new Promise((resolve) => {
    try {
      const stores = context
        ? [STORAGE_STORES.drafts]
        : [STORAGE_STORES.operations, STORAGE_STORES.drafts];
      const tx = db.transaction(stores, "readonly");
      const range = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
      let drafts = 0;
      let operationsReady = context !== null;
      let draftsReady = false;
      const finish = () => {
        if (operationsReady && draftsReady) {
          resolve(storageOk({ pendingOperations, drafts }));
        }
      };
      if (!context) {
        const operationsRequest = tx.objectStore(STORAGE_STORES.operations).getAll(range);
        operationsRequest.onsuccess = () => {
          pendingOperations = (operationsRequest.result as Array<{ status?: unknown }>)
            .filter((entry) => entry.status === "queued" || entry.status === "sending" || entry.status === "pending")
            .length;
          operationsReady = true;
          finish();
        };
        operationsRequest.onerror = () => resolve(storageErr("unavailable", "Could not inspect pending operations", operationsRequest.error));
      }
      const draftsRequest = tx.objectStore(STORAGE_STORES.drafts).count(range);
      draftsRequest.onsuccess = () => {
        drafts = draftsRequest.result;
        draftsReady = true;
        finish();
      };
      draftsRequest.onerror = () => resolve(storageErr("unavailable", "Could not inspect local drafts", draftsRequest.error));
      tx.onabort = () => resolve(storageErr("transaction_aborted", "Could not inspect local changes", tx.error));
      tx.onerror = () => resolve(storageErr("unavailable", "Could not inspect local changes", tx.error));
    } catch {
      resolve(storageErr("unavailable", "Could not inspect local changes"));
    }
  });
}
