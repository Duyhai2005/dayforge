import { assertBuildGate, type BuildGate, type LeaseRecord, type OwnerAuthState, type OwnerMeta } from "../storage/vault";
import type { UUID } from "./protocol";

export const LEASE_TTL_MS = 12_000;
export const LEASE_HEARTBEAT_MS = 4_000;
const CLAIM_RETRY_MS = 1_500;

export interface LeaderLease {
  owner_id: UUID;
  holder_id: string;
  fencing_token: number;
  expires_at_ms: number;
  lock_epoch: number;
}

export interface LeadershipHandle {
  isLeader(): boolean;
  currentLease(): LeaderLease | null;
  close(): Promise<void>;
}

function claimLease(database: IDBDatabase, input: {
  ownerId: UUID;
  holderId: string;
  buildId: string;
  lockEpoch: number;
  nowMs: number;
}): Promise<LeaderLease | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["build_gate", "owner_meta", "auth_state", "leases"], "readwrite", { durability: "strict" });
    const gateRequest = transaction.objectStore("build_gate").get("build_gate");
    const metaRequest = transaction.objectStore("owner_meta").get(input.ownerId);
    const authRequest = transaction.objectStore("auth_state").get(input.ownerId);
    const leaseRequest = transaction.objectStore("leases").get(input.ownerId);
    let gate: BuildGate | undefined;
    let meta: OwnerMeta | undefined;
    let auth: OwnerAuthState | undefined;
    let lease: LeaseRecord | undefined;
    let remaining = 4;
    let result: LeaderLease | null = null;
    let conflict = false;
    let failure: Error | null = null;
    const done = () => {
      if (--remaining !== 0) return;
      try {
        if (gate) assertBuildGate(gate);
      } catch {
        failure = new Error("Stored build gate is invalid");
        transaction.abort();
        return;
      }
      if (!gate || gate.phase !== "running" || gate.approved_build !== input.buildId ||
          !meta || meta.owner_id !== input.ownerId || meta.lock_epoch !== input.lockEpoch ||
          !auth || auth.owner_id !== input.ownerId || auth.locked || !auth.crypto_key || auth.lock_epoch !== input.lockEpoch) {
        conflict = true;
        transaction.abort();
        return;
      }
      if (lease && (!Number.isSafeInteger(lease.fencing_token) || lease.fencing_token < 1 ||
          !Number.isSafeInteger(lease.expires_at_ms) || lease.expires_at_ms < 0)) {
        failure = new Error("Stored sync lease is invalid");
        transaction.abort();
        return;
      }
      if (lease && lease.expires_at_ms > input.nowMs && lease.holder_id !== input.holderId) {
        result = null;
        return;
      }
      const token = lease?.holder_id === input.holderId && lease.expires_at_ms > input.nowMs
        ? lease.fencing_token
        : (lease?.fencing_token ?? 0) + 1;
      if (!Number.isSafeInteger(token)) {
        failure = new Error("Sync lease fencing token exhausted");
        transaction.abort();
        return;
      }
      result = {
        owner_id: input.ownerId,
        holder_id: input.holderId,
        fencing_token: token,
        expires_at_ms: input.nowMs + LEASE_TTL_MS,
        lock_epoch: input.lockEpoch,
      };
      transaction.objectStore("leases").put({
        owner_id: input.ownerId,
        holder_id: input.holderId,
        fencing_token: token,
        expires_at_ms: input.nowMs + LEASE_TTL_MS,
      } satisfies LeaseRecord);
    };
    gateRequest.onsuccess = () => { gate = gateRequest.result as BuildGate | undefined; done(); };
    metaRequest.onsuccess = () => { meta = metaRequest.result as OwnerMeta | undefined; done(); };
    authRequest.onsuccess = () => { auth = authRequest.result as OwnerAuthState | undefined; done(); };
    leaseRequest.onsuccess = () => { lease = leaseRequest.result as LeaseRecord | undefined; done(); };
    for (const request of [gateRequest, metaRequest, authRequest, leaseRequest]) {
      request.onerror = () => { failure = request.error ?? new Error("Unable to acquire the sync lease"); transaction.abort(); };
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => conflict ? resolve(null) : reject(failure ?? transaction.error ?? new Error("Sync lease transaction aborted"));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Sync lease transaction failed"));
  });
}

