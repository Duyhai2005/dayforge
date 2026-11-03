import {
  assertOperationEnvelope,
  compareDecimal,
  hashOperation,
  type EventGroup,
  type SyncPage,
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
import { encryptProjectionRows, rebuildOwnerProjection } from "./projection";
import { readActiveOutbox } from "./outbox";

export interface BootstrapStageMetadata {
  kind: "metadata";
  session_id: UUID;
  epoch: UUID;
  through_cursor: string;
  last_cursor: string;
  next_page_token: string | null;
  complete: boolean;
}

interface BootstrapStageEvent {
  kind: "event";
  session_id: UUID;
  group: EventGroup;
  request_hash: string;
}

export interface BootstrapStageView {
  session_id: UUID;
  epoch: UUID;
  through_cursor: string;
  last_cursor: string;
  next_page_token: string | null;
  complete: boolean;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Bootstrap staging transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Bootstrap staging transaction failed"));
  });
}

async function stageRows(database: IDBDatabase, ownerId: UUID): Promise<EncryptedOwnerRow[]> {
  const transaction = database.transaction(["staging"], "readonly");
  const done = transactionDone(transaction);
  const rows = await new Promise<EncryptedOwnerRow[]>((resolve, reject) => {
    const request = transaction.objectStore("staging").index("by-owner").getAll(IDBKeyRange.only(ownerId));
    request.onsuccess = () => resolve(request.result as EncryptedOwnerRow[]);
    request.onerror = () => reject(request.error ?? new Error("Unable to read bootstrap staging rows"));
  });
  await done;
  return rows;
}

async function readStage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  sessionId?: UUID;
}): Promise<{ metadata: BootstrapStageMetadata | null; events: BootstrapStageEvent[]; rows: EncryptedOwnerRow[] }> {
  if (input.snapshot.auth.locked || !input.snapshot.auth.crypto_key) throw new Error("Bootstrap staging requires the unlocked owner vault");
  const rows = await stageRows(input.database, input.snapshot.metadata.owner_id);
  const selected = input.sessionId ? rows.filter((row) => row.bootstrap_id === input.sessionId) : rows;
  let metadata: BootstrapStageMetadata | null = null;
  const events: BootstrapStageEvent[] = [];
  for (const row of selected) {
    if (row.key_id !== input.snapshot.metadata.key_id) throw new Error("Bootstrap stage uses an unexpected vault key id");
    const payload = await decryptOwnerPayload<BootstrapStageMetadata | BootstrapStageEvent>({
      ownerId: input.snapshot.metadata.owner_id,
      store: "staging",
      recordId: row.record_id,
      row,
      key: input.snapshot.auth.crypto_key,
    });
    if (payload.kind === "metadata") {
      if (metadata) throw new Error("More than one bootstrap stage metadata row was found");
      if (row.bootstrap_id !== payload.session_id || row.bootstrap_kind !== "metadata" ||
          row.record_id !== `bootstrap:${payload.session_id}:metadata`) {
        throw new Error("Bootstrap stage metadata index does not match its encrypted marker");
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.session_id) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.epoch) ||
          !/^(0|[1-9][0-9]*)$/.test(payload.through_cursor) || !/^(0|[1-9][0-9]*)$/.test(payload.last_cursor) ||
          payload.through_cursor.length > 20 || payload.last_cursor.length > 20 ||
          BigInt(payload.through_cursor) > BigInt("18446744073709551615") || BigInt(payload.last_cursor) > BigInt("18446744073709551615") ||
          !(payload.next_page_token === null || (typeof payload.next_page_token === "string" && payload.next_page_token.length > 0 && payload.next_page_token.length <= 4096)) ||
          typeof payload.complete !== "boolean" || (payload.complete !== (payload.next_page_token === null))) {
        throw new Error("Bootstrap stage metadata is invalid");
      }
      metadata = payload;
    } else if (payload.kind === "event") {
      if (row.bootstrap_id !== payload.session_id || row.bootstrap_kind !== "event" ||
          row.record_id !== `bootstrap:${payload.session_id}:cursor:${payload.group.cursor}`) {
        throw new Error("Bootstrap event index does not match its encrypted payload");
      }
      assertOperationEnvelope(payload.group.operation);
      if (!/^[0-9a-f]{64}$/.test(payload.request_hash) ||
          await hashOperation(payload.group.operation) !== payload.request_hash ||
          payload.group.operation.owner_id !== input.snapshot.metadata.owner_id) {
        throw new Error("Bootstrap stage event verifier failed");
      }
      events.push(payload);
    } else {
      throw new Error("Bootstrap stage contains an unknown row kind");
    }
  }
  if (metadata && (metadata.session_id !== input.sessionId && input.sessionId !== undefined)) {
    throw new Error("Bootstrap stage session identity does not match its encrypted marker");
  }
  events.sort((left, right) => compareDecimal(left.group.cursor, right.group.cursor));
  return { metadata, events, rows: selected };
}

