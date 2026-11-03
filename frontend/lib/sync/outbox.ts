import {
  assertOperationEnvelope,
  compareOperations,
  hashOperation,
  type EditTime,
  type Operation,
  type SyncCommand,
  type UUID,
} from "./protocol";
import type { PushResponse } from "../../services/sync";
import { calibratedEditTime } from "./calibration";
import {
  commitOwnerChanges,
  decryptOwnerPayload,
  encryptOwnerPayload,
  type BuildGate,
  type EncryptedOwnerRow,
  type OwnerCommitResult,
  type OwnerSnapshot,
} from "../storage/vault";

export type OutboxState = "queued" | "sending" | "blocked" | "ack_waiting_pull" | "quarantined";

export interface OutboxReceipt {
  commit_cursor: string;
  effect_at_commit: "applied" | "superseded" | "no_op";
  reason_at_commit: string | null;
}

export interface StoredOutboxEnvelope {
  operation: Operation;
  request_hash: string;
  state: OutboxState;
  ever_recorded: boolean;
  commit_uncertain: boolean;
  attempts: number;
  next_attempt_at_ms: number | null;
  superseded_by: UUID | null;
  receipt: OutboxReceipt | null;
  problem_code: string | null;
}

export interface ActiveOutboxEntry extends StoredOutboxEnvelope {
  row: EncryptedOwnerRow;
}

export interface LocalOperationInput {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  operation: Operation;
  projectionWrites: readonly EncryptedOwnerRow[];
}

export interface LocalOperationDraft {
  commands: readonly SyncCommand[];
  dependencies?: readonly UUID[];
  editTime?: EditTime;
  operationId?: UUID;
}

const UINT64_MAX = BigInt("18446744073709551615");

function assertEnvelopeState(value: unknown): asserts value is StoredOutboxEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored outbox entry is invalid");
  const entry = value as Partial<StoredOutboxEnvelope>;
  if (!entry.operation || !["queued", "sending", "blocked", "ack_waiting_pull", "quarantined"].includes(String(entry.state)) ||
      typeof entry.request_hash !== "string" || !/^[0-9a-f]{64}$/.test(entry.request_hash) ||
      typeof entry.ever_recorded !== "boolean" || typeof entry.commit_uncertain !== "boolean" ||
      !Number.isSafeInteger(entry.attempts) || (entry.attempts as number) < 0 ||
      !(entry.next_attempt_at_ms === null || (Number.isSafeInteger(entry.next_attempt_at_ms) && (entry.next_attempt_at_ms as number) >= 0)) ||
      !(entry.superseded_by === null || (typeof entry.superseded_by === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.superseded_by))) ||
      !(entry.receipt === null || (typeof entry.receipt === "object" &&
        typeof entry.receipt.commit_cursor === "string" && /^(0|[1-9][0-9]*)$/.test(entry.receipt.commit_cursor) &&
        entry.receipt.commit_cursor.length <= 20 && BigInt(entry.receipt.commit_cursor) <= UINT64_MAX &&
        ["applied", "superseded", "no_op"].includes(entry.receipt.effect_at_commit) &&
        (entry.receipt.reason_at_commit === null || typeof entry.receipt.reason_at_commit === "string"))) ||
      !(entry.problem_code === null || typeof entry.problem_code === "string")) {
    throw new Error("Stored outbox metadata is invalid");
  }
  assertOperationEnvelope(entry.operation);
}

/** In-memory compatibility adapter for rows written before T12 recorded uncertainty flags. */
export function normalizeOutboxEnvelope(value: unknown): StoredOutboxEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored outbox entry is invalid");
  const entry = value as Partial<StoredOutboxEnvelope>;
  const normalized = {
    ...entry,
    ever_recorded: typeof entry.ever_recorded === "boolean" ? entry.ever_recorded :
      entry.state === "ack_waiting_pull" || (entry.receipt !== null && entry.receipt !== undefined),
    commit_uncertain: typeof entry.commit_uncertain === "boolean" ? entry.commit_uncertain : entry.state === "sending",
  };
  assertEnvelopeState(normalized);
  return normalized;
}

