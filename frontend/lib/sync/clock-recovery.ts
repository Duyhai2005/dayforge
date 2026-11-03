import {
  assertOperationEnvelope,
  canonicalizeJson,
  compareOperations,
  hashOperation,
  type EditTime,
  type Operation,
  type UUID,
} from "./protocol";
import {
  commitOwnerChanges,
  decryptOwnerPayload,
  encryptOwnerPayload,
  type BuildGate,
  type EncryptedOwnerRow,
  type OwnerCommitResult,
  type OwnerSnapshot,
} from "../storage/vault";
import { encryptProjectionRows, readRecordedShadow, rebuildOwnerProjection } from "./projection";
import { readActiveOutbox, type StoredOutboxEnvelope } from "./outbox";
import {
  bucketOrderHash,
  operationPreconditionsMatch,
  replayOperations,
  semanticRootHash,
  type Period,
} from "./reducer";
import { calibratedEditTime, ownerNeedsClockCalibration } from "./calibration";

const SEGMENT_CREATORS = new Set(["work_item.create_recurrence", "work_item.enable_recurrence", "series.edit_future"]);
const ROOT_HASH_TOKEN = "<recomputed-root-hash>";
const BUCKET_HASH_TOKEN = "<recomputed-bucket-hash>";
type PersistedClockCalibration = NonNullable<OwnerSnapshot["metadata"]["clock_calibration"]>;

export class ClockRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = "ClockRecoveryError"; }
}

function uuidBytes(id: UUID): Uint8Array {
  return new Uint8Array(id.replaceAll("-", "").match(/.{2}/g)!.map((value) => Number.parseInt(value, 16)));
}

async function uuidV5(namespace: UUID, name: string): Promise<UUID> {
  const nameBytes = new TextEncoder().encode(name);
  const base = uuidBytes(namespace);
  const input = new Uint8Array(base.length + nameBytes.length);
  input.set(base);
  input.set(nameBytes, base.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapPayloadReference(value: unknown, key: string, operationIds: ReadonlyMap<UUID, UUID>, segmentIds: ReadonlyMap<UUID, UUID>): unknown {
  if (typeof value === "string") {
    if (key === "original_operation_id") return operationIds.get(value as UUID) ?? value;
    if (key === "source_segment_id" || key === "segment_id") return segmentIds.get(value as UUID) ?? value;
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => mapPayloadReference(child, "", operationIds, segmentIds));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      mapPayloadReference(child, childKey, operationIds, segmentIds),
    ]));
  }
  return value;
}

function normalizePrecondition(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = structuredClone(value) as Record<string, unknown>;
  if (typeof normalized.expected_root_hash === "string") normalized.expected_root_hash = ROOT_HASH_TOKEN;
  if (normalized.expected_bucket && typeof normalized.expected_bucket === "object" && !Array.isArray(normalized.expected_bucket)) {
    const bucket = normalized.expected_bucket as Record<string, unknown>;
    if (typeof bucket.order_hash === "string") bucket.order_hash = BUCKET_HASH_TOKEN;
  }
  return normalized;
}

function mapProjectionReferences(
  value: unknown,
  key: string,
  operationIds: ReadonlyMap<UUID, UUID>,
  segmentIds: ReadonlyMap<UUID, UUID>,
): unknown {
  if (typeof value === "string") {
    if (key === "created_by_operation_id") return operationIds.get(value as UUID) ?? value;
    if (key === "segment_id" || key === "source_segment_id") return segmentIds.get(value as UUID) ?? value;
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => mapProjectionReferences(child, "", operationIds, segmentIds));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      mapProjectionReferences(child, childKey, operationIds, segmentIds),
    ]));
  }
  return value;
}