async function makeStageRow<T extends BootstrapStageMetadata | BootstrapStageEvent>(input: {
  snapshot: OwnerSnapshot;
  recordId: string;
  sessionId: UUID;
  payload: T;
  kind: "metadata" | "event";
}): Promise<EncryptedOwnerRow> {
  const ownerId = input.snapshot.metadata.owner_id;
  const cipher = await encryptOwnerPayload({
    ownerId,
    store: "staging",
    recordId: input.recordId,
    keyId: input.snapshot.metadata.key_id,
    key: input.snapshot.auth.crypto_key!,
    payload: input.payload,
  });
  return {
    id: `${ownerId}:${input.recordId}`,
    owner_id: ownerId,
    record_id: input.recordId,
    key_id: input.snapshot.metadata.key_id,
    ...cipher,
    bootstrap_id: input.sessionId,
    bootstrap_kind: input.kind,
  };
}

function validatePageAgainstStage(page: SyncPage, metadata: BootstrapStageMetadata | null, usedPageToken: string | null): BootstrapStageMetadata {
  if (!metadata) {
    if (usedPageToken !== null) throw new Error("A continuation page cannot start without a durable bootstrap stage");
    let previous = "0";
    for (const group of page.groups) {
      if (group.cursor !== (BigInt(previous) + 1n).toString()) throw new Error("Bootstrap prefix does not start at cursor 1");
      previous = group.cursor;
    }
    if (page.groups.length === 0 && (page.through_cursor !== "0" || page.next_cursor !== "0" || page.has_more)) {
      throw new Error("An empty initial bootstrap page must represent an empty server prefix");
    }
    if (page.groups.length > 0 && page.next_cursor !== previous) throw new Error("Bootstrap page cursor does not match its last event");
    return {
      kind: "metadata",
      session_id: crypto.randomUUID(),
      epoch: page.epoch,
      through_cursor: page.through_cursor,
      last_cursor: page.next_cursor,
      next_page_token: page.next_page_token,
      complete: !page.has_more,
    };
  }
  if (metadata.complete || metadata.next_page_token === null || usedPageToken !== metadata.next_page_token) {
    throw new Error("Bootstrap continuation token does not match the durable stage");
  }
  if (page.epoch !== metadata.epoch || page.through_cursor !== metadata.through_cursor) {
    throw new Error("Bootstrap continuation changed epoch or captured highwater");
  }
  let previous = metadata.last_cursor;
  for (const group of page.groups) {
    if (group.cursor !== (BigInt(previous) + 1n).toString()) throw new Error("Bootstrap continuation has a cursor gap or replay");
    previous = group.cursor;
  }
  if (page.groups.length === 0 && (page.has_more || metadata.last_cursor !== metadata.through_cursor)) {
    throw new Error("Bootstrap continuation omitted events before its captured highwater");
  }
  if (page.groups.length > 0 && page.next_cursor !== previous) throw new Error("Bootstrap page cursor does not match its last event");
  if (!page.has_more && page.next_cursor !== metadata.through_cursor) throw new Error("Final bootstrap page did not reach its captured highwater");
  return { ...metadata, last_cursor: page.next_cursor, next_page_token: page.next_page_token, complete: !page.has_more };
}

