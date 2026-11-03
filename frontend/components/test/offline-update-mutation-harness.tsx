"use client";

import { useLayoutEffect } from "react";
import {
  commitOwnerChanges,
  initializeBuildGate,
  initializeOwnerMetadata,
  listOwnerMetadata,
  openVaultDatabase,
  readBuildGate,
  readOwnerSnapshot,
  unlockOwner,
} from "../../lib/storage/vault";
import { commitLocalMutation } from "../../lib/sync/mutation";
import { acknowledgePushResponse, readActiveOutbox } from "../../lib/sync/outbox";
import type { Operation, SyncCommand, UUID } from "../../lib/sync/protocol";
import type { PushResponse } from "../../services/sync";

const BUILD_ID = process.env.NEXT_PUBLIC_DAYFORGE_BUILD_ID ?? "development";
const CALIBRATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

interface CreatedPendingPlan {
  operationId: UUID;
  requestHash: string;
  state: string;
  planNamePresent: boolean;
}

async function initializeVault(ownerId: UUID, keyId: UUID, keyBytes: number[]): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ownerId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(keyId) ||
      !Array.isArray(keyBytes) || keyBytes.length !== 32 || keyBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Test vault configuration is invalid");
  }
  const database = await openVaultDatabase(BUILD_ID);
  try {
    await initializeBuildGate(database, BUILD_ID);
    const metadata = (await listOwnerMetadata(database)).find((entry) => entry.owner_id === ownerId);
    if (!metadata) {
      await initializeOwnerMetadata(database, {
        owner_id: ownerId,
        device_id: crypto.randomUUID() as UUID,
        key_id: keyId,
        build_id: BUILD_ID,
      });
    } else if (metadata.key_id !== keyId) {
      throw new Error("Test owner is already initialized with a different vault key");
    }
    const rawKey = Uint8Array.from(keyBytes);
    keyBytes.fill(0);
    await unlockOwner(database, { owner_id: ownerId, key_id: keyId, rawKey, buildId: BUILD_ID });
  } finally {
    database.close();
  }
}

async function inspectQuotaVault(ownerId: UUID): Promise<{ revision: number; outboxIds: string[]; projectionIds: string[] }> {
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const snapshot = await readOwnerSnapshot(database, ownerId, BUILD_ID);
    return {
      revision: snapshot.metadata.local_state_revision,
      outboxIds: snapshot.outbox.map((row) => row.record_id).sort(),
      projectionIds: snapshot.projection.map((row) => row.record_id).sort(),
    };
  } finally {
    database.close();
  }
}