async function referenceMaps(
  originals: readonly Operation[],
  replacements: ReadonlyMap<UUID, Operation>,
): Promise<{ operationIds: Map<UUID, UUID>; segmentIds: Map<UUID, UUID> }> {
  const operationIds = new Map<UUID, UUID>();
  const segmentIds = new Map<UUID, UUID>();
  for (const original of originals) {
    const replacement = replacements.get(original.operation_id);
    if (!replacement) throw new ClockRecoveryError(`Missing replacement for ${original.operation_id}`);
    if (operationIds.has(original.operation_id)) throw new ClockRecoveryError("A clock recovery chain contains duplicate source operation ids");
    operationIds.set(original.operation_id, replacement.operation_id);
    for (const [index, command] of original.commands.entries()) {
      if (!SEGMENT_CREATORS.has(command.action) || command.root.kind !== "work_item") continue;
      const oldId = await uuidV5(command.root.id, `segment:${original.operation_id}:${index}`);
      const newId = await uuidV5(command.root.id, `segment:${replacement.operation_id}:${index}`);
      segmentIds.set(oldId, newId);
    }
  }
  return { operationIds, segmentIds };
}

function maxHlc(left: OwnerSnapshot["metadata"]["observed_hlc"], right: OwnerSnapshot["metadata"]["observed_hlc"]): OwnerSnapshot["metadata"]["observed_hlc"] {
  if (!left) return right;
  if (!right) return left;
  if (right.physical_ms > left.physical_ms || (right.physical_ms === left.physical_ms && right.logical > left.logical)) return right;
  return left;
}

function laterHlc(left: EditTime | null, right: EditTime | OwnerSnapshot["metadata"]["observed_hlc"]): EditTime | null {
  if (!right) return left;
  if (!left || right.physical_ms > left.physical_ms ||
      (right.physical_ms === left.physical_ms && right.logical > left.logical)) {
    return {
      physical_ms: right.physical_ms,
      logical: right.logical,
      calibration_id: "00000000-0000-4000-8000-000000000000",
      raw_wall_ms: right.physical_ms,
      quality: "calibrated",
    };
  }
  return left;
}

