"use client";

import { useLayoutEffect } from "react";
import { commitOwnerChanges, encryptOwnerPayload, lockOwner, readBuildGate, openVaultDatabase, readOwnerSnapshot } from "../../lib/storage/vault";
import { commitLocalMutation } from "../../lib/sync/mutation";
import { readActiveOutbox } from "../../lib/sync/outbox";
import { calibratedEditTime } from "../../lib/sync/calibration";
import { persistEpochRecoveryJournal } from "../../lib/sync/recovery";
import { stageBootstrapPage } from "../../lib/sync/bootstrap";
import { readRecordedShadow, rebuildOwnerProjection } from "../../lib/sync/projection";
import type { CoordinatorStatus } from "../../lib/sync/coordinator";
import type { SyncCommand, UUID } from "../../lib/sync/protocol";
import { semanticRootHash, workItemsForDates, type RecurrenceRule, type TaskData, type TaskTemplate } from "../../lib/sync/reducer";
import { useAccount } from "../account/account-provider";

const BUILD_ID = process.env.NEXT_PUBLIC_DAYFORGE_BUILD_ID ?? "development";
let ownerIdPromise: Promise<UUID> | null = null;
const systemWallClockNow = Date.now.bind(Date);
let testWallClockOffsetMs = 0;

interface SessionView {
  authenticated: boolean;
  owner: { id: UUID } | null;
}