function assertRowMetadata(row: EncryptedOwnerRow, envelope: StoredOutboxEnvelope): void {
  if (row.record_id !== envelope.operation.operation_id || row.state !== envelope.state ||
      row.request_hash !== envelope.request_hash || row.superseded_by !== envelope.superseded_by) {
    throw new Error(`Outbox index metadata does not match encrypted entry ${envelope.operation.operation_id}`);
  }
}

function nextSequence(current: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(current) || current.length > 20) throw new Error("Stored device sequence is invalid");
  const next = BigInt(current) + 1n;
  if (next > UINT64_MAX) throw new Error("Device sequence exhausted; a new device lane is required");
  return next.toString();
}

function maxHlc(current: OwnerSnapshot["metadata"]["local_hlc"], next: EditTime): OwnerSnapshot["metadata"]["local_hlc"] {
  if (!current || next.physical_ms > current.physical_ms ||
      (next.physical_ms === current.physical_ms && next.logical > current.logical)) {
    return { physical_ms: next.physical_ms, logical: next.logical };
  }
  return current;
}

export function prepareLocalOperation(snapshot: OwnerSnapshot, draft: LocalOperationDraft): Operation {
  const editTime = draft.editTime ?? calibratedEditTime({
    calibration: snapshot.metadata.clock_calibration,
    local: snapshot.metadata.local_hlc,
    observed: snapshot.metadata.observed_hlc,
  });
  const operation: Operation = {
    protocol_version: 1,
    reducer_version: 1,
    operation_id: draft.operationId ?? crypto.randomUUID(),
    owner_id: snapshot.metadata.owner_id,
    device_id: snapshot.metadata.device_id,
    device_sequence: nextSequence(snapshot.metadata.device_sequence),
    edit_time: editTime,
    dependencies: [...(draft.dependencies ?? [])],
    commands: [...draft.commands],
  };
  assertOperationEnvelope(operation);
  return operation;
}

/**
 * Persist an immutable operation before it can be sent. The sequence and observed
 * HLC advance in the same owner revision as the encrypted outbox row.
 */