/** Prepare an intent-preserving replacement chain after the user has repaired device time. */
export async function prepareClockReauthorBatch(input: {
  snapshot: OwnerSnapshot;
  sourceOperations: readonly Operation[];
  newDeviceId?: UUID;
  clockCalibration?: PersistedClockCalibration;
}): Promise<{ newDeviceId: UUID; replacements: Map<UUID, Operation> }> {
  if (input.snapshot.auth.locked || !input.snapshot.auth.crypto_key) {
    throw new ClockRecoveryError("Clock recovery requires the unlocked owner vault");
  }
  const calibration = input.clockCalibration ?? input.snapshot.metadata.clock_calibration;
  if (!calibration || (!input.clockCalibration && ownerNeedsClockCalibration(input.snapshot))) {
    throw new ClockRecoveryError("A fresh trusted clock calibration is required before reauthoring");
  }
  const originals = [...input.sourceOperations].sort(compareOperations);
  if (originals.length === 0 || new Set(originals.map((operation) => operation.operation_id)).size !== originals.length) {
    throw new ClockRecoveryError("Clock recovery requires a nonempty operation chain without duplicates");
  }
  const newDeviceId = input.newDeviceId ?? crypto.randomUUID();
  if (newDeviceId === input.snapshot.metadata.device_id) {
    throw new ClockRecoveryError("Clock recovery requires a new device lane");
  }

  const before = await rebuildOwnerProjection({ snapshot: input.snapshot });
  const sourceIds = new Set(originals.map((operation) => operation.operation_id));
  const knownOperations = new Map(before.operations.map((operation) => [operation.operation_id, operation]));
  const operationIds = new Map<UUID, UUID>();
  for (const original of originals) {
    let replacementId = crypto.randomUUID();
    while (knownOperations.has(replacementId) || [...operationIds.values()].includes(replacementId)) {
      replacementId = crypto.randomUUID();
    }
    operationIds.set(original.operation_id, replacementId);
  }
  const stubs = new Map<UUID, Operation>(originals.map((operation) => [operation.operation_id, {
    ...operation,
    operation_id: operationIds.get(operation.operation_id)!,
  }]));
  const references = await referenceMaps(originals, stubs);
  const recorded = await readRecordedShadow(input.snapshot);
  const recordedHlc = recorded.reduce<OwnerSnapshot["metadata"]["observed_hlc"]>(
    (current, { group }) => maxHlc(current, group.operation.edit_time), null,
  );
  let previousHlc: EditTime | null = laterHlc(null, maxHlc(input.snapshot.metadata.observed_hlc, recordedHlc));
  const replacements = new Map<UUID, Operation>();
  for (let index = 0; index < originals.length; index += 1) {
    const original = originals[index];
    let dependencyHlc = previousHlc;
    for (const dependencyId of original.dependencies) {
      const selectedDependency = replacements.get(dependencyId);
      const originalDependency = knownOperations.get(dependencyId);
      const dependency = selectedDependency ?? originalDependency;
      if (!dependency) throw new ClockRecoveryError(`Clock recovery dependency is unavailable: ${dependencyId}`);
      dependencyHlc = laterHlc(dependencyHlc, dependency.edit_time);
    }
    const editTime = calibratedEditTime({
      calibration,
      local: dependencyHlc,
      observed: previousHlc,
    });
    if (editTime.quality !== "calibrated") {
      throw new ClockRecoveryError("Device clock still cannot be trusted; reconnect and calibrate it again");
    }
    const replacement: Operation = {
      ...original,
      operation_id: operationIds.get(original.operation_id)!,
      device_id: newDeviceId,
      device_sequence: String(index + 1),
      edit_time: editTime,
      dependencies: original.dependencies.map((dependency) => references.operationIds.get(dependency) ?? dependency),
      commands: original.commands.map((command) => ({
        ...structuredClone(command),
        payload: mapPayloadReference(command.payload, "", references.operationIds, references.segmentIds) as Record<string, unknown>,
      })),
    };
    replacements.set(original.operation_id, replacement);
    previousHlc = editTime;
  }

  const baseline = before.operations.filter((operation) => !sourceIds.has(operation.operation_id));
  const staged: Operation[] = [];
  for (const original of originals) {
    const replacement = replacements.get(original.operation_id)!;
    const prior = [
      ...baseline.filter((operation) => compareOperations(operation, replacement) < 0),
      ...staged.filter((operation) => compareOperations(operation, replacement) < 0),
    ].sort(compareOperations);
    const state = (await replayOperations(prior, input.snapshot.metadata.owner_id)).state;
    for (const [index, command] of replacement.commands.entries()) {
      const originalPrecondition = original.commands[index].precondition;
      if (originalPrecondition === null) {
        command.precondition = null;
        continue;
      }
      const precondition = structuredClone(originalPrecondition);
      if (Object.hasOwn(precondition, "expected_root_hash")) {
        const rootKey = `${command.root.kind}:${command.root.id}`;
        precondition.expected_root_hash = await semanticRootHash(command.root, state.roots[rootKey] ?? null);
      }
      if (Object.hasOwn(precondition, "expected_bucket")) {
        const bucket = precondition.expected_bucket;
        if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
          throw new ClockRecoveryError("A source bucket guard is malformed");
        }
        const value = bucket as Record<string, unknown>;
        if (typeof value.date !== "string" || typeof value.period !== "string") {
          throw new ClockRecoveryError("A source bucket guard is malformed");
        }
        precondition.expected_bucket = {
          ...value,
          order_hash: await bucketOrderHash(state, value.date, value.period as Period),
        };
      }
      command.precondition = precondition;
    }
    if (!await operationPreconditionsMatch(state, replacement)) {
      throw new ClockRecoveryError(`Reauthored operation has a stale precondition: ${replacement.operation_id}`);
    }
    staged.push(replacement);
  }
  return { newDeviceId, replacements };
}

