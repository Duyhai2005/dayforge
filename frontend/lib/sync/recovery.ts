import {
  assertOperationEnvelope,
  compareOperations,
  hashOperation,
  orderOperationsByDependencies,
  type Operation,
  type UUID,
} from "./protocol";
import {
  commitOwnerChanges,
  decryptOwnerPayload,
  encryptOwnerPayload,
  type BuildGate,
  type EncryptedOwnerRow,
  type EncryptedStore,
  type OwnerSnapshot,
} from "../storage/vault";
import { readBootstrapStageData } from "./bootstrap";
import { encryptProjectionRows, readRecordedShadow, rebuildOwnerProjection } from "./projection";
import { readActiveOutbox, type StoredOutboxEnvelope } from "./outbox";

export type ActiveOutboxState = "queued" | "sending" | "blocked" | "ack_waiting_pull" | "quarantined";

export interface RecoveryEnvelope {
  operation: Operation;
  request_hash: string;
}

export interface ActiveRecoveryEnvelope extends RecoveryEnvelope {
  state: ActiveOutboxState;
  /** Locally superseded originals belong to diagnostics and must never be reactivated. */
  superseded_by?: UUID | null;
}

export interface RecoveryPlan {
  replay_union: Operation[];
  upload_ready: Operation[];
  upload_blocked: Array<{ operation: Operation; dependency_ids: UUID[]; reason: "dependency" | "outbox_blocked" }>;
  already_present: UUID[];
}

export class RecoveryIntegrityError extends Error {
  readonly code = "operation_id_reused";

  constructor(message: string) {
    super(message);
    this.name = "RecoveryIntegrityError";
  }
}

export async function persistEpochRecoveryJournal(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken?: number;
}): Promise<{ journalId: UUID; committedRevision: number } | null> {
  const { snapshot, gate } = input;
  if (gate.phase !== "running" || gate.approved_build !== input.expectedBuild) {
    throw new Error("Recovery journal cannot be written while the build gate is changing");
  }
  if (snapshot.auth.locked || !snapshot.auth.crypto_key || snapshot.auth.lock_epoch !== snapshot.metadata.lock_epoch) {
    throw new Error("Recovery journal requires the unlocked owner vault");
  }

  const ownerId = snapshot.metadata.owner_id;
  const journalId = crypto.randomUUID();
  const createdAt = Date.now();
  const writes: Array<{ store: "journal"; row: EncryptedOwnerRow }> = [];
  const markerRecordId = `${journalId}:metadata`;
  const markerCipher = await encryptOwnerPayload({
    ownerId,
    store: "journal",
    recordId: markerRecordId,
    keyId: snapshot.metadata.key_id,
    key: snapshot.auth.crypto_key,
    payload: {
      journal_id: journalId,
      server_epoch: snapshot.metadata.server_epoch,
      pull_cursor: snapshot.metadata.pull_cursor,
      sync_generation: snapshot.metadata.sync_generation,
      local_state_revision: snapshot.metadata.local_state_revision,
    },
  });
  writes.push({
    store: "journal",
    row: {
      id: `${ownerId}:${markerRecordId}`,
      owner_id: ownerId,
      record_id: markerRecordId,
      key_id: snapshot.metadata.key_id,
      ...markerCipher,
      journal_id: journalId,
      source_store: "journal_metadata",
      created_at_ms: createdAt,
    },
  });

  const sources: Array<{ store: "shadow" | "outbox" | "projection" | "drafts"; rows: readonly EncryptedOwnerRow[] }> = [
    { store: "shadow", rows: snapshot.shadow },
    { store: "outbox", rows: snapshot.outbox.filter((row) => !row.superseded_by) },
    { store: "projection", rows: snapshot.projection },
    { store: "drafts", rows: snapshot.drafts },
  ];
  for (const source of sources) {
    for (const original of source.rows) {
      const recordId = `${journalId}:${source.store}:${original.record_id}`;
      // The row remains encrypted with its original AAD. A journal entry records where
      // it came from so recovery can decrypt it only through that original store context.
      writes.push({
        store: "journal",
        row: {
          ...original,
          id: `${ownerId}:${recordId}`,
          record_id: recordId,
          journal_id: journalId,
          source_store: source.store,
          source_record_id: original.record_id,
          source_row_id: original.id,
          source_state: original.state ?? null,
          source_request_hash: original.request_hash ?? null,
          created_at_ms: createdAt,
        },
      });
    }
  }

  const result = await commitOwnerChanges({
    database: input.database,
    guard: {
      owner_id: ownerId,
      expected_revision: snapshot.metadata.local_state_revision,
      expected_lock_epoch: snapshot.metadata.lock_epoch,
      expected_generation: snapshot.metadata.sync_generation,
      expected_server_epoch: snapshot.metadata.server_epoch,
      expected_cursor: snapshot.metadata.pull_cursor,
      expected_build: input.expectedBuild,
      expected_gate_revision: gate.revision,
      expected_fencing_token: input.expectedFencingToken,
    },
    writes,
    deletes: snapshot.journal.map((row) => ({ store: "journal" as const, id: row.id })),
  });
  return result.committed ? { journalId, committedRevision: result.revision } : null;
}