/** Persist one bootstrap page encrypted; it is not visible to the active projection. */
export async function stageBootstrapPage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  page: SyncPage;
  usedPageToken: string | null;
  sessionId?: UUID;
}): Promise<{ sessionId: UUID; stage: BootstrapStageView; result: OwnerCommitResult }> {
  const ownerId = input.snapshot.metadata.owner_id;
  if (input.snapshot.auth.locked || !input.snapshot.auth.crypto_key) throw new Error("Bootstrap staging requires the unlocked owner vault");
  const prior = await readStage({ database: input.database, snapshot: input.snapshot, sessionId: input.sessionId });
  if (input.sessionId && !prior.metadata) throw new Error("Bootstrap stage session is missing");
  if (!input.sessionId && prior.metadata) throw new Error("An unfinished bootstrap stage already exists");
  const updated = validatePageAgainstStage(input.page, prior.metadata, input.usedPageToken);
  if (input.sessionId && updated.session_id !== input.sessionId) throw new Error("Bootstrap stage id changed during continuation");

  const seen = new Set(prior.events.map((event) => event.group.cursor));
  const seenOperations = new Map(prior.events.map((event) => [event.group.operation.operation_id, event.request_hash]));
  const writes: Array<{ store: "staging"; row: EncryptedOwnerRow }> = [];
  for (const group of input.page.groups) {
    assertOperationEnvelope(group.operation);
    if (group.operation.owner_id !== ownerId) throw new Error("Bootstrap prefix contains another owner's operation");
    if (seen.has(group.cursor)) throw new Error("Bootstrap stage repeats a cursor");
    seen.add(group.cursor);
    const hash = await hashOperation(group.operation);
    const existingHash = seenOperations.get(group.operation.operation_id);
    if (existingHash !== undefined) {
      if (existingHash !== hash) throw new Error("Bootstrap prefix reuses an operation id with a different hash");
      throw new Error("Bootstrap prefix records one operation at more than one cursor");
    }
    seenOperations.set(group.operation.operation_id, hash);
    const recordId = `bootstrap:${updated.session_id}:cursor:${group.cursor}`;
    writes.push({
      store: "staging",
      row: await makeStageRow({
        snapshot: input.snapshot,
        recordId,
        sessionId: updated.session_id,
        payload: { kind: "event", session_id: updated.session_id, group, request_hash: hash },
        kind: "event",
      }),
    });
  }
  const markerId = `bootstrap:${updated.session_id}:metadata`;
  writes.push({
    store: "staging",
    row: await makeStageRow({ snapshot: input.snapshot, recordId: markerId, sessionId: updated.session_id, payload: updated, kind: "metadata" }),
  });

  const result = await commitOwnerChanges({
    database: input.database,
    guard: {
      owner_id: ownerId,
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
  return {
    sessionId: updated.session_id,
    stage: {
      session_id: updated.session_id,
      epoch: updated.epoch,
      through_cursor: updated.through_cursor,
      last_cursor: updated.last_cursor,
      next_page_token: updated.next_page_token,
      complete: updated.complete,
    },
    result,
  };
}

export async function readBootstrapStage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  sessionId: UUID;
}): Promise<BootstrapStageView | null> {
  const { metadata } = await readStage(input);
  if (!metadata) return null;
  return {
    session_id: metadata.session_id,
    epoch: metadata.epoch,
    through_cursor: metadata.through_cursor,
    last_cursor: metadata.last_cursor,
    next_page_token: metadata.next_page_token,
    complete: metadata.complete,
  };
}

export async function findBootstrapStage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
}): Promise<BootstrapStageView | null> {
  const { metadata } = await readStage(input);
  if (!metadata) return null;
  return {
    session_id: metadata.session_id,
    epoch: metadata.epoch,
    through_cursor: metadata.through_cursor,
    last_cursor: metadata.last_cursor,
    next_page_token: metadata.next_page_token,
    complete: metadata.complete,
  };
}

export async function readBootstrapStageData(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  sessionId: UUID;
}): Promise<{ metadata: BootstrapStageMetadata | null; groups: EventGroup[]; rows: EncryptedOwnerRow[] }> {
  const stage = await readStage(input);
  return {
    metadata: stage.metadata,
    groups: stage.events.map((event) => event.group),
    rows: stage.rows,
  };
}

function observedMax(current: OwnerSnapshot["metadata"]["observed_hlc"], groups: readonly EventGroup[]) {
  let result = current;
  for (const { operation } of groups) {
    const next = operation.edit_time;
    if (!result || next.physical_ms > result.physical_ms ||
        (next.physical_ms === result.physical_ms && next.logical > result.logical)) {
      result = { physical_ms: next.physical_ms, logical: next.logical };
    }
  }
  return result;
}