function assertCommandSemantics(
  original: Operation,
  replacement: Operation,
  operationIds: ReadonlyMap<UUID, UUID>,
  segmentIds: ReadonlyMap<UUID, UUID>,
): void {
  if (original.commands.length !== replacement.commands.length) throw new ClockRecoveryError("Reauthoring changed the operation command count");
  for (let index = 0; index < original.commands.length; index += 1) {
    const before = original.commands[index];
    const after = replacement.commands[index];
    if (before.action !== after.action || canonicalizeJson(before.root) !== canonicalizeJson(after.root)) {
      throw new ClockRecoveryError("Reauthoring changed a command action or target root");
    }
    const mappedPayload = mapPayloadReference(before.payload, "", operationIds, segmentIds);
    const normalizedBefore = { ...before, payload: mappedPayload, precondition: normalizePrecondition(before.precondition) };
    const normalizedAfter = { ...after, precondition: normalizePrecondition(after.precondition) };
    if (canonicalizeJson(normalizedBefore) !== canonicalizeJson(normalizedAfter)) {
      throw new ClockRecoveryError("Reauthoring changed command intent or did not remap its references exactly");
    }
  }
  const mappedDependencies = original.dependencies.map((dependency) => operationIds.get(dependency) ?? dependency);
  if (canonicalizeJson(mappedDependencies) !== canonicalizeJson(replacement.dependencies)) {
    throw new ClockRecoveryError("Reauthoring changed dependency references");
  }
}

function assertStrictlyAfter(
  previous: OwnerSnapshot["metadata"]["observed_hlc"],
  next: Operation["edit_time"],
): void {
  if (previous && (next.physical_ms < previous.physical_ms ||
      (next.physical_ms === previous.physical_ms && next.logical <= previous.logical))) {
    throw new ClockRecoveryError("Reauthored operation time must be later than the verified server HLC");
  }
}

/**
 * Reauthor one dependency-closed branch whose original operations are proven
 * unrecorded. The replacement must preserve command intent and the fully replayed
 * semantic projection after remapping operation/segment provenance.
 */