export interface RecoveryJournalEntry {
  store: "shadow" | "outbox" | "projection" | "drafts";
  record_id: string;
  source_row_id: string;
  state: unknown;
  request_hash: unknown;
  payload: unknown;
}

export interface RecoveryJournalContents {
  metadata: {
    journal_id: UUID;
    server_epoch: UUID | null;
    pull_cursor: string;
    sync_generation: number;
    local_state_revision: number;
  };
  entries: RecoveryJournalEntry[];
}

export async function decryptRecoveryJournal(input: {
  ownerId: UUID;
  journalId: UUID;
  key: CryptoKey;
  rows: readonly EncryptedOwnerRow[];
}): Promise<RecoveryJournalContents> {
  const selected = input.rows.filter((row) => row.journal_id === input.journalId);
  let metadata: RecoveryJournalContents["metadata"] | null = null;
  const entries: RecoveryJournalEntry[] = [];
  for (const row of selected) {
    if (row.owner_id !== input.ownerId) throw new RecoveryIntegrityError("Recovery journal contains another owner's row");
    const source = row.source_store;
    if (source === "journal_metadata") {
      metadata = await decryptOwnerPayload<RecoveryJournalContents["metadata"]>({
        ownerId: input.ownerId,
        store: "journal",
        recordId: row.record_id,
        row,
        key: input.key,
      });
      if (metadata.journal_id !== input.journalId) throw new RecoveryIntegrityError("Recovery journal metadata id mismatch");
      continue;
    }
    if (source !== "shadow" && source !== "outbox" && source !== "projection" && source !== "drafts") {
      throw new RecoveryIntegrityError("Recovery journal row has an unsupported source store");
    }
    const sourceRecordId = row.source_record_id;
    const sourceRowId = row.source_row_id;
    if (typeof sourceRecordId !== "string" || typeof sourceRowId !== "string") {
      throw new RecoveryIntegrityError("Recovery journal row is missing source identity");
    }
    const originalCipherRow: EncryptedOwnerRow = { ...row, id: sourceRowId, record_id: sourceRecordId };
    const payload = await decryptOwnerPayload<unknown>({
      ownerId: input.ownerId,
      store: source as EncryptedStore,
      recordId: sourceRecordId,
      row: originalCipherRow,
      key: input.key,
    });
    entries.push({
      store: source,
      record_id: sourceRecordId,
      source_row_id: sourceRowId,
      state: row.source_state,
      request_hash: row.source_request_hash,
      payload,
    });
  }
  if (!metadata) throw new RecoveryIntegrityError("Recovery journal metadata is missing");
  return { metadata, entries };
}

async function verifyEnvelope(ownerId: UUID, envelope: RecoveryEnvelope): Promise<void> {
  assertOperationEnvelope(envelope.operation);
  if (envelope.operation.owner_id !== ownerId) throw new RecoveryIntegrityError("Recovery contains an operation for a different owner");
  const hash = await hashOperation(envelope.operation);
  if (hash !== envelope.request_hash) throw new RecoveryIntegrityError(`Stored operation hash mismatch: ${envelope.operation.operation_id}`);
}