function renewLease(database: IDBDatabase, lease: LeaderLease, buildId: string, nowMs: number): Promise<LeaderLease | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["build_gate", "owner_meta", "auth_state", "leases"], "readwrite", { durability: "strict" });
    const gateRequest = transaction.objectStore("build_gate").get("build_gate");
    const metaRequest = transaction.objectStore("owner_meta").get(lease.owner_id);
    const authRequest = transaction.objectStore("auth_state").get(lease.owner_id);
    const leaseRequest = transaction.objectStore("leases").get(lease.owner_id);
    let gate: BuildGate | undefined;
    let meta: OwnerMeta | undefined;
    let auth: OwnerAuthState | undefined;
    let current: LeaseRecord | undefined;
    let remaining = 4;
    let result: LeaderLease | null = null;
    let conflict = false;
    let failure: Error | null = null;
    const done = () => {
      if (--remaining !== 0) return;
      try {
        if (gate) assertBuildGate(gate);
      } catch {
        failure = new Error("Stored build gate is invalid");
        transaction.abort();
        return;
      }
      if (!gate || gate.phase !== "running" || gate.approved_build !== buildId ||
          !meta || meta.lock_epoch !== lease.lock_epoch || !auth || auth.owner_id !== lease.owner_id ||
          auth.locked || auth.lock_epoch !== lease.lock_epoch ||
          !current || current.holder_id !== lease.holder_id || current.fencing_token !== lease.fencing_token || current.expires_at_ms <= nowMs) {
        conflict = true;
        transaction.abort();
        return;
      }
      const expiresAt = nowMs + LEASE_TTL_MS;
      transaction.objectStore("leases").put({ ...current, expires_at_ms: expiresAt });
      result = { ...lease, expires_at_ms: expiresAt };
    };
    gateRequest.onsuccess = () => { gate = gateRequest.result as BuildGate | undefined; done(); };
    metaRequest.onsuccess = () => { meta = metaRequest.result as OwnerMeta | undefined; done(); };
    authRequest.onsuccess = () => { auth = authRequest.result as OwnerAuthState | undefined; done(); };
    leaseRequest.onsuccess = () => { current = leaseRequest.result as LeaseRecord | undefined; done(); };
    for (const request of [gateRequest, metaRequest, authRequest, leaseRequest]) {
      request.onerror = () => { failure = request.error ?? new Error("Unable to renew the sync lease"); transaction.abort(); };
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => conflict ? resolve(null) : reject(failure ?? transaction.error ?? new Error("Sync lease renewal aborted"));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Sync lease renewal failed"));
  });
}

function releaseLease(database: IDBDatabase, lease: LeaderLease): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["leases"], "readwrite", { durability: "strict" });
    const store = transaction.objectStore("leases");
    const request = store.get(lease.owner_id);
    request.onsuccess = () => {
      const current = request.result as LeaseRecord | undefined;
      if (current?.holder_id === lease.holder_id && current.fencing_token === lease.fencing_token) {
        // Preserve the last token after a clean release so the next holder always fences stale work.
        store.put({ ...current, expires_at_ms: 0 });
      }
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Sync lease release aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Sync lease release failed"));
  });
}

/** One owner-scoped leader lease; all notifications carry state-change hints only. */
export function startOwnerLeadership(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
  lockEpoch: number;
  onLeader(lease: LeaderLease): void;
  onLost?(lease: LeaderLease | null): void;
}): LeadershipHandle {
  const holderId = crypto.randomUUID();
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`dayforge-sync:${input.ownerId}`);
  let lease: LeaderLease | null = null;
  let closed = false;
  let running = false;
  let timer: number | null = null;
  let retryTimer: number | null = null;

  const notify = () => channel?.postMessage({ type: "state_changed" });
  const loseLeadership = async () => {
    const previous = lease;
    lease = null;
    if (previous) {
      input.onLost?.(previous);
      notify();
      await releaseLease(input.database, previous).catch(() => undefined);
    }
    running = false;
  };

  const heartbeat = async () => {
    if (closed || running) return;
    running = true;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      if (!lease) {
        lease = await claimLease(input.database, {
          ownerId: input.ownerId,
          holderId,
          buildId: input.buildId,
          lockEpoch: input.lockEpoch,
          nowMs: Date.now(),
        });
        if (lease) {
          input.onLeader(lease);
          notify();
        }
      } else {
        const renewed = await renewLease(input.database, lease, input.buildId, Date.now());
        if (!renewed) await loseLeadership();
        else lease = renewed;
      }
    } catch {
      if (lease) await loseLeadership();
    } finally {
      running = false;
      if (!closed && !lease) retryTimer = window.setTimeout(() => void heartbeat(), CLAIM_RETRY_MS);
    }
  };

  timer = window.setInterval(() => void heartbeat(), LEASE_HEARTBEAT_MS);
  void heartbeat();

  return {
    isLeader: () => lease !== null && !closed,
    currentLease: () => lease,
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer !== null) window.clearInterval(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (lease) notify();
      channel?.close();
      const previous = lease;
      lease = null;
      if (previous) {
        input.onLost?.(previous);
        await releaseLease(input.database, previous).catch(() => undefined);
      }
    },
  };
}