export async function commitClockReauthorBatch(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  newDeviceId: UUID;
  sourceOperationIds: readonly UUID[];
  replacements: ReadonlyMap<UUID, Operation>;
  clockCalibration?: PersistedClockCalibration;
}): Promise<{ result: OwnerCommitResult; operationIds: Map<UUID, UUID> }> {
  const { snapshot } = input;
  if (snapshot.auth.locked || !snapshot.auth.crypto_key) throw new ClockRecoveryError("Clock recovery requires the unlocked owner vault");
  const calibration = input.clockCalibration ?? snapshot.metadata.clock_calibration;
  if (!calibration) throw new ClockRecoveryError("A fresh trusted clock calibration is required before reauthoring");
  if (!input.clockCalibration && ownerNeedsClockCalibration(snapshot)) throw new ClockRecoveryError("Clock calibration expired; recalibrate before reauthoring");
  if (input.clockCalibration && (!Number.isSafeInteger(calibration.calibrated_at_wall_ms) ||
      calibration.calibrated_at_wall_ms < Date.now() - 10 * 60 * 1_000 ||
      calibration.calibrated_at_wall_ms > Date.now() + 60_000)) {
    throw new ClockRecoveryError("The replacement lane calibration is not fresh");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.newDeviceId) ||
      input.newDeviceId === snapshot.metadata.device_id) throw new ClockRecoveryError("Reauthoring requires a new device lane");

  const ids = new Set(input.sourceOperationIds);
  if (ids.size === 0 || ids.size !== input.sourceOperationIds.length || ids.size !== input.replacements.size) {
    throw new ClockRecoveryError("Clock reauthoring requires a one-to-one nonempty operation mapping");
  }
  const entries = await readActiveOutbox(snapshot);
  const entryById = new Map(entries.map((entry) => [entry.operation.operation_id, entry]));
  const selected: typeof entries = [];
  for (const id of ids) {
    const entry = entryById.get(id);
    if (!entry) throw new ClockRecoveryError(`Clock reauthor source is not in the active outbox: ${id}`);
    if (entry.ever_recorded || entry.commit_uncertain || entry.receipt !== null ||
        entry.state === "sending" || entry.state === "ack_waiting_pull") {
      throw new ClockRecoveryError(`Operation ${id} must be retried or is already recorded; it cannot be reauthored`);
    }
    selected.push(entry);
  }
  const closure = new Set(ids);
  for (const entry of entries) {
    if (closure.has(entry.operation.operation_id)) continue;
    if (entry.operation.dependencies.some((dependency) => closure.has(dependency))) {
      throw new ClockRecoveryError(`Reauthoring must include dependent operation ${entry.operation.operation_id}`);
    }
  }

  const recorded = await readRecordedShadow(snapshot);
  const recordedOperations = recorded.map(({ group }) => group.operation);
  const beforeReplay = await rebuildOwnerProjection({ snapshot });
  const allOperations = beforeReplay.operations;
  const originals = selected.map((entry) => entry.operation).sort(compareOperations);
  const replacementByOriginal = input.replacements;
  const { operationIds, segmentIds } = await referenceMaps(originals, replacementByOriginal);
  const replacementOperations = originals.map((original) => replacementByOriginal.get(original.operation_id)!);
  const newIds = new Set<UUID>();
  const knownIds = new Set(allOperations.map((operation) => operation.operation_id));
  let priorHlc = recorded.reduce<OwnerSnapshot["metadata"]["observed_hlc"]>(
    (current, { group }) => maxHlc(current, group.operation.edit_time), null,
  );
  for (let index = 0; index < replacementOperations.length; index += 1) {
    const original = originals[index];
    const replacement = replacementOperations[index];
    assertOperationEnvelope(replacement);
    if (replacement.owner_id !== snapshot.metadata.owner_id || replacement.device_id !== input.newDeviceId ||
        replacement.device_sequence !== String(index + 1) || knownIds.has(replacement.operation_id) || newIds.has(replacement.operation_id)) {
      throw new ClockRecoveryError("Replacement operation has an invalid owner, new lane, sequence, or id");
    }
    if (replacement.edit_time.quality !== "calibrated" || replacement.edit_time.calibration_id !== calibration.calibration_id) {
      throw new ClockRecoveryError("Reauthoring requires operations stamped by the fresh calibration");
    }
    assertStrictlyAfter(priorHlc, replacement.edit_time);
    priorHlc = { physical_ms: replacement.edit_time.physical_ms, logical: replacement.edit_time.logical };
    assertCommandSemantics(original, replacement, operationIds, segmentIds);
    newIds.add(replacement.operation_id);
  }

  const remainingOperations = allOperations.filter((operation) => !ids.has(operation.operation_id));
  const oldState = beforeReplay.replay.state;
  const canonicalOperations = [...remainingOperations, ...replacementOperations].sort(compareOperations);
  for (let index = 0; index < canonicalOperations.length; index += 1) {
    const operation = canonicalOperations[index];
    if (!newIds.has(operation.operation_id)) continue;
    const preState = await replayOperations(canonicalOperations.slice(0, index), snapshot.metadata.owner_id);
    if (!await operationPreconditionsMatch(preState.state, operation)) {
      throw new ClockRecoveryError(`Replacement operation has a stale root or bucket guard: ${operation.operation_id}`);
    }
  }
  const newReplay = await replayOperations(canonicalOperations, snapshot.metadata.owner_id);
  const mappedOldState = mapProjectionReferences(oldState, "", operationIds, segmentIds);
  if (canonicalizeJson(mappedOldState) !== canonicalizeJson(newReplay.state)) {
    throw new ClockRecoveryError("Reauthored chain does not produce a semantically equivalent projection");
  }

  const newEnvelopeRows: EncryptedOwnerRow[] = [];
  for (const operation of replacementOperations) {
    const requestHash = await hashOperation(operation);
    const envelope: StoredOutboxEnvelope = {
      operation,
      request_hash: requestHash,
      state: "queued",
      ever_recorded: false,
      commit_uncertain: false,
      attempts: 0,
      next_attempt_at_ms: null,
      superseded_by: null,
      receipt: null,
      problem_code: null,
    };
    const cipher = await encryptOwnerPayload({
      ownerId: snapshot.metadata.owner_id,
      store: "outbox",
      recordId: operation.operation_id,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: envelope,
    });
    newEnvelopeRows.push({
      id: `${snapshot.metadata.owner_id}:${operation.operation_id}`,
      owner_id: snapshot.metadata.owner_id,
      record_id: operation.operation_id,
      key_id: snapshot.metadata.key_id,
      ...cipher,
      state: envelope.state,
      request_hash: requestHash,
      superseded_by: null,
      created_at_ms: Date.now(),
    });
  }

  const diagnosticWrites: Array<{ store: "diagnostics"; row: EncryptedOwnerRow }> = [];
  const outboxDeletes: Array<{ store: "outbox"; id: string }> = [];
  for (const entry of selected) {
    const originalId = entry.operation.operation_id;
    const newId = operationIds.get(originalId)!;
    if (snapshot.diagnostics.some((row) => row.record_id === originalId)) {
      throw new ClockRecoveryError(`Diagnostics already contains the original operation ${originalId}`);
    }
    const supersededEnvelope: StoredOutboxEnvelope = {
      operation: entry.operation,
      request_hash: entry.request_hash,
      state: entry.state,
      ever_recorded: false,
      commit_uncertain: false,
      attempts: entry.attempts,
      next_attempt_at_ms: entry.next_attempt_at_ms,
      superseded_by: newId,
      receipt: null,
      problem_code: entry.problem_code,
    };
    const cipher = await encryptOwnerPayload({
      ownerId: snapshot.metadata.owner_id,
      store: "diagnostics",
      recordId: originalId,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: supersededEnvelope,
    });
    diagnosticWrites.push({ store: "diagnostics", row: {
      ...entry.row,
      ...cipher,
      superseded_by: newId,
      request_hash: entry.request_hash,
      state: entry.state,
      diagnostic_kind: "clock_reauth_original",
    } });
    outboxDeletes.push({ store: "outbox", id: entry.row.id });
  }

  const projectionRows = await encryptProjectionRows(snapshot, newReplay.state);
  const priorOutboxRows = snapshot.outbox.filter((row) => !ids.has(row.record_id as UUID) && !row.superseded_by);
  const replaySnapshot: OwnerSnapshot = { ...snapshot, outbox: [...priorOutboxRows, ...newEnvelopeRows] };
  // Verify ciphertext and row metadata will rebuild to the same state before commit.
  const finalReplay = await rebuildOwnerProjection({ snapshot: replaySnapshot });
  if (canonicalizeJson(finalReplay.replay.state) !== canonicalizeJson(newReplay.state)) {
    throw new ClockRecoveryError("Prepared reauthor outbox does not reproduce the verified projection");
  }

  const writes = [
    ...newEnvelopeRows.map((row) => ({ store: "outbox" as const, row })),
    ...diagnosticWrites,
    ...projectionRows.map((row) => ({ store: "projection" as const, row })),
  ];
  const result = await commitOwnerChanges({
    database: input.database,
    guard: {
      owner_id: snapshot.metadata.owner_id,
      expected_revision: snapshot.metadata.local_state_revision,
      expected_lock_epoch: snapshot.metadata.lock_epoch,
      expected_generation: snapshot.metadata.sync_generation,
      expected_server_epoch: snapshot.metadata.server_epoch,
      expected_cursor: snapshot.metadata.pull_cursor,
      expected_build: input.expectedBuild,
      expected_gate_revision: input.gate.revision,
      expected_fencing_token: input.expectedFencingToken,
    },
    writes,
    deletes: outboxDeletes,
    metadataPatch: {
      device_id: input.newDeviceId,
      device_sequence: String(replacementOperations.length),
      local_hlc: priorHlc,
      ...(input.clockCalibration ? { clock_calibration: input.clockCalibration } : {}),
    },
  });
  return { result, operationIds };
}