/**
 * Compare the old owner union with a newly bootstrapped server prefix. `diagnostics`
 * are intentionally not accepted here, so locally superseded originals cannot be
 * selected for replay or upload by restore code.
 */
export async function planEpochRecovery(input: {
  ownerId: UUID;
  oldShadow: readonly RecoveryEnvelope[];
  activeOutbox: readonly ActiveRecoveryEnvelope[];
  newServerPrefix: readonly RecoveryEnvelope[];
}): Promise<RecoveryPlan> {
  const serverById = new Map<UUID, RecoveryEnvelope>();
  for (const event of input.newServerPrefix) {
    await verifyEnvelope(input.ownerId, event);
    const previous = serverById.get(event.operation.operation_id);
    if (previous && previous.request_hash !== event.request_hash) {
      throw new RecoveryIntegrityError(`New server prefix contains different hashes for ${event.operation.operation_id}`);
    }
    serverById.set(event.operation.operation_id, event);
  }

  const oldById = new Map<UUID, { envelope: RecoveryEnvelope; wasRecorded: boolean; state?: ActiveOutboxState }>();
  for (const event of input.oldShadow) {
    await verifyEnvelope(input.ownerId, event);
    const id = event.operation.operation_id;
    const current = oldById.get(id);
    if (current && current.envelope.request_hash !== event.request_hash) {
      throw new RecoveryIntegrityError(`Old local shadow contains different hashes for ${id}`);
    }
    oldById.set(id, { envelope: event, wasRecorded: true, state: current?.state });
  }

  for (const entry of input.activeOutbox) {
    if (entry.superseded_by) continue;
    await verifyEnvelope(input.ownerId, entry);
    const id = entry.operation.operation_id;
    const current = oldById.get(id);
    if (current && current.envelope.request_hash !== entry.request_hash) {
      throw new RecoveryIntegrityError(`Shadow and active outbox disagree for ${id}`);
    }
    oldById.set(id, {
      envelope: entry,
      wasRecorded: current?.wasRecorded ?? false,
      state: entry.state,
    });
  }

  for (const [id, old] of oldById) {
    const currentServer = serverById.get(id);
    if (currentServer && currentServer.request_hash !== old.envelope.request_hash) {
      throw new RecoveryIntegrityError(`Restored server reused operation id ${id} with a different hash`);
    }
  }

  const oldUnion = [...oldById.values()].map((value) => value.envelope.operation);
  const replayById = new Map<UUID, Operation>();
  for (const event of input.newServerPrefix) replayById.set(event.operation.operation_id, event.operation);
  for (const operation of oldUnion) replayById.set(operation.operation_id, operation);
  const replayUnion = [...replayById.values()].sort(compareOperations);

  const candidates: Operation[] = [];
  const forcedBlocked: RecoveryPlan["upload_blocked"] = [];
  const alreadyPresent: UUID[] = [];
  for (const [id, old] of oldById) {
    const server = serverById.get(id);
    if (server) {
      alreadyPresent.push(id);
      continue;
    }
    if (!old.wasRecorded && (old.state === "blocked" || old.state === "quarantined")) {
      forcedBlocked.push({ operation: old.envelope.operation, dependency_ids: old.envelope.operation.dependencies, reason: "outbox_blocked" });
      continue;
    }
    candidates.push(old.envelope.operation);
  }

  const known = new Map<UUID, Operation>();
  for (const [id, event] of serverById) known.set(id, event.operation);
  const ordered = orderOperationsByDependencies(candidates, known);
  const uploadBlocked = [
    ...forcedBlocked,
    ...ordered.blocked.map(({ operation, dependency_ids }) => ({ operation, dependency_ids, reason: "dependency" as const })),
  ];
  return {
    replay_union: replayUnion,
    upload_ready: ordered.ready,
    upload_blocked: uploadBlocked,
    already_present: alreadyPresent.sort(),
  };
}

/**
 * Publish a newly bootstrapped epoch while preserving old acknowledged events as
 * immutable reupload candidates. The caller must durably journal the old union
 * before it begins fetching the replacement server prefix.
 */