export async function persistLocalOperation(input: LocalOperationInput): Promise<{
  operation: Operation;
  requestHash: string;
  result: OwnerCommitResult;
}> {
  const { snapshot, gate } = input;
  if (snapshot.auth.locked || !snapshot.auth.crypto_key || snapshot.auth.lock_epoch !== snapshot.metadata.lock_epoch) {
    throw new Error("Local operation requires the unlocked owner vault");
  }
  if (gate.phase !== "running" || gate.approved_build !== input.expectedBuild) {
    throw new Error("Current build is not approved to create local operations");
  }
  if (input.projectionWrites.length === 0) throw new Error("A local operation must commit its resulting projection atomically");
  if (new Set(input.projectionWrites.map((row) => row.id)).size !== input.projectionWrites.length) {
    throw new Error("Prepared projection writes contain duplicate record ids");
  }
  for (const row of input.projectionWrites) {
    if (row.owner_id !== snapshot.metadata.owner_id || row.id !== `${snapshot.metadata.owner_id}:${row.record_id}` ||
        row.key_id !== snapshot.metadata.key_id || row.iv.byteLength !== 12 || row.ciphertext.byteLength < 16) {
      throw new Error("Prepared projection write has an invalid owner, key, or ciphertext");
    }
  }
  const operation = input.operation;
  assertOperationEnvelope(operation);
  if (operation.owner_id !== snapshot.metadata.owner_id || operation.device_id !== snapshot.metadata.device_id ||
      operation.device_sequence !== nextSequence(snapshot.metadata.device_sequence)) {
    throw new Error("Prepared local operation does not match the current owner device sequence");
  }
  const priorEntries = await readActiveOutbox(snapshot);
  const clockQuarantinedIds = new Set(priorEntries
    .filter((entry) => entry.state === "quarantined" || entry.commit_uncertain)
    .map((entry) => entry.operation.operation_id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const entry of priorEntries) {
      if (clockQuarantinedIds.has(entry.operation.operation_id)) continue;
      if (entry.operation.dependencies.some((dependency) => clockQuarantinedIds.has(dependency))) {
        clockQuarantinedIds.add(entry.operation.operation_id);
        expanded = true;
      }
    }
  }
  const clockRecoveryPending = priorEntries.some((entry) => entry.state === "quarantined" &&
    (entry.problem_code === "time_invalid" || entry.problem_code?.startsWith("clock_") === true));
  const clockQuarantined = operation.edit_time.quality === "untrusted" ||
    clockRecoveryPending || operation.dependencies.some((dependency) => clockQuarantinedIds.has(dependency));
  const requestHash = await hashOperation(operation);
  const envelope: StoredOutboxEnvelope = {
    operation,
    request_hash: requestHash,
    state: clockQuarantined ? "quarantined" : "queued",
    ever_recorded: false,
    commit_uncertain: false,
    attempts: 0,
    next_attempt_at_ms: null,
    superseded_by: null,
    receipt: null,
    problem_code: clockQuarantined
      ? operation.edit_time.quality === "untrusted" ? "clock_untrusted" :
        clockRecoveryPending ? "clock_recovery_required" : "clock_dependency_quarantined"
      : null,
  };
  const recordId = operation.operation_id;
  const cipher = await encryptOwnerPayload({
    ownerId: operation.owner_id,
    store: "outbox",
    recordId,
    keyId: snapshot.metadata.key_id,
    key: snapshot.auth.crypto_key,
    payload: envelope,
  });
  const row: EncryptedOwnerRow = {
    id: `${operation.owner_id}:${recordId}`,
    owner_id: operation.owner_id,
    record_id: recordId,
    key_id: snapshot.metadata.key_id,
    ...cipher,
    state: envelope.state,
    request_hash: requestHash,
    superseded_by: null,
    created_at_ms: Date.now(),
  };
  const result = await commitOwnerChanges({
    database: input.database,
    guard: {
      owner_id: operation.owner_id,
      expected_revision: snapshot.metadata.local_state_revision,
      expected_lock_epoch: snapshot.metadata.lock_epoch,
      expected_generation: snapshot.metadata.sync_generation,
      expected_server_epoch: snapshot.metadata.server_epoch,
      expected_cursor: snapshot.metadata.pull_cursor,
      expected_build: input.expectedBuild,
      expected_gate_revision: gate.revision,
    },
    writes: [
      ...input.projectionWrites.map((projectionRow) => ({ store: "projection" as const, row: projectionRow })),
      { store: "outbox" as const, row },
    ],
    metadataPatch: {
      device_sequence: operation.device_sequence,
      ...(operation.edit_time.quality === "untrusted" ? {} : { local_hlc: maxHlc(snapshot.metadata.local_hlc, operation.edit_time) }),
    },
  });
  return { operation, requestHash, result };
}