async function ownerId(): Promise<UUID> {
  const response = await fetch("/api/v1/auth/session", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Session assertion failed with ${response.status}`);
  const session = await response.json() as SessionView;
  if (!session.authenticated || !session.owner?.id) throw new Error("Test browser is not authenticated as an owner");
  return session.owner.id;
}

function currentOwnerId(): Promise<UUID> {
  ownerIdPromise ??= ownerId();
  return ownerIdPromise;
}

async function inspect(dates: string[] = []): Promise<{
  ownerId: UUID;
  deviceId: UUID;
  pullCursor: string;
  serverEpoch: UUID | null;
  pending: Array<{ operationId: UUID; state: string; receipt: unknown }>;
  recordedEvents: Array<{ operationId: UUID; cursor: string; requestHash: string }>;
  journalCount: number;
  diagnosticIds: string[];
  stagingCount: number;
  planNames: string[];
  planColors: Array<{ id: UUID; name: string; colorId: string }>;
  recurrenceFamilies: Array<{ rootId: UUID; rootHash: string; deleted: boolean; family: unknown }>;
  workItems: Array<{ id: UUID; rootId: UUID; data: TaskData; target: unknown }>;
  deletedWorkItemIds: string[];
  localStateRevision: number;
  clockCalibration: {
    calibrationId: UUID;
    offsetMs: number;
    calibratedAtWallMs: number;
  } | null;
}> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const snapshot = await readOwnerSnapshot(database, owner, BUILD_ID);
    const [outbox, shadow, projection] = await Promise.all([
      readActiveOutbox(snapshot),
      readRecordedShadow(snapshot),
      rebuildOwnerProjection({ snapshot }),
    ]);
    const stagingCount = await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(["staging"], "readonly");
      const request = transaction.objectStore("staging").index("by-owner").count(IDBKeyRange.only(owner));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to inspect bootstrap staging rows"));
    });
    const planNames = Object.entries(projection.replay.state.roots)
      .filter(([key, value]) => key.startsWith("plan:") && !value.deleted)
      .map(([, value]) => String((value as { data?: { name?: unknown } }).data?.name ?? ""))
      .filter(Boolean)
      .sort();
    const planColors = Object.entries(projection.replay.state.roots)
      .filter(([key, value]) => key.startsWith("plan:") && !value.deleted)
      .map(([key, value]) => ({
        id: key.slice("plan:".length) as UUID,
        name: String((value as { data?: { name?: unknown } }).data?.name ?? ""),
        colorId: String((value as { data?: { color_id?: unknown } }).data?.color_id ?? ""),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const recurrenceFamilies = (await Promise.all(Object.entries(projection.replay.state.roots)
      .filter(([key, value]) => key.startsWith("work_item:") && "kind" in value && value.kind === "recurrence_family")
      .map(async ([key, value]) => {
        if (!("kind" in value) || value.kind !== "recurrence_family") throw new Error("Recurrence projection changed while inspecting the browser fixture");
        const rootId = key.slice("work_item:".length) as UUID;
        return {
          rootId,
          rootHash: await semanticRootHash({ kind: "work_item", id: rootId }, value),
          deleted: value.deleted,
          family: value.family,
        };
      })))
      .sort((left, right) => left.rootId.localeCompare(right.rootId));
    const workItems = (await workItemsForDates(projection.replay.state, dates))
      .map(({ id, root_id, data, target }) => ({ id, rootId: root_id, data, target }));
    const deletedWorkItemIds = Object.entries(projection.replay.state.roots)
      .filter(([key, value]) => key.startsWith("work_item:") && "kind" in value && value.deleted)
      .map(([key]) => key.slice("work_item:".length))
      .sort();
    return {
      ownerId: owner,
      deviceId: snapshot.metadata.device_id,
      pullCursor: snapshot.metadata.pull_cursor,
      serverEpoch: snapshot.metadata.server_epoch,
      pending: outbox.map((entry) => ({ operationId: entry.operation.operation_id, state: entry.state, receipt: entry.receipt })),
      recordedEvents: shadow.map((event) => ({
        operationId: event.group.operation.operation_id,
        cursor: event.group.cursor,
        requestHash: event.hash,
      })),
      journalCount: snapshot.journal.length,
      diagnosticIds: snapshot.diagnostics.map((row) => row.record_id),
      stagingCount,
      planNames,
      planColors,
      recurrenceFamilies,
      workItems,
      deletedWorkItemIds,
      localStateRevision: snapshot.metadata.local_state_revision,
      clockCalibration: snapshot.metadata.clock_calibration ? {
        calibrationId: snapshot.metadata.clock_calibration.calibration_id,
        offsetMs: snapshot.metadata.clock_calibration.offset_ms,
        calibratedAtWallMs: snapshot.metadata.clock_calibration.calibrated_at_wall_ms,
      } : null,
    };
  } finally {
    database.close();
  }
}

async function commitCommands(commands: SyncCommand[], dependencies: UUID[] = [], clockOffsetMs = 0): Promise<{ operationId: UUID; requestHash: string }> {
  if (!Number.isSafeInteger(clockOffsetMs) || Math.abs(clockOffsetMs) > 86_400_000) {
    throw new Error("Test clock offset is invalid");
  }
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [snapshot, gate] = await Promise.all([
        readOwnerSnapshot(database, owner, BUILD_ID),
        readBuildGate(database),
      ]);
      if (!gate) throw new Error("Build gate is unavailable in the sync harness");
      const editTime = calibratedEditTime({
        calibration: snapshot.metadata.clock_calibration,
        local: snapshot.metadata.local_hlc,
        observed: snapshot.metadata.observed_hlc,
        rawWallMs: Date.now() + clockOffsetMs,
        monotonicMs: performance.now(),
      });
      const result = await commitLocalMutation({
        database,
        snapshot,
        gate,
        expectedBuild: BUILD_ID,
        draft: {
          editTime,
          commands,
          dependencies,
        },
      });
      if (result.result.committed) return { operationId: result.operation.operation_id, requestHash: result.requestHash };
      if (result.result.reason === "locked") throw new Error("Owner vault locked during local test mutation");
    }
    throw new Error("Local test mutation repeatedly lost its revision/build gate");
  } finally {
    database.close();
  }
}

async function createPlan(name: string, clockOffsetMs = 0): Promise<{ operationId: UUID; requestHash: string; planId: UUID }> {
  if (typeof name !== "string" || !name || new TextEncoder().encode(name).byteLength > 300) throw new Error("Test plan name is invalid");
  const planId = crypto.randomUUID() as UUID;
  const result = await commitCommands([{
    root: { kind: "plan", id: planId },
    action: "plan.create",
    payload: { data: { name, color_id: "blue" } },
    precondition: null,
  }], [], clockOffsetMs);
  return { ...result, planId };
}

async function replacePlan(planId: UUID, name: string, dependencyId: UUID): Promise<{ operationId: UUID; requestHash: string }> {
  if (typeof name !== "string" || !name || new TextEncoder().encode(name).byteLength > 300) throw new Error("Test plan name is invalid");
  return commitCommands([{
    root: { kind: "plan", id: planId },
    action: "plan.replace",
    payload: { data: { name, color_id: "purple" } },
    precondition: null,
  }], [dependencyId]);
}

async function createWorkItem(planId: UUID, dependencyId: UUID): Promise<{ operationId: UUID; requestHash: string; workItemId: UUID }> {
  const workItemId = crypto.randomUUID() as UUID;
  const date = new Date(Date.now()).toISOString().slice(0, 10);
  const result = await commitCommands([{
    root: { kind: "work_item", id: workItemId },
    action: "work_item.create_single",
    payload: { data: {
      title: "Offline reconnect delete candidate",
      date,
      period: "afternoon",
      duration_minutes: 30,
      plan_id: planId,
      standalone_color_id: "neutral",
      status: "pending",
      order_key: "0",
    } },
    precondition: null,
  }], [dependencyId]);
  return { ...result, workItemId };
}

async function deleteWorkItem(workItemId: UUID, dependencyId: UUID): Promise<{ operationId: UUID; requestHash: string }> {
  return commitCommands([{
    root: { kind: "work_item", id: workItemId },
    action: "single.delete",
    payload: {},
    precondition: null,
  }], [dependencyId]);
}

async function createRecurringTask(input: {
  planId: UUID;
  dependencyIds: UUID[];
  startDate: string;
  weekdays: number[];
}): Promise<{ operationId: UUID; requestHash: string; workItemId: UUID }> {
  const workItemId = crypto.randomUUID() as UUID;
  const rule: RecurrenceRule = { weekdays: [...input.weekdays].sort((left, right) => left - right) };
  const template: TaskTemplate = {
    title: "Recurring library review",
    period: "morning",
    duration_minutes: 30,
    plan_id: input.planId,
    standalone_color_id: "blue",
    order_key: "0",
  };
  const result = await commitCommands([{
    root: { kind: "work_item", id: workItemId },
    action: "work_item.create_recurrence",
    payload: { start_date: input.startDate, rule, template },
    precondition: null,
  }], input.dependencyIds);
  return { ...result, workItemId };
}

async function replaceOccurrence(input: {
  workItemId: UUID;
  sourceSegmentId: UUID;
  originalDate: string;
  data: TaskData;
  dependencyIds: UUID[];
  clockOffsetMs?: number;
}): Promise<{ operationId: UUID; requestHash: string }> {
  return commitCommands([{
    root: { kind: "work_item", id: input.workItemId },
    action: "occurrence.replace",
    payload: {
      source_segment_id: input.sourceSegmentId,
      original_date: input.originalDate,
      data: input.data,
    },
    precondition: null,
  }], input.dependencyIds, input.clockOffsetMs ?? 0);
}

async function editSeriesFuture(input: {
  workItemId: UUID;
  sourceSegmentId: UUID;
  cutoffOriginalDate: string;
  rule: RecurrenceRule;
  template: TaskTemplate;
  dependencyIds: UUID[];
}): Promise<{ operationId: UUID; requestHash: string }> {
  return commitCommands([{
    root: { kind: "work_item", id: input.workItemId },
    action: "series.edit_future",
    payload: {
      source_segment_id: input.sourceSegmentId,
      cutoff_original_date: input.cutoffOriginalDate,
      rule: input.rule,
      template: input.template,
    },
    precondition: null,
  }], input.dependencyIds);
}

async function stopSeriesFuture(input: {
  workItemId: UUID;
  sourceSegmentId: UUID;
  cutoffOriginalDate: string;
  dependencyIds: UUID[];
}): Promise<{ operationId: UUID; requestHash: string }> {
  return commitCommands([{
    root: { kind: "work_item", id: input.workItemId },
    action: "series.stop_future",
    payload: {
      source_segment_id: input.sourceSegmentId,
      cutoff_original_date: input.cutoffOriginalDate,
    },
    precondition: null,
  }], input.dependencyIds);
}

async function undoWorkItemOperation(input: {
  workItemId: UUID;
  originalOperationId: UUID;
}): Promise<{ operationId: UUID; requestHash: string }> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const [snapshot, gate] = await Promise.all([
      readOwnerSnapshot(database, owner, BUILD_ID),
      readBuildGate(database),
    ]);
    if (!gate) throw new Error("Build gate is unavailable in the sync harness");
    const projection = (await rebuildOwnerProjection({ snapshot })).replay.state;
    const root = { kind: "work_item" as const, id: input.workItemId };
    const hash = await semanticRootHash(root, projection.roots[`work_item:${input.workItemId}`] ?? null);
    const result = await commitLocalMutation({
      database,
      snapshot,
      gate,
      expectedBuild: BUILD_ID,
      requireApplied: true,
      draft: {
        dependencies: [input.originalOperationId],
        commands: [{
          root,
          action: "undo",
          payload: {
            original_operation_id: input.originalOperationId,
            expected_states: [{ root, hash }],
          },
          precondition: null,
        }],
      },
    });
    return { operationId: result.operation.operation_id, requestHash: result.requestHash };
  } finally {
    database.close();
  }
}

function setClockOffsetForTest(offsetMs: number): void {
  if (!Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > 12 * 60 * 60 * 1_000) {
    throw new Error("Test clock offset is invalid");
  }
  testWallClockOffsetMs = offsetMs;
  Date.now = () => systemWallClockNow() + testWallClockOffsetMs;
}

async function expireClockCalibrationForTest(): Promise<void> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["owner_meta"], "readwrite", { durability: "strict" });
      const store = transaction.objectStore("owner_meta");
      const request = store.get(owner);
      request.onsuccess = () => {
        const metadata = request.result as { clock_calibration?: { calibrated_at_wall_ms: number } | null } | undefined;
        if (!metadata?.clock_calibration) {
          transaction.abort();
          return;
        }
        store.put({
          ...metadata,
          clock_calibration: {
            ...metadata.clock_calibration,
            calibrated_at_wall_ms: Date.now() - 11 * 60 * 1_000,
          },
        });
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Clock calibration expiry transaction aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Clock calibration expiry transaction failed"));
    });
  } finally {
    database.close();
  }
}

async function expireLeaseForClockTest(): Promise<void> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["leases"], "readwrite", { durability: "strict" });
      const store = transaction.objectStore("leases");
      const request = store.get(owner);
      request.onsuccess = () => {
        const lease = request.result as { expires_at_ms: number } | undefined;
        if (!lease) {
          transaction.abort();
          return;
        }
        store.put({ ...lease, expires_at_ms: 0 });
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Clock test lease expiry aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Clock test lease expiry failed"));
    });
  } finally {
    database.close();
  }
}

async function lockVault(): Promise<number> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    return await lockOwner(database, owner, null);
  } finally {
    database.close();
  }
}

async function lockState(): Promise<{ lockEpoch: number; locked: boolean }> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const snapshot = await readOwnerSnapshot(database, owner, BUILD_ID);
    return { lockEpoch: snapshot.metadata.lock_epoch, locked: snapshot.auth.locked };
  } finally {
    database.close();
  }
}

async function leaseState(): Promise<{ holder_id: string; fencing_token: number; expires_at_ms: number } | null> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["leases"], "readonly");
      const request = transaction.objectStore("leases").get(owner);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("Unable to read the sync lease"));
    });
  } finally {
    database.close();
  }
}

async function fenceLeaseForTest(ttlMs = 5_000): Promise<{ previousToken: number; fencingToken: number }> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000) throw new Error("Test fencing lease duration is invalid");
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["leases"], "readwrite", { durability: "strict" });
      const store = transaction.objectStore("leases");
      const request = store.get(owner);
      let result: { previousToken: number; fencingToken: number } | null = null;
      request.onsuccess = () => {
        const current = request.result as { holder_id: string; fencing_token: number; expires_at_ms: number } | undefined;
        if (!current || !Number.isSafeInteger(current.fencing_token) || current.fencing_token >= Number.MAX_SAFE_INTEGER) {
          transaction.abort();
          return;
        }
        const fencingToken = current.fencing_token + 1;
        result = { previousToken: current.fencing_token, fencingToken };
        store.put({
          ...current,
          holder_id: `test-fence-${crypto.randomUUID()}`,
          fencing_token: fencingToken,
          expires_at_ms: Date.now() + ttlMs,
        });
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => result ? resolve(result) : reject(new Error("Test fencing did not update the lease"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Test fencing transaction aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Test fencing transaction failed"));
    });
  } finally {
    database.close();
  }
}

async function expireFencedLeaseForTest(): Promise<void> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["leases"], "readwrite", { durability: "strict" });
      const store = transaction.objectStore("leases");
      const request = store.get(owner);
      request.onsuccess = () => {
        const current = request.result as { holder_id: string; fencing_token: number; expires_at_ms: number } | undefined;
        if (!current || !current.holder_id.startsWith("test-fence-")) {
          transaction.abort();
          return;
        }
        store.put({ ...current, expires_at_ms: 0 });
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Test lease expiry aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Test lease expiry failed"));
    });
  } finally {
    database.close();
  }
}

async function persistRecoveryJournalForTest(): Promise<{ journalId: UUID; committedRevision: number } | null> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const [snapshot, gate, lease] = await Promise.all([
      readOwnerSnapshot(database, owner, BUILD_ID),
      readBuildGate(database),
      leaseState(),
    ]);
    if (!gate || !lease) throw new Error("Recovery test requires the current build gate and owner leader lease");
    return await persistEpochRecoveryJournal({
      database,
      snapshot,
      gate,
      expectedBuild: BUILD_ID,
      expectedFencingToken: lease.fencing_token,
    });
  } finally {
    database.close();
  }
}

async function stageQuotaProbeForTest(): Promise<{ sessionId: UUID; revision: number }> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const [snapshot, gate, lease] = await Promise.all([
      readOwnerSnapshot(database, owner, BUILD_ID),
      readBuildGate(database),
      leaseState(),
    ]);
    if (!gate || !lease || !snapshot.metadata.server_epoch) throw new Error("Quota staging probe requires an initialized owner and leader lease");
    const records = await readRecordedShadow(snapshot);
    const template = records.find((record) => record.group.operation.commands.length === 1 &&
      record.group.operation.commands[0].action === "milestone.create");
    if (!template) throw new Error("Quota staging probe requires a recorded milestone creation template");
    const templateOperation = template.group.operation;
    const templateCommand = templateOperation.commands[0];
    const data = templateCommand.payload.data as Record<string, unknown>;
    const groups = Array.from({ length: 200 }, (_, index) => {
      const rootId = crypto.randomUUID() as UUID;
      const operationId = crypto.randomUUID() as UUID;
      const operation = {
        ...templateOperation,
        operation_id: operationId,
        device_sequence: (BigInt(templateOperation.device_sequence) + BigInt(index + 1)).toString(),
        dependencies: [],
        edit_time: { ...templateOperation.edit_time, logical: index },
        commands: [{
          ...templateCommand,
          root: { ...templateCommand.root, id: rootId },
          payload: { ...templateCommand.payload, data: {
            ...data,
            title: `quota-stage-${index.toString().padStart(3, "0")}`,
            note: "q".repeat(3_500),
          } },
        }],
      };
      return {
        ...template.group,
        cursor: String(index + 1),
        committed_at: new Date(Date.now() + index).toISOString(),
        operation,
      };
    });
    const page = {
      epoch: snapshot.metadata.server_epoch,
      through_cursor: String(groups.length),
      next_cursor: String(groups.length),
      has_more: false,
      next_page_token: null,
      groups,
    };
    const staged = await stageBootstrapPage({
      database,
      snapshot,
      gate,
      expectedBuild: BUILD_ID,
      expectedFencingToken: lease.fencing_token,
      page,
      usedPageToken: null,
    });
    if (!staged.result.committed) throw new Error(`Quota staging probe lost its owner guard: ${staged.result.reason}`);
    return { sessionId: staged.sessionId, revision: staged.result.revision };
  } finally {
    database.close();
  }
}

async function createQuotaSeedEventForTest(): Promise<{ operationId: UUID; requestHash: string }> {
  const date = new Date().toISOString().slice(0, 10);
  return commitCommands([{
    root: { kind: "milestone", id: crypto.randomUUID() as UUID },
    action: "milestone.create",
    payload: { data: {
      title: "Quota recovery seed",
      date,
      period: null,
      note: "q".repeat(3_500),
      plan_id: null,
      standalone_color_id: "neutral",
      show_in_work_calendar: false,
    } },
    precondition: null,
  }]);
}

async function seedRecoveryDraftForQuotaTest(payloadBytes = 300_000): Promise<string> {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 128_000 || payloadBytes > 1_500_000) {
    throw new Error("Quota recovery draft size is invalid");
  }
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const [snapshot, gate, lease] = await Promise.all([
      readOwnerSnapshot(database, owner, BUILD_ID), readBuildGate(database), leaseState(),
    ]);
    if (!gate || !lease || snapshot.auth.locked || !snapshot.auth.crypto_key) {
      throw new Error("Quota recovery draft requires an unlocked owner and leader lease");
    }
    const recordId = `quota-recovery-${crypto.randomUUID()}`;
    const cipher = await encryptOwnerPayload({
      ownerId: owner,
      store: "drafts",
      recordId,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: { content: "x".repeat(payloadBytes) },
    });
    const result = await commitOwnerChanges({
      database,
      guard: {
        owner_id: owner,
        expected_revision: snapshot.metadata.local_state_revision,
        expected_lock_epoch: snapshot.metadata.lock_epoch,
        expected_generation: snapshot.metadata.sync_generation,
        expected_server_epoch: snapshot.metadata.server_epoch,
        expected_cursor: snapshot.metadata.pull_cursor,
        expected_build: BUILD_ID,
        expected_gate_revision: gate.revision,
        expected_fencing_token: lease.fencing_token,
      },
      writes: [{ store: "drafts", row: {
        id: `${owner}:${recordId}`,
        owner_id: owner,
        record_id: recordId,
        key_id: snapshot.metadata.key_id,
        ...cipher,
      } }],
    });
    if (!result.committed) throw new Error(`Quota recovery draft lost its owner guard: ${result.reason}`);
    return recordId;
  } finally {
    database.close();
  }
}

async function cleanupRecoveryDraftQuotaTest(recordId: string): Promise<void> {
  const owner = await currentOwnerId();
  const database = await openVaultDatabase(BUILD_ID);
  try {
    const [snapshot, gate, lease] = await Promise.all([
      readOwnerSnapshot(database, owner, BUILD_ID), readBuildGate(database), leaseState(),
    ]);
    if (!gate || !lease) throw new Error("Quota recovery draft cleanup requires the build gate and leader lease");
    const result = await commitOwnerChanges({
      database,
      guard: {
        owner_id: owner,
        expected_revision: snapshot.metadata.local_state_revision,
        expected_lock_epoch: snapshot.metadata.lock_epoch,
        expected_generation: snapshot.metadata.sync_generation,
        expected_server_epoch: snapshot.metadata.server_epoch,
        expected_cursor: snapshot.metadata.pull_cursor,
        expected_build: BUILD_ID,
        expected_gate_revision: gate.revision,
        expected_fencing_token: lease.fencing_token,
      },
      writes: [],
      deletes: [{ store: "drafts", id: `${owner}:${recordId}` }],
    });
    if (!result.committed) throw new Error(`Quota recovery draft cleanup lost its owner guard: ${result.reason}`);
  } finally {
    database.close();
  }
}

async function expectQuotaFailureForTest(operation: () => Promise<unknown>): Promise<{ name: string; message: string; causeName: string | null }> {
  try {
    await operation();
    return { name: "unexpected_success", message: "Operation completed without a quota failure", causeName: null };
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : null;
    return {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
      causeName: cause && typeof cause === "object" && "name" in cause && typeof cause.name === "string" ? cause.name : null,
    };
  }
}

async function probeRecoveryJournalQuotaForTest(): Promise<{ name: string; causeName: string | null }> {
  return expectQuotaFailureForTest(async () => {
    if (!await persistRecoveryJournalForTest()) throw new Error("Recovery journal quota probe did not commit");
  });
}

async function probeBootstrapStageQuotaForTest(): Promise<{ name: string; causeName: string | null }> {
  return expectQuotaFailureForTest(() => stageQuotaProbeForTest());
}

type OwnerWriteAbortTarget = "mutation" | "recovery-journal" | "pull-page" | "bootstrap-stage" | "bootstrap-publish" | "recovery-publish";

let ownerWriteAbort: {
  targets: OwnerWriteAbortTarget[];
  injectedTargets: OwnerWriteAbortTarget[];
  originalPut: typeof IDBObjectStore.prototype.put;
} | null = null;

function ownerWriteMatches(target: OwnerWriteAbortTarget, stores: string[]): boolean {
  if (target === "mutation") return stores.includes("outbox") && stores.includes("projection");
  if (target === "recovery-journal") return stores.includes("journal");
  if (target === "pull-page") return stores.includes("shadow") && stores.includes("projection") && !stores.includes("staging") && !stores.includes("journal");
  if (target === "bootstrap-stage") return stores.includes("staging") && !stores.includes("shadow") && !stores.includes("journal");
  if (target === "bootstrap-publish") return stores.includes("staging") && stores.includes("shadow") && !stores.includes("journal");
  return stores.includes("staging") && stores.includes("shadow") && stores.includes("journal");
}

function armOwnerWriteAbortForTest(target: OwnerWriteAbortTarget | readonly OwnerWriteAbortTarget[]): void {
  if (ownerWriteAbort) throw new Error("An owner transaction abort hook is already armed");
  const prototype = IDBObjectStore.prototype;
  const originalPut = prototype.put;
  const targets = typeof target === "string" ? [target] : [...target];
  if (targets.length === 0) throw new Error("At least one owner transaction abort target is required");
  ownerWriteAbort = { targets, injectedTargets: [], originalPut };
  Object.defineProperty(prototype, "put", {
    configurable: true,
    writable: true,
    value: function (this: IDBObjectStore, ...args: unknown[]) {
      const request = Reflect.apply(originalPut, this, args) as IDBRequest;
      const stores = Array.from(this.transaction.objectStoreNames);
      const row = args[0] as { local_state_revision?: unknown } | undefined;
      const nextTarget = ownerWriteAbort?.targets[ownerWriteAbort.injectedTargets.length];
      if (this.name === "owner_meta" && ownerWriteAbort && nextTarget &&
          ownerWriteMatches(nextTarget, stores) && Number.isSafeInteger(row?.local_state_revision)) {
        ownerWriteAbort.injectedTargets.push(nextTarget);
        this.transaction.abort();
        window.dispatchEvent(new CustomEvent("dayforge:test-owner-transaction-aborted", {
          detail: { target: nextTarget },
        }));
        if (nextTarget === "bootstrap-stage" || nextTarget === "recovery-publish") {
          queueMicrotask(() => { void window.__dayforgeSyncBrowserHarness?.stopSync(); });
        }
      }
      return request;
    },
  });
}

function ownerWriteAbortStateForTest(): { targets: OwnerWriteAbortTarget[]; injectedTargets: OwnerWriteAbortTarget[] } | null {
  if (!ownerWriteAbort) return null;
  return { targets: [...ownerWriteAbort.targets], injectedTargets: [...ownerWriteAbort.injectedTargets] };
}

function disarmOwnerWriteAbortForTest(): OwnerWriteAbortTarget[] {
  if (!ownerWriteAbort) return [];
  const injected = [...ownerWriteAbort.injectedTargets];
  IDBObjectStore.prototype.put = ownerWriteAbort.originalPut;
  ownerWriteAbort = null;
  return injected;
}

async function abortNextOwnerWriteForTest(operation: "mutation" | "recovery-journal"): Promise<never> {
  armOwnerWriteAbortForTest(operation);
  let failure: unknown;
  try {
    if (operation === "mutation") await createPlan(`abort-${crypto.randomUUID()}`);
    else await persistRecoveryJournalForTest();
  } catch (error) {
    failure = error;
  } finally {
    const injected = disarmOwnerWriteAbortForTest();
    if (injected.length !== 1 || injected[0] !== operation) {
      throw new Error("The owner transaction abort test hook did not reach its target write");
    }
  }
  if (failure === undefined) throw new Error("The owner write unexpectedly completed despite the injected transaction abort");
  throw failure;
}

declare global {
  interface Window {
    __dayforgeSyncTestAbortOnReady?: OwnerWriteAbortTarget;
    __dayforgeSyncBrowserHarness?: {
      inspect(dates?: string[]): ReturnType<typeof inspect>;
      createPlan(name: string, clockOffsetMs?: number): ReturnType<typeof createPlan>;
      replacePlan(planId: UUID, name: string, dependencyId: UUID): ReturnType<typeof replacePlan>;
      createWorkItem(planId: UUID, dependencyId: UUID): ReturnType<typeof createWorkItem>;
      deleteWorkItem(workItemId: UUID, dependencyId: UUID): ReturnType<typeof deleteWorkItem>;
      createRecurringTask(input: Parameters<typeof createRecurringTask>[0]): ReturnType<typeof createRecurringTask>;
      replaceOccurrence(input: Parameters<typeof replaceOccurrence>[0]): ReturnType<typeof replaceOccurrence>;
      editSeriesFuture(input: Parameters<typeof editSeriesFuture>[0]): ReturnType<typeof editSeriesFuture>;
      stopSeriesFuture(input: Parameters<typeof stopSeriesFuture>[0]): ReturnType<typeof stopSeriesFuture>;
      undoWorkItemOperation(input: Parameters<typeof undoWorkItemOperation>[0]): ReturnType<typeof undoWorkItemOperation>;
      setClockOffsetForTest(offsetMs: number): void;
      expireClockCalibrationForTest(): ReturnType<typeof expireClockCalibrationForTest>;
      expireLeaseForClockTest(): ReturnType<typeof expireLeaseForClockTest>;
      repairClockIssues(): Promise<void>;
      lockVault(): ReturnType<typeof lockVault>;
      lockState(): ReturnType<typeof lockState>;
      leaseState(): ReturnType<typeof leaseState>;
      fenceLeaseForTest(ttlMs?: number): ReturnType<typeof fenceLeaseForTest>;
      expireFencedLeaseForTest(): ReturnType<typeof expireFencedLeaseForTest>;
      persistRecoveryJournalForTest(): ReturnType<typeof persistRecoveryJournalForTest>;
      stageQuotaProbeForTest(): ReturnType<typeof stageQuotaProbeForTest>;
      createQuotaSeedEventForTest(): ReturnType<typeof createQuotaSeedEventForTest>;
      seedRecoveryDraftForQuotaTest(payloadBytes?: number): ReturnType<typeof seedRecoveryDraftForQuotaTest>;
      cleanupRecoveryDraftQuotaTest(recordId: string): ReturnType<typeof cleanupRecoveryDraftQuotaTest>;
      probeRecoveryJournalQuotaForTest(): ReturnType<typeof probeRecoveryJournalQuotaForTest>;
      probeBootstrapStageQuotaForTest(): ReturnType<typeof probeBootstrapStageQuotaForTest>;
      abortNextOwnerWriteForTest(operation: "mutation" | "recovery-journal"): ReturnType<typeof abortNextOwnerWriteForTest>;
      armOwnerWriteAbortForTest(target: OwnerWriteAbortTarget | readonly OwnerWriteAbortTarget[]): void;
      ownerWriteAbortStateForTest(): ReturnType<typeof ownerWriteAbortStateForTest>;
      disarmOwnerWriteAbortForTest(): OwnerWriteAbortTarget[];
      wakeSync(): boolean;
      stopSync(): Promise<void>;
      coordinatorState(): CoordinatorStatus["state"];
      coordinatorDetails(): CoordinatorStatus;
    };
  }
}

export function SyncBrowserHarness(): React.JSX.Element {
  const account = useAccount();
  const { coordinatorStatus, repairClockIssues, stopSync, wakeSync } = account;
  useLayoutEffect(() => {
    window.__dayforgeSyncBrowserHarness = {
      inspect,
      createPlan,
      replacePlan,
      createWorkItem,
      deleteWorkItem,
      createRecurringTask,
      replaceOccurrence,
      editSeriesFuture,
      stopSeriesFuture,
      undoWorkItemOperation,
      setClockOffsetForTest,
      expireClockCalibrationForTest,
      expireLeaseForClockTest,
      repairClockIssues,
      lockVault,
      lockState,
      leaseState,
      fenceLeaseForTest,
      expireFencedLeaseForTest,
      persistRecoveryJournalForTest,
      stageQuotaProbeForTest,
      createQuotaSeedEventForTest,
      seedRecoveryDraftForQuotaTest,
      cleanupRecoveryDraftQuotaTest,
      probeRecoveryJournalQuotaForTest,
      probeBootstrapStageQuotaForTest,
      abortNextOwnerWriteForTest,
      armOwnerWriteAbortForTest,
      ownerWriteAbortStateForTest,
      disarmOwnerWriteAbortForTest,
      wakeSync,
      stopSync,
      coordinatorState: () => coordinatorStatus().state,
      coordinatorDetails: coordinatorStatus,
    };
    const abortTarget = window.__dayforgeSyncTestAbortOnReady;
    if (abortTarget) {
      delete window.__dayforgeSyncTestAbortOnReady;
      armOwnerWriteAbortForTest(abortTarget);
    }
    window.dispatchEvent(new CustomEvent("dayforge:sync-test-harness-ready"));
    return () => { delete window.__dayforgeSyncBrowserHarness; };
  }, [coordinatorStatus, repairClockIssues, stopSync, wakeSync]);

  return <main><p role="status">Test sync harness sẵn sàng.</p></main>;
}