async function acknowledgePendingOperationForUpdateTest(
  ownerId: UUID,
  operationId: UUID,
  serverEpoch: UUID,
): Promise<{ operation: Operation; requestHash: string; commitCursor: string }> {
  const database = await openVaultDatabase(BUILD_ID);
  try {
    let snapshot = await readOwnerSnapshot(database, ownerId, BUILD_ID);
    let gate = await readBuildGate(database);
    if (!gate) throw new Error("Build gate is unavailable in the ACK-waiting test harness");
    if (snapshot.metadata.server_epoch === null) {
      const seeded = await commitOwnerChanges({
        database,
        guard: {
          owner_id: ownerId,
          expected_revision: snapshot.metadata.local_state_revision,
          expected_lock_epoch: snapshot.metadata.lock_epoch,
          expected_generation: snapshot.metadata.sync_generation,
          expected_server_epoch: snapshot.metadata.server_epoch,
          expected_cursor: snapshot.metadata.pull_cursor,
          expected_build: BUILD_ID,
          expected_gate_revision: gate.revision,
        },
        writes: [],
        metadataPatch: { server_epoch: serverEpoch },
      });
      if (!seeded.committed) throw new Error(`Unable to seed the test server epoch: ${seeded.reason}`);
      snapshot = await readOwnerSnapshot(database, ownerId, BUILD_ID);
      gate = await readBuildGate(database);
      if (!gate) throw new Error("Build gate disappeared while preparing the ACK-waiting test");
    }
    const entry = (await readActiveOutbox(snapshot)).find((candidate) => candidate.operation.operation_id === operationId);
    if (!entry || entry.state !== "queued") throw new Error("Expected a queued operation before creating the ACK-waiting fixture");
    const fencingToken = 7;
    const holderId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["leases"], "readwrite", { durability: "strict" });
      transaction.objectStore("leases").put({
        owner_id: ownerId,
        holder_id: holderId,
        fencing_token: fencingToken,
        expires_at_ms: Date.now() + 60_000,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to create test fencing lease"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Test fencing lease transaction aborted"));
    });
    const response: PushResponse = {
      epoch: snapshot.metadata.server_epoch ?? serverEpoch,
      head_cursor: "1",
      results: [{
        operation_id: operationId,
        status: "recorded",
        receipt: {
          operation_id: operationId,
          request_hash: entry.request_hash,
          recorded: true,
          commit_cursor: "1",
          effect_at_commit: "applied",
          reason_at_commit: null,
        },
      }],
    };
    const result = await acknowledgePushResponse({
      database,
      snapshot,
      gate,
      expectedBuild: BUILD_ID,
      expectedFencingToken: fencingToken,
      sentOperations: [entry.operation],
      response,
    });
    if (!result.committed) throw new Error(`Unable to persist the ACK-waiting fixture: ${result.reason}`);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["leases"], "readwrite", { durability: "strict" });
      const store = transaction.objectStore("leases");
      const leaseRequest = store.get(ownerId);
      leaseRequest.onsuccess = () => {
        const lease = leaseRequest.result as { holder_id?: string; fencing_token?: number; expires_at_ms?: number } | undefined;
        if (lease?.holder_id === holderId && lease.fencing_token === fencingToken) {
          store.put({ ...lease, expires_at_ms: 0 });
        }
      };
      leaseRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to release the ACK-waiting fixture lease"));
      transaction.onabort = () => reject(transaction.error ?? new Error("ACK-waiting fixture lease release aborted"));
    });
    return { operation: entry.operation, requestHash: entry.request_hash, commitCursor: "1" };
  } finally {
    database.close();
  }
}

async function createQuotaPressureMutation(ownerId: UUID): Promise<{ operationId: UUID; requestHash: string }> {
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const [snapshot, gate] = await Promise.all([
      readOwnerSnapshot(database, ownerId, BUILD_ID),
      readBuildGate(database),
    ]);
    if (!gate) throw new Error("Build gate is unavailable in the quota test harness");
    const date = new Date().toISOString().slice(0, 10);
    const note = "q".repeat(3_800);
    const commands: SyncCommand[] = Array.from({ length: 400 }, (_, index) => ({
      root: { kind: "milestone", id: crypto.randomUUID() as UUID },
      action: "milestone.create",
      payload: { data: {
        title: `Quota rollback ${index}`,
        date,
        period: null,
        note,
        plan_id: null,
        standalone_color_id: "neutral",
        show_in_work_calendar: false,
      } },
      precondition: null,
    }));
    const now = Date.now();
    const result = await commitLocalMutation({
      database,
      snapshot,
      gate,
      expectedBuild: BUILD_ID,
      draft: {
        editTime: {
          physical_ms: now,
          logical: 0,
          calibration_id: CALIBRATION_ID,
          raw_wall_ms: now,
          quality: "offline_estimate",
        },
        commands,
      },
    });
    if (!result.result.committed) throw new Error(`Quota pressure mutation did not commit: ${result.result.reason}`);
    return { operationId: result.operation.operation_id, requestHash: result.requestHash };
  } finally {
    database.close();
  }
}

