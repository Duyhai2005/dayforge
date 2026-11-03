import {
  assertOperationEnvelope,
  compareDecimal,
  hashOperation,
  type EventGroup,
  type Operation,
  type UUID,
} from "./protocol";
import {
  decryptOwnerPayload,
  encryptOwnerPayload,
  type EncryptedOwnerRow,
  type OwnerSnapshot,
} from "../storage/vault";
import { readActiveOutbox } from "./outbox";
import { replayOperations, type ProjectionState, type ReplayResult } from "./reducer";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readRecordedShadow(snapshot: OwnerSnapshot): Promise<Array<{ group: EventGroup; hash: string }>> {
  if (snapshot.auth.locked || !snapshot.auth.crypto_key) throw new Error("Projection replay requires the unlocked owner vault");
  const events: Array<{ group: EventGroup; hash: string }> = [];
  for (const row of snapshot.shadow) {
    if (row.owner_id !== snapshot.metadata.owner_id || row.key_id !== snapshot.metadata.key_id) {
      throw new Error("Shadow row owner or key id does not match the active vault");
    }
    const group = await decryptOwnerPayload<EventGroup>({
      ownerId: snapshot.metadata.owner_id,
      store: "shadow",
      recordId: row.record_id,
      row,
      key: snapshot.auth.crypto_key,
    });
    if (!isRecord(group) || Object.keys(group).sort().join(",") !== "committed_at,cursor,operation" ||
        typeof group.cursor !== "string" || compareDecimal(group.cursor, "0") <= 0 ||
        typeof group.committed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(group.committed_at) ||
        !Number.isFinite(Date.parse(group.committed_at))) {
      throw new Error(`Stored shadow event is invalid: ${row.record_id}`);
    }
    assertOperationEnvelope(group.operation);
    if (group.operation.owner_id !== snapshot.metadata.owner_id) throw new Error("Shadow contains another owner's operation");
    if (row.record_id !== group.operation.operation_id || row.epoch !== snapshot.metadata.server_epoch ||
        row.cursor !== group.cursor || compareDecimal(group.cursor, snapshot.metadata.pull_cursor) > 0) {
      throw new Error(`Stored shadow index metadata is inconsistent: ${row.record_id}`);
    }
    const hash = await hashOperation(group.operation);
    if (typeof row.request_hash !== "string" || row.request_hash !== hash) throw new Error("Shadow operation hash does not match its stored verifier");
    events.push({ group, hash });
  }
  events.sort((left, right) => compareDecimal(left.group.cursor, right.group.cursor));
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].group.cursor === events[index].group.cursor) throw new Error("Shadow contains a duplicate epoch cursor");
  }
  return events;
}

/** Replay the owner union by K. Diagnostics are excluded by readActiveOutbox. */
export async function rebuildOwnerProjection(input: {
  snapshot: OwnerSnapshot;
  additionalOperations?: readonly Operation[];
}): Promise<{ replay: ReplayResult; operations: Operation[] }> {
  const ownerId = input.snapshot.metadata.owner_id;
  const [recorded, activeOutbox] = await Promise.all([
    readRecordedShadow(input.snapshot),
    readActiveOutbox(input.snapshot),
  ]);
  const byId = new Map<UUID, { operation: Operation; hash: string }>();
  for (const event of recorded) byId.set(event.group.operation.operation_id, { operation: event.group.operation, hash: event.hash });
  for (const entry of activeOutbox) {
    const existing = byId.get(entry.operation.operation_id);
    if (existing && existing.hash !== entry.request_hash) throw new Error(`Operation id is reused with different local and recorded hashes: ${entry.operation.operation_id}`);
    byId.set(entry.operation.operation_id, { operation: entry.operation, hash: entry.request_hash });
  }
  for (const operation of input.additionalOperations ?? []) {
    assertOperationEnvelope(operation);
    if (operation.owner_id !== ownerId) throw new Error("Prepared local operation belongs to another owner");
    const hash = await hashOperation(operation);
    const existing = byId.get(operation.operation_id);
    if (existing && existing.hash !== hash) throw new Error(`Operation id is reused with different prepared hashes: ${operation.operation_id}`);
    byId.set(operation.operation_id, { operation, hash });
  }
  const operations = [...byId.values()].map((entry) => entry.operation);
  const replay = await replayOperations(operations, ownerId);
  return { replay, operations };
}

/** Prepare encrypted root rows outside IndexedDB; caller commits them with the operation through the owner CAS. */
export async function encryptProjectionRows(snapshot: OwnerSnapshot, state: ProjectionState): Promise<EncryptedOwnerRow[]> {
  if (state.owner_id !== snapshot.metadata.owner_id) throw new Error("Projection owner does not match the vault snapshot");
  if (snapshot.auth.locked || !snapshot.auth.crypto_key) throw new Error("Projection encryption requires the unlocked owner vault");
  const rows: EncryptedOwnerRow[] = [];
  for (const [key, value] of Object.entries(state.roots)) {
    const separator = key.indexOf(":");
    if (separator < 1 || !value || value.owner_id !== state.owner_id) throw new Error("Prepared projection root identity is invalid");
    const recordId = key;
    const cipher = await encryptOwnerPayload({
      ownerId: state.owner_id,
      store: "projection",
      recordId,
      keyId: snapshot.metadata.key_id,
      key: snapshot.auth.crypto_key,
      payload: value,
    });
    rows.push({
      id: `${state.owner_id}:${recordId}`,
      owner_id: state.owner_id,
      record_id: recordId,
      key_id: snapshot.metadata.key_id,
      ...cipher,
      root_kind: key.slice(0, separator),
      root_id: key.slice(separator + 1),
    });
  }
  return rows;
}