export async function publishEpochRecoveryStage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  sessionId: UUID;
  journalId: UUID;
}): Promise<{ result: import("../storage/vault").OwnerCommitResult; plan: RecoveryPlan }> {
  const { snapshot } = input;
  if (snapshot.auth.locked || !snapshot.auth.crypto_key) throw new Error("Epoch recovery requires the unlocked owner vault");
  const stage = await readBootstrapStageData({ database: input.database, snapshot, sessionId: input.sessionId });
  const marker = stage.metadata;
  if (!marker || !marker.complete || marker.last_cursor !== marker.through_cursor) throw new Error("Epoch recovery requires a complete staged prefix");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.journalId)) {
    throw new Error("Epoch recovery journal id is invalid");
  }
  const journalRows = await readOwnerJournalRows(input.database, snapshot.metadata.owner_id, input.journalId);
  const journal = await decryptRecoveryJournal({ ownerId: snapshot.metadata.owner_id, journalId: input.journalId, key: snapshot.auth.crypto_key, rows: journalRows });
  if (journal.metadata.journal_id !== input.journalId || journal.metadata.server_epoch !== snapshot.metadata.server_epoch ||
      journal.metadata.pull_cursor !== snapshot.metadata.pull_cursor) {
    throw new RecoveryIntegrityError("Recovery journal does not describe the pre-recovery owner generation");
  }
  if ((marker.through_cursor === "0" && stage.groups.length !== 0) ||
      (marker.through_cursor !== "0" && stage.groups.length === 0)) {
    throw new Error("Staged epoch prefix length does not match its captured cursor");
  }
  let cursor = 0n;
  const newServerPrefix: RecoveryEnvelope[] = [];
  for (const group of stage.groups) {
    cursor += 1n;
    if (group.cursor !== cursor.toString() || group.operation.owner_id !== snapshot.metadata.owner_id) {
      throw new RecoveryIntegrityError("Staged epoch prefix has a cursor gap or another owner");
    }
    newServerPrefix.push({ operation: group.operation, request_hash: await hashOperation(group.operation) });
  }
  if (cursor.toString() !== marker.through_cursor) throw new Error("Staged epoch prefix does not reach its captured highwater");

  const oldShadowRows = await readRecordedShadow(snapshot);
  const activeEntries = await readActiveOutbox(snapshot);
  const plan = await planEpochRecovery({
    ownerId: snapshot.metadata.owner_id,
    oldShadow: oldShadowRows.map(({ group, hash }) => ({ operation: group.operation, request_hash: hash })),
    activeOutbox: activeEntries.map((entry) => ({
      operation: entry.operation,
      request_hash: entry.request_hash,
      state: entry.state,
      superseded_by: entry.superseded_by,
    })),
    newServerPrefix,
  });
  void plan;

  const serverById = new Map(newServerPrefix.map((entry) => [entry.operation.operation_id, entry]));
  const activeById = new Map(activeEntries.map((entry) => [entry.operation.operation_id, entry]));
  const outboxWrites: Array<{ store: "outbox"; row: EncryptedOwnerRow }> = [];
  const outboxDeletes: Array<{ store: "outbox"; id: string }> = [];
  const diagnosticsWrites: Array<{ store: "diagnostics"; row: EncryptedOwnerRow }> = [];
  const activeRowsForReplay = new Map<string, EncryptedOwnerRow>();

  for (const entry of activeEntries) {
    const id = entry.operation.operation_id;
    if (serverById.has(id)) {
      outboxDeletes.push({ store: "outbox", id: entry.row.id });
      continue;
    }
    let envelope: StoredOutboxEnvelope = {
      operation: entry.operation,
      request_hash: entry.request_hash,
      state: entry.state,
      ever_recorded: entry.ever_recorded,
      commit_uncertain: entry.commit_uncertain,
      attempts: entry.attempts,
      next_attempt_at_ms: entry.next_attempt_at_ms,
      superseded_by: entry.superseded_by,
      receipt: entry.receipt,
      problem_code: entry.problem_code,
    };
    if (entry.state === "ack_waiting_pull" || entry.state === "sending") {
      envelope = {
        ...envelope,
        state: "queued",
        ever_recorded: entry.ever_recorded || entry.state === "ack_waiting_pull" || entry.receipt !== null,
        commit_uncertain: true,
        next_attempt_at_ms: null,
        receipt: null,
        problem_code: null,
      };
      const cipher = await encryptOwnerPayload({
        ownerId: snapshot.metadata.owner_id,
        store: "outbox",
        recordId: id,
        keyId: snapshot.metadata.key_id,
        key: snapshot.auth.crypto_key,
        payload: envelope,
      });
      const rewritten: EncryptedOwnerRow = { ...entry.row, ...cipher, state: envelope.state, superseded_by: null };
      outboxWrites.push({ store: "outbox", row: rewritten });
      activeRowsForReplay.set(id, rewritten);
    } else {
      activeRowsForReplay.set(id, entry.row);
    }
  }

  // Old recorded events absent from the restored prefix must be sent again with
  // their original envelopes. They are never assigned new ids or edit times.
  for (const old of oldShadowRows) {
    const id = old.group.operation.operation_id;
    if (serverById.has(id) || activeById.has(id)) continue;
    const envelope: StoredOutboxEnvelope = {
      operation: old.group.operation,
      request_hash: old.hash,
      state: "queued",
      ever_recorded: true,
      commit_uncertain: true,
      attempts: 0,
      next_attempt_at_ms: null,
      superseded_by: null,
      receipt: null,
      problem_code: null,
    };
    const cipher = await encryptOwnerPayload({
      ownerId: snapshot.metadata.owner_id,
      store: "outbox",
      recordId: id,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: envelope,
    });
    const row: EncryptedOwnerRow = {
      id: `${snapshot.metadata.owner_id}:${id}`,
      owner_id: snapshot.metadata.owner_id,
      record_id: id,
      key_id: snapshot.metadata.key_id,
      ...cipher,
      state: envelope.state,
      request_hash: old.hash,
      superseded_by: null,
      created_at_ms: Date.now(),
    };
    outboxWrites.push({ store: "outbox", row });
    activeRowsForReplay.set(id, row);
  }

  // Move locally superseded originals out of the active outbox and into the
  // encrypted diagnostics store before the generation swap.
  for (const row of snapshot.outbox.filter((candidate) => candidate.superseded_by)) {
    const envelope = await decryptOwnerPayload<StoredOutboxEnvelope>({
      ownerId: snapshot.metadata.owner_id,
      store: "outbox",
      recordId: row.record_id,
      row,
      key: snapshot.auth.crypto_key,
    });
    if (envelope.operation.operation_id !== row.record_id || await hashOperation(envelope.operation) !== envelope.request_hash ||
        row.request_hash !== envelope.request_hash || row.superseded_by !== envelope.superseded_by) {
      throw new RecoveryIntegrityError(`Superseded outbox verifier failed for ${row.record_id}`);
    }
    const cipher = await encryptOwnerPayload({
      ownerId: snapshot.metadata.owner_id,
      store: "diagnostics",
      recordId: row.record_id,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: envelope,
    });
    const existingDiagnostic = snapshot.diagnostics.find((candidate) => candidate.record_id === row.record_id);
    if (existingDiagnostic) {
      const storedDiagnostic = await decryptOwnerPayload<StoredOutboxEnvelope>({
        ownerId: snapshot.metadata.owner_id,
        store: "diagnostics",
        recordId: existingDiagnostic.record_id,
        row: existingDiagnostic,
        key: snapshot.auth.crypto_key,
      });
      if (storedDiagnostic.request_hash !== envelope.request_hash || storedDiagnostic.superseded_by !== envelope.superseded_by) {
        throw new RecoveryIntegrityError(`Diagnostics id conflicts with superseded operation ${row.record_id}`);
      }
    } else {
      diagnosticsWrites.push({
        store: "diagnostics",
        row: {
          ...row,
          ...cipher,
          state: envelope.state,
          request_hash: envelope.request_hash,
          superseded_by: envelope.superseded_by,
          diagnostic_kind: "superseded_outbox",
        },
      });
    }
    outboxDeletes.push({ store: "outbox", id: row.id });
  }

  const shadowRows: EncryptedOwnerRow[] = [];
  for (const group of stage.groups) {
    const operationId = group.operation.operation_id;
    const cipher = await encryptOwnerPayload({
      ownerId: snapshot.metadata.owner_id,
      store: "shadow",
      recordId: operationId,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: group,
    });
    shadowRows.push({
      id: `${snapshot.metadata.owner_id}:${operationId}`,
      owner_id: snapshot.metadata.owner_id,
      record_id: operationId,
      key_id: snapshot.metadata.key_id,
      ...cipher,
      cursor: group.cursor,
      epoch: marker.epoch,
      request_hash: await hashOperation(group.operation),
    });
  }

  const outboxRows = new Map<string, EncryptedOwnerRow>();
  for (const row of snapshot.outbox) {
    if (row.superseded_by || outboxDeletes.some((deletion) => deletion.id === row.id)) continue;
    outboxRows.set(row.record_id, activeRowsForReplay.get(row.record_id) ?? row);
  }
  for (const write of outboxWrites) outboxRows.set(write.row.record_id, write.row);
  const replaySnapshot: OwnerSnapshot = {
    ...snapshot,
    metadata: { ...snapshot.metadata, server_epoch: marker.epoch, pull_cursor: marker.through_cursor },
    shadow: shadowRows,
    outbox: [...outboxRows.values()],
  };
  const { replay } = await rebuildOwnerProjection({ snapshot: replaySnapshot });
  const projectionRows = await encryptProjectionRows(snapshot, replay.state);
  const stageDeleteIds = stage.rows.map((row) => row.id);
  const replacementShadowIds = new Set(shadowRows.map((row) => row.id));

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
    writes: [
      ...shadowRows.map((row) => ({ store: "shadow" as const, row })),
      ...outboxWrites,
      ...diagnosticsWrites,
      ...projectionRows.map((row) => ({ store: "projection" as const, row })),
    ],
    deletes: [
      // A prefix can contain the same operation ids as the previous epoch.
      // Those rows are replaced by the writes above and must not be deleted
      // later in the same IndexedDB transaction.
      ...snapshot.shadow.filter((row) => !replacementShadowIds.has(row.id))
        .map((row) => ({ store: "shadow" as const, id: row.id })),
      ...outboxDeletes,
      ...stageDeleteIds.map((id) => ({ store: "staging" as const, id })),
      ...journalRows.map((row) => ({ store: "journal" as const, id: row.id })),
    ],
    metadataPatch: {
      sync_generation: snapshot.metadata.sync_generation + 1,
      server_epoch: marker.epoch,
      pull_cursor: marker.through_cursor,
      observed_hlc: maxObservedClock(snapshot.metadata.observed_hlc, stage.groups),
    },
  });
  return { result, plan };
}

async function readOwnerJournalRows(database: IDBDatabase, ownerId: UUID, journalId: UUID): Promise<EncryptedOwnerRow[]> {
  const transaction = database.transaction(["journal"], "readonly");
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Recovery journal read aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Recovery journal read failed"));
  });
  const rows = await new Promise<EncryptedOwnerRow[]>((resolve, reject) => {
    const request = transaction.objectStore("journal").index("by-owner").getAll(IDBKeyRange.only(ownerId));
    request.onsuccess = () => resolve((request.result as EncryptedOwnerRow[]).filter((row) => row.journal_id === journalId));
    request.onerror = () => reject(request.error ?? new Error("Unable to read recovery journal"));
  });
  await done;
  return rows;
}

function maxObservedClock(
  current: OwnerSnapshot["metadata"]["observed_hlc"],
  groups: readonly { operation: Operation }[],
): OwnerSnapshot["metadata"]["observed_hlc"] {
  let value = current;
  for (const { operation } of groups) {
    const clock = operation.edit_time;
    if (!value || clock.physical_ms > value.physical_ms ||
        (clock.physical_ms === value.physical_ms && clock.logical > value.logical)) {
      value = { physical_ms: clock.physical_ms, logical: clock.logical };
    }
  }
  return value;
}