declare global {
  interface Window {
    __dayforgeOfflineUpdateHarness?: {
      createPendingPlan(name: string, ownerId: UUID, keyId: UUID, keyBytes: number[]): Promise<CreatedPendingPlan>;
      initializeVault(ownerId: UUID, keyId: UUID, keyBytes: number[]): Promise<void>;
      inspectQuotaVault(ownerId: UUID): ReturnType<typeof inspectQuotaVault>;
      createQuotaPressureMutation(ownerId: UUID): ReturnType<typeof createQuotaPressureMutation>;
      acknowledgePendingOperationForUpdateTest(ownerId: UUID, operationId: UUID, serverEpoch: UUID): Promise<{
        operation: Operation;
        requestHash: string;
        commitCursor: string;
      }>;
    };
  }
}

async function createPendingPlan(name: string, ownerId: UUID, keyId: UUID, keyBytes: number[]): Promise<CreatedPendingPlan> {
  if (typeof name !== "string" || !name || new TextEncoder().encode(name).byteLength > 300) {
    throw new Error("Test plan name is invalid");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ownerId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(keyId) ||
      !Array.isArray(keyBytes) || keyBytes.length !== 32 || keyBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Test vault configuration is invalid");
  }

  const database = await openVaultDatabase(BUILD_ID);
  try {
    await initializeBuildGate(database, BUILD_ID);
    const metadata = (await listOwnerMetadata(database)).find((entry) => entry.owner_id === ownerId);
    if (!metadata) {
      await initializeOwnerMetadata(database, {
        owner_id: ownerId,
        device_id: crypto.randomUUID() as UUID,
        key_id: keyId,
        build_id: BUILD_ID,
      });
    } else if (metadata.key_id !== keyId) {
      throw new Error("Test owner is already initialized with a different vault key");
    }

    const rawKey = Uint8Array.from(keyBytes);
    keyBytes.fill(0);
    await unlockOwner(database, { owner_id: ownerId, key_id: keyId, rawKey, buildId: BUILD_ID });
    const [snapshot, gate] = await Promise.all([
      readOwnerSnapshot(database, ownerId, BUILD_ID),
      readBuildGate(database),
    ]);
    if (!gate) throw new Error("Build gate is unavailable in the offline update harness");

    const now = Date.now();
    const rootId = crypto.randomUUID() as UUID;
    const result = await commitLocalMutation({
      database,
      snapshot,
      gate,
      expectedBuild: BUILD_ID,
      draft: {
        editTime: {
          physical_ms: now,
          logical: 0,
          calibration_id: CALIBRATION_ID,
          raw_wall_ms: now,
          quality: "calibrated",
        },
        commands: [{
          root: { kind: "plan", id: rootId },
          action: "plan.create",
          payload: { data: { name, color_id: "blue" } },
          precondition: null,
        }],
      },
    });
    if (!result.result.committed) throw new Error(`Local mutation did not commit: ${result.result.reason}`);

    const activeOutbox = await readActiveOutbox(await readOwnerSnapshot(database, ownerId, BUILD_ID));
    const persisted = activeOutbox.find((entry) => entry.operation.operation_id === result.operation.operation_id);
    if (!persisted || persisted.request_hash !== result.requestHash || persisted.state !== "queued") {
      throw new Error("Mutation API did not persist the expected queued operation");
    }
    const root = result.projection.roots[`plan:${rootId}`];
    const planNamePresent = Boolean(root && !root.deleted && "data" in root && "name" in root.data && root.data.name === name);
    if (!planNamePresent) throw new Error("Mutation projection is missing the newly created plan");

    return {
      operationId: result.operation.operation_id,
      requestHash: result.requestHash,
      state: persisted.state,
      planNamePresent,
    };
  } finally {
    database.close();
  }
}

export function OfflineUpdateMutationHarness(): React.JSX.Element {
  useLayoutEffect(() => {
    const harness = {
      createPendingPlan,
      initializeVault,
      inspectQuotaVault,
      createQuotaPressureMutation,
      acknowledgePendingOperationForUpdateTest,
    };
    window.__dayforgeOfflineUpdateHarness = harness;
    return () => {
      if (window.__dayforgeOfflineUpdateHarness === harness) delete window.__dayforgeOfflineUpdateHarness;
    };
  }, []);

  return <main><h1>Offline update mutation harness</h1><p>Test-only production build route.</p></main>;
}