/** Atomically publish a complete captured prefix and merge the latest active outbox. */
export async function publishBootstrapStage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  sessionId: UUID;
}): Promise<OwnerCommitResult> {
  const { snapshot } = input;
  if (snapshot.auth.locked || !snapshot.auth.crypto_key) throw new Error("Bootstrap publish requires the unlocked owner vault");
  if (snapshot.metadata.server_epoch === null && snapshot.shadow.length > 0) {
    throw new Error("Initial bootstrap cannot replace an untracked local shadow; epoch recovery must journal it first");
  }
  const stage = await readStage({ database: input.database, snapshot, sessionId: input.sessionId });
  const marker = stage.metadata;
  if (!marker || !marker.complete || marker.epoch === "" || marker.last_cursor !== marker.through_cursor) {
    throw new Error("Only a complete bootstrap prefix can be published");
  }
  if ((marker.through_cursor === "0" && stage.events.length !== 0) ||
      (marker.through_cursor !== "0" && stage.events.length === 0) ||
      (stage.events.length > 0 && stage.events[stage.events.length - 1].group.cursor !== marker.through_cursor)) {
    throw new Error("Bootstrap staging does not cover its captured highwater");
  }
  let expectedCursor = 0n;
  const serverOperationHashes = new Map<UUID, string>();
  for (let index = 0; index < stage.events.length; index += 1) {
    const event = stage.events[index];
    expectedCursor += 1n;
    if (event.group.cursor !== expectedCursor.toString()) throw new Error("Bootstrap staging prefix contains a cursor gap");
    assertOperationEnvelope(event.group.operation);
    if (event.group.operation.owner_id !== snapshot.metadata.owner_id || await hashOperation(event.group.operation) !== event.request_hash) {
      throw new Error(`Bootstrap event verifier failed for ${event.group.operation.operation_id}`);
    }
    if (serverOperationHashes.has(event.group.operation.operation_id)) throw new Error("Bootstrap prefix repeats an operation id");
    serverOperationHashes.set(event.group.operation.operation_id, event.request_hash);
  }
  if (expectedCursor.toString() !== marker.through_cursor) throw new Error("Bootstrap prefix length does not match its captured highwater");

  const active = await readActiveOutbox(snapshot);
  const activeById = new Map(active.map((entry) => [entry.operation.operation_id, entry]));
  const deleteIds = new Set<string>();
  const removedOutboxIds: UUID[] = [];
  const shadowRows: EncryptedOwnerRow[] = [];
  for (const staged of stage.events) {
    const group = staged.group;
    const id = group.operation.operation_id;
    const pending = activeById.get(id);
    if (pending && pending.request_hash !== staged.request_hash) throw new Error(`Bootstrap reuses local operation id ${id} with a different hash`);
    if (pending) {
      deleteIds.add(pending.row.id);
      removedOutboxIds.push(id);
    }
    const recordId = id;
    const cipher = await encryptOwnerPayload({
      ownerId: snapshot.metadata.owner_id,
      store: "shadow",
      recordId,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: group,
    });
    shadowRows.push({
      id: `${snapshot.metadata.owner_id}:${recordId}`,
      owner_id: snapshot.metadata.owner_id,
      record_id: recordId,
      key_id: snapshot.metadata.key_id,
      ...cipher,
      cursor: group.cursor,
      epoch: marker.epoch,
      request_hash: staged.request_hash,
    });
  }

  const tentativeSnapshot: OwnerSnapshot = {
    ...snapshot,
    metadata: { ...snapshot.metadata, server_epoch: marker.epoch, pull_cursor: marker.through_cursor },
    shadow: shadowRows,
    outbox: snapshot.outbox.filter((row) => !removedOutboxIds.includes(row.record_id)),
  };
  const { replay } = await rebuildOwnerProjection({ snapshot: tentativeSnapshot });
  const projectionRows = await encryptProjectionRows(snapshot, replay.state);
  const stageDeleteIds = stage.rows.map((row) => row.id);
  const replacementShadowIds = new Set(shadowRows.map((row) => row.id));
  const shadowDeleteIds = snapshot.shadow
    .filter((row) => !replacementShadowIds.has(row.id))
    .map((row) => row.id);
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
      ...projectionRows.map((row) => ({ store: "projection" as const, row })),
    ],
    deletes: [
      ...shadowDeleteIds.map((id) => ({ store: "shadow" as const, id })),
      ...[...deleteIds].map((id) => ({ store: "outbox" as const, id })),
      ...stageDeleteIds.map((id) => ({ store: "staging" as const, id })),
    ],
    metadataPatch: {
      sync_generation: snapshot.metadata.sync_generation + 1,
      server_epoch: marker.epoch,
      pull_cursor: marker.through_cursor,
      observed_hlc: observedMax(snapshot.metadata.observed_hlc, stage.events.map((event) => event.group)),
    },
  });
  return result;
}

export async function discardBootstrapStage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  sessionId: UUID;
}): Promise<OwnerCommitResult> {
  const stage = await readStage({ database: input.database, snapshot: input.snapshot, sessionId: input.sessionId });
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
    writes: [],
    deletes: stage.rows.map((row) => ({ store: "staging", id: row.id })),
  });
}