/** Decrypt and integrity-check the outbox snapshot; diagnostics are never selected here. */
export async function readActiveOutbox(snapshot: OwnerSnapshot): Promise<ActiveOutboxEntry[]> {
  if (snapshot.auth.locked || !snapshot.auth.crypto_key) throw new Error("Outbox requires the unlocked owner vault");
  const entries: ActiveOutboxEntry[] = [];
  for (const row of snapshot.outbox) {
    if (row.owner_id !== snapshot.metadata.owner_id) throw new Error("Outbox contains another owner's row");
    if (row.key_id !== snapshot.metadata.key_id) throw new Error("Outbox row uses an unexpected vault key id");
    const decrypted = await decryptOwnerPayload<unknown>({
      ownerId: snapshot.metadata.owner_id,
      store: "outbox",
      recordId: row.record_id,
      row,
      key: snapshot.auth.crypto_key,
    });
    const envelope = normalizeOutboxEnvelope(decrypted);
    if (envelope.operation.owner_id !== snapshot.metadata.owner_id) throw new Error("Outbox operation owner mismatch");
    assertRowMetadata(row, envelope);
    if (await hashOperation(envelope.operation) !== envelope.request_hash) {
      throw new Error(`Stored operation hash mismatch: ${envelope.operation.operation_id}`);
    }
    if (!envelope.superseded_by) entries.push({ ...envelope, row });
  }
  return entries.sort((left, right) => compareOperations(left.operation, right.operation));
}

export function countPendingOperations(entries: readonly ActiveOutboxEntry[]): number {
  return entries.filter((entry) => entry.state !== "ack_waiting_pull").length;
}

export function preparePushUpdates(entries: readonly ActiveOutboxEntry[], operationIds: readonly UUID[], nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Push schedule time is invalid");
  const byId = new Map(entries.map((entry) => [entry.operation.operation_id, entry]));
  return operationIds.map((operationId) => {
    const entry = byId.get(operationId);
    if (!entry) throw new Error(`Cannot send an operation outside the active outbox: ${operationId}`);
    if (entry.state === "blocked" || entry.state === "quarantined" || entry.state === "ack_waiting_pull") {
      throw new Error(`Outbox operation is not sendable in state ${entry.state}`);
    }
    if (entry.next_attempt_at_ms !== null && entry.next_attempt_at_ms > nowMs) {
      throw new Error(`Outbox operation is not ready to retry: ${operationId}`);
    }
    return {
      operationId,
      patch: {
        state: "sending" as const,
        attempts: entry.attempts + 1,
        next_attempt_at_ms: null,
        problem_code: null,
      },
    };
  });
}

/** ACK never advances the pull cursor or edits shadow; it only records the exact receipt. */
export function preparePushResponseUpdates(
  entries: readonly ActiveOutboxEntry[],
  sentOperations: readonly Operation[],
  response: PushResponse,
  nowMs = Date.now(),
) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Push response schedule time is invalid");
  const byId = new Map(entries.map((entry) => [entry.operation.operation_id, entry]));
  if (response.results.length !== sentOperations.length) throw new Error("Push response cardinality changed after validation");
  return response.results.map((result, index) => {
    const operation = sentOperations[index];
    if (result.operation_id !== operation.operation_id) throw new Error("Push response is not in the sent operation order");
    const entry = byId.get(operation.operation_id);
    if (!entry || entry.request_hash !== ("receipt" in result ? result.receipt.request_hash : entry.request_hash)) {
      throw new Error(`Push response does not match active outbox ${operation.operation_id}`);
    }
    if (!("problem" in result)) {
      if (result.receipt.request_hash !== entry.request_hash) throw new Error("Push receipt hash does not match the immutable outbox operation");
      return {
        operationId: operation.operation_id,
        patch: {
          state: "ack_waiting_pull" as const,
          receipt: {
            commit_cursor: result.receipt.commit_cursor,
            effect_at_commit: result.receipt.effect_at_commit,
            reason_at_commit: result.receipt.reason_at_commit,
          },
          ever_recorded: true,
          commit_uncertain: false,
          problem_code: null,
        },
      };
    }
    if (result.status === "deferred" && result.problem.retryable) {
      const delay = Math.max(1_000, (result.problem.retry_after_seconds ?? 1) * 1_000);
      return {
        operationId: operation.operation_id,
        patch: {
          state: "queued" as const,
          next_attempt_at_ms: Math.min(Number.MAX_SAFE_INTEGER, nowMs + delay),
          commit_uncertain: false,
          problem_code: result.problem.code,
        },
      };
    }
    return {
      operationId: operation.operation_id,
      patch: {
        state: result.problem.code === "time_invalid" || result.problem.code === "operation_id_reused"
          ? "quarantined" as const
          : "blocked" as const,
        next_attempt_at_ms: null,
        commit_uncertain: result.problem.code === "operation_id_reused",
        problem_code: result.problem.code,
      },
    };
  });
}

