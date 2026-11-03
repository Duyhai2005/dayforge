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

function observedMax(
  current: OwnerSnapshot["metadata"]["observed_hlc"],
  groups: readonly EventGroup[],
): OwnerSnapshot["metadata"]["observed_hlc"] {
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

function expectedNext(cursor: string): string {
  return (BigInt(cursor) + 1n).toString();
}

function validatePullPage(snapshot: OwnerSnapshot, page: SyncPage, after: string): void {
  if (snapshot.metadata.server_epoch !== page.epoch) throw new Error("Pull page epoch differs from the committed owner epoch; bootstrap recovery is required");
  if (compareDecimal(page.through_cursor, after) < 0 || compareDecimal(page.next_cursor, after) < 0) {
    throw new Error("Pull page cursor moved backwards");
  }
  if (page.groups.length === 0) {
    if (page.has_more || page.next_cursor !== after || page.through_cursor !== after) {
      throw new Error("An empty pull page may only confirm the current highwater cursor");
    }
    return;
  }
  let cursor = after;
  for (const group of page.groups) {
    const next = expectedNext(cursor);
    if (group.cursor !== next) throw new Error(`Pull page has a cursor gap or replay at ${group.cursor}`);
    cursor = group.cursor;
    assertOperationEnvelope(group.operation);
    if (group.operation.owner_id !== snapshot.metadata.owner_id) throw new Error("Pull page contains an operation for another owner");
  }
  if (page.next_cursor !== cursor) throw new Error("Pull page next_cursor does not match its last event");
  if (page.has_more && compareDecimal(page.next_cursor, page.through_cursor) >= 0) {
    throw new Error("Continuing pull page does not leave a cursor before its highwater");
  }
  if (!page.has_more && page.next_cursor !== page.through_cursor) {
    throw new Error("Final pull page did not reach its captured highwater");
  }
}

async function makeShadowRow(snapshot: OwnerSnapshot, group: EventGroup): Promise<EncryptedOwnerRow> {
  const operationId = group.operation.operation_id;
  const requestHash = await hashOperation(group.operation);
  const cipher = await encryptOwnerPayload({
    ownerId: snapshot.metadata.owner_id,
    store: "shadow",
    recordId: operationId,
    keyId: snapshot.metadata.key_id,
    key: snapshot.auth.crypto_key!,
    payload: group,
  });
  return {
    id: `${snapshot.metadata.owner_id}:${operationId}`,
    owner_id: snapshot.metadata.owner_id,
    record_id: operationId,
    key_id: snapshot.metadata.key_id,
    ...cipher,
    cursor: group.cursor,
    epoch: snapshot.metadata.server_epoch,
    request_hash: requestHash,
  };
}

/**
 * Prepare an entire pull page outside IndexedDB and atomically publish its shadow,
 * projection, observed HLC, cursor, and matching outbox acknowledgements.
 */
export async function ingestPullPage(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  after: string;
  page: SyncPage;
}): Promise<{ result: OwnerCommitResult; removedOutboxIds: UUID[] }> {
  const { snapshot, page } = input;
  if (snapshot.auth.locked || !snapshot.auth.crypto_key) throw new Error("Pull ingestion requires the unlocked owner vault");
  if (snapshot.metadata.pull_cursor !== input.after) throw new Error("Pull page was prepared from a cursor that is no longer current");
  validatePullPage(snapshot, page, input.after);
  if (page.groups.length === 0) {
    // A no-op final page does not need a revision bump. A page that advances the
    // cursor without containing events is invalid above.
    return { result: { committed: true, revision: snapshot.metadata.local_state_revision }, removedOutboxIds: [] };
  }

  const active = await readActiveOutbox(snapshot);
  const activeById = new Map(active.map((entry) => [entry.operation.operation_id, entry]));
  const shadowById = new Map(snapshot.shadow.map((row) => [row.record_id, row]));
  const shadowWrites: Array<{ store: "shadow"; row: EncryptedOwnerRow }> = [];
  const outboxDeletes: Array<{ store: "outbox"; id: string }> = [];
  const addedGroups: EventGroup[] = [];
  const removedOutboxIds: UUID[] = [];
  const pageOperationIds = new Set<UUID>();

  for (const group of page.groups) {
    const operation = group.operation;
    const id = operation.operation_id;
    if (pageOperationIds.has(id)) throw new Error(`Pull page repeats operation ${id}`);
    pageOperationIds.add(id);
    const requestHash = await hashOperation(operation);
    const pending = activeById.get(id);
    if (pending && pending.request_hash !== requestHash) throw new Error(`Pull operation hash conflicts with active outbox ${id}`);

    const existing = shadowById.get(id);
    if (existing) {
      if (existing.request_hash !== requestHash || existing.cursor !== group.cursor || existing.epoch !== page.epoch) {
        throw new Error(`Recorded shadow identity conflicts with incoming event ${id}`);
      }
    } else {
      const row = await makeShadowRow(snapshot, group);
      row.epoch = page.epoch;
      shadowWrites.push({ store: "shadow", row });
      addedGroups.push(group);
    }
    if (pending) {
      const row = pending.row;
      outboxDeletes.push({ store: "outbox", id: row.id });
      removedOutboxIds.push(id);
    }
  }

  // Rebuild against the exact candidate shadow/outbox union. Existing outbox rows
  // remain active until the CAS commits, so exclude only exact events in this page.
  const removed = new Set(removedOutboxIds);
  const tentativeSnapshot: OwnerSnapshot = {
    ...snapshot,
    metadata: { ...snapshot.metadata, pull_cursor: page.next_cursor },
    shadow: [...snapshot.shadow, ...shadowWrites.map(({ row }) => row)],
    outbox: snapshot.outbox.filter((row) => !removed.has(row.record_id)),
  };
  const { replay } = await rebuildOwnerProjection({ snapshot: tentativeSnapshot });
  const projectionRows = await encryptProjectionRows(snapshot, replay.state);
  const writes = [
    ...shadowWrites,
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
      pull_cursor: page.next_cursor,
      observed_hlc: observedMax(snapshot.metadata.observed_hlc, addedGroups),
    },
  });
  return { result, removedOutboxIds };
}