export async function acknowledgePushResponse(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  sentOperations: readonly Operation[];
  response: PushResponse;
}): Promise<OwnerCommitResult> {
  if (input.snapshot.metadata.server_epoch !== input.response.epoch) {
    throw new Error("Push response belongs to a different server epoch; bootstrap/recovery is required");
  }
  const entries = await readActiveOutbox(input.snapshot);
  const updates = preparePushResponseUpdates(entries, input.sentOperations, input.response);
  return updateOutboxEntries({
    database: input.database,
    snapshot: input.snapshot,
    gate: input.gate,
    expectedBuild: input.expectedBuild,
    expectedFencingToken: input.expectedFencingToken,
    updates,
  });
}

/** Change queue metadata and encrypted state under the same revision/fencing guard. */
export async function updateOutboxEntries(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  updates: ReadonlyArray<{ operationId: UUID; patch: Partial<Omit<StoredOutboxEnvelope, "operation" | "request_hash">> }>;
}): Promise<OwnerCommitResult> {
  if (input.snapshot.auth.locked || !input.snapshot.auth.crypto_key) throw new Error("Outbox update requires the unlocked owner vault");
  if (input.updates.length === 0 || new Set(input.updates.map((update) => update.operationId)).size !== input.updates.length) {
    throw new Error("Outbox updates must contain unique operation ids");
  }
  const writes: Array<{ store: "outbox"; row: EncryptedOwnerRow }> = [];
  for (const update of input.updates) {
    const oldRow = input.snapshot.outbox.find((candidate) => candidate.record_id === update.operationId);
    if (!oldRow) throw new Error(`Outbox operation is missing: ${update.operationId}`);
    if (oldRow.key_id !== input.snapshot.metadata.key_id) throw new Error("Outbox row uses an unexpected vault key id");
    const decrypted = await decryptOwnerPayload<unknown>({
      ownerId: input.snapshot.metadata.owner_id,
      store: "outbox",
      recordId: oldRow.record_id,
      row: oldRow,
      key: input.snapshot.auth.crypto_key,
    });
    const oldEnvelope = normalizeOutboxEnvelope(decrypted);
    assertRowMetadata(oldRow, oldEnvelope);
    const nextEnvelope = { ...oldEnvelope, ...update.patch };
    assertEnvelopeState(nextEnvelope);
    const cipher = await encryptOwnerPayload({
      ownerId: input.snapshot.metadata.owner_id,
      store: "outbox",
      recordId: oldRow.record_id,
      keyId: input.snapshot.metadata.key_id,
      key: input.snapshot.auth.crypto_key,
      payload: nextEnvelope,
    });
    writes.push({
      store: "outbox",
      row: {
        ...oldRow,
        ...cipher,
        state: nextEnvelope.state,
        request_hash: nextEnvelope.request_hash,
        superseded_by: nextEnvelope.superseded_by,
      },
    });
  }
  return commitOwnerChanges({
    database: input.database,
    guard: {
      owner_id: input.snapshot.metadata.owner_id,
      expected_revision: input.snapshot.metadata.local_state_revision,
      expected_lock_epoch: input.snapshot.metadata.lock_epoch,
      expected_generation: input.snapshot.metadata.sync_generation,
      expected_server_epoch: input.snapshot.metadata.server_epoch,
      expected_cursor: input.snapshot.metadata.pull_cursor,
      expected_build: input.expectedBuild,
      expected_gate_revision: input.gate.revision,
      expected_fencing_token: input.expectedFencingToken,
    },
    writes,
  });
}
