/**
 * Client-side primitives for DAYFORGE sync protocol v1.
 *
 * This module deliberately has no storage, authentication, transport, or reducer
 * side effects. Those layers can build on these checks without changing a
 * committed operation envelope.
 */

export type UUID = string;
export type DecimalCursor = string;
export type EditTimeQuality = "calibrated" | "offline_estimate" | "untrusted";

export interface EditTime {
  physical_ms: number;
  logical: number;
  calibration_id: UUID;
  raw_wall_ms: number;
  quality: EditTimeQuality;
}

export interface SyncCommand {
  root: { kind: "plan" | "milestone" | "work_item"; id: UUID };
  action: string;
  payload: Record<string, unknown>;
  precondition: Record<string, unknown> | null;
}

export interface Operation {
  protocol_version: 1;
  reducer_version: 1;
  operation_id: UUID;
  owner_id: UUID;
  device_id: UUID;
  device_sequence: DecimalCursor;
  edit_time: EditTime;
  dependencies: UUID[];
  commands: SyncCommand[];
}

export interface EventGroup {
  cursor: DecimalCursor;
  committed_at: string;
  operation: Operation;
}

export interface SyncPage {
  epoch: UUID;
  through_cursor: DecimalCursor;
  next_cursor: DecimalCursor;
  has_more: boolean;
  next_page_token: string | null;
  groups: EventGroup[];
}

export interface SyncProtocolLimits {
  push_operations: 100;
  push_request_bytes: 8_388_608;
  operation_bytes: 2_097_152;
  commands_per_operation: 1000;
  page_operations: 200;
  page_bytes: 8_388_608;
  page_token_ttl_seconds: 1800;
}

export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncProtocolError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UINT64_MAX = BigInt("18446744073709551615");
const UINT32_MAX = 4_294_967_295;
const OPERATION_MAX_BYTES = 2_097_152;
const PUSH_MAX_BYTES = 8_388_608;
const PUSH_MAX_OPERATIONS = 100;
const PAGE_MAX_BYTES = 8_388_608;
const PAGE_MAX_GROUPS = 200;

function fail(message: string): never {
  throw new SyncProtocolError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function assertUuid(value: unknown, label: string): asserts value is UUID {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(`${label} must be a lowercase RFC 4122 UUID v4 or v5`);
  }
}

function assertUInt64Decimal(value: unknown, label: string, allowZero: boolean): asserts value is DecimalCursor {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !(allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value) ||
    BigInt(value) > UINT64_MAX
  ) {
    fail(`${label} must be a canonical unsigned 64-bit decimal string`);
  }
}

function assertSafeMillis(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function assertEditTime(value: unknown): asserts value is EditTime {
  if (!isRecord(value) || !hasExactKeys(value, ["physical_ms", "logical", "calibration_id", "raw_wall_ms", "quality"])) {
    fail("edit_time has an invalid shape");
  }
  assertSafeMillis(value.physical_ms, "edit_time.physical_ms");
  assertSafeMillis(value.raw_wall_ms, "edit_time.raw_wall_ms");
  if (!Number.isInteger(value.logical) || (value.logical as number) < 0 || (value.logical as number) > UINT32_MAX) {
    fail("edit_time.logical must be an unsigned 32-bit integer");
  }
  assertUuid(value.calibration_id, "edit_time.calibration_id");
  if (!["calibrated", "offline_estimate", "untrusted"].includes(String(value.quality))) {
    fail("edit_time.quality is not supported by protocol v1");
  }
}

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${label} contains an unpaired UTF-16 surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${label} contains an unpaired UTF-16 surrogate`);
    }
  }
}

/** Validate that a value can be represented as strict JSON data. */
function assertJsonValue(value: unknown, label: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertValidUnicode(value, label);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") {
    fail(`${label} contains a value that is not JSON data`);
  }
  if (ancestors.has(value)) fail(`${label} contains a circular reference`);
  ancestors.add(value);

  if (Array.isArray(value)) {
    const ownKeys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== value.length + 1 || ownKeys.length !== value.length || ownKeys.some((key, index) => key !== String(index))) {
      fail(`${label} contains a sparse array or non-index array property`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) fail(`${label}[${index}] must be a data property`);
      assertJsonValue(descriptor.value, `${label}[${index}]`, ancestors);
    }
  } else {
    if (!isRecord(value)) fail(`${label} contains an object with a non-JSON prototype`);
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      fail(`${label} contains a symbol or non-enumerable property`);
    }
    for (const key of Object.keys(value)) {
      assertValidUnicode(key, `${label} key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail(`${label}.${key} must be a data property`);
      assertJsonValue(descriptor.value, `${label}.${key}`, ancestors);
    }
  }

  ancestors.delete(value);
}

/** RFC 8785 JSON Canonicalization Scheme serialization for JSON data. */
export function canonicalizeJson(value: unknown): string {
  assertJsonValue(value, "value", new Set());

  const serialize = (item: unknown): string => {
    if (item === null || typeof item === "boolean" || typeof item === "string" || typeof item === "number") {
      const encoded = JSON.stringify(item);
      if (encoded === undefined) fail("value cannot be serialized as JSON");
      return encoded;
    }
    if (Array.isArray(item)) {
      return `[${item.map(serialize).join(",")}]`;
    }
    const record = item as Record<string, unknown>;
    // JavaScript's default string sort is UTF-16 code-unit ordering, as required by JCS.
    const members = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`);
    return `{${members.join(",")}}`;
  };

  return serialize(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** SHA-256 of an operation's canonical UTF-8 envelope bytes. */
export async function hashOperation(operation: Operation): Promise<string> {
  assertOperationEnvelope(operation);
  const bytes = new TextEncoder().encode(canonicalizeJson(operation));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertHash(value: unknown, label = "hash"): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail(`${label} must be 64 lowercase hexadecimal characters`);
}

/** Checks the stable envelope structure and protocol limits; command payload semantics belong to the reducer. */
export function assertOperationEnvelope(value: unknown): asserts value is Operation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "protocol_version", "reducer_version", "operation_id", "owner_id", "device_id",
    "device_sequence", "edit_time", "dependencies", "commands",
  ])) {
    fail("operation envelope has an invalid shape");
  }
  if (value.protocol_version !== 1 || value.reducer_version !== 1) fail("unsupported protocol or reducer version");
  assertUuid(value.operation_id, "operation_id");
  assertUuid(value.owner_id, "owner_id");
  assertUuid(value.device_id, "device_id");
  assertUInt64Decimal(value.device_sequence, "device_sequence", false);
  assertEditTime(value.edit_time);

  if (!Array.isArray(value.dependencies) || value.dependencies.length > 1000) fail("dependencies must contain at most 1000 UUIDs");
  const dependencies = new Set<string>();
  for (const dependency of value.dependencies) {
    assertUuid(dependency, "dependency");
    if (dependencies.has(dependency)) fail("dependencies must be unique");
    dependencies.add(dependency);
  }

  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 1000) {
    fail("commands must contain between 1 and 1000 items");
  }
  for (const [index, command] of value.commands.entries()) {
    if (!isRecord(command) || !hasExactKeys(command, ["root", "action", "payload", "precondition"])) {
      fail(`commands[${index}] has an invalid shape`);
    }
    if (!isRecord(command.root) || !hasExactKeys(command.root, ["kind", "id"])) {
      fail(`commands[${index}].root has an invalid shape`);
    }
    if (!["plan", "milestone", "work_item"].includes(String(command.root.kind))) {
      fail(`commands[${index}].root.kind is not supported`);
    }
    assertUuid(command.root.id, `commands[${index}].root.id`);
    if (typeof command.action !== "string" || command.action.length === 0) fail(`commands[${index}].action is required`);
    if (!isRecord(command.payload)) fail(`commands[${index}].payload must be an object`);
    if (command.precondition !== null && !isRecord(command.precondition)) {
      fail(`commands[${index}].precondition must be an object or null`);
    }
  }

  const bytes = utf8ByteLength(canonicalizeJson(value));
  if (bytes > OPERATION_MAX_BYTES) fail("operation exceeds the 2 MiB UTF-8 limit");
}

/** Decimal strings are compared without conversion through an imprecise JS number. */
export function compareDecimal(left: DecimalCursor, right: DecimalCursor): number {
  assertUInt64Decimal(left, "left decimal", true);
  assertUInt64Decimal(right, "right decimal", true);
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEditClock(left: EditTime, right: EditTime): number {
  if (left.physical_ms !== right.physical_ms) return left.physical_ms < right.physical_ms ? -1 : 1;
  if (left.logical !== right.logical) return left.logical < right.logical ? -1 : 1;
  return 0;
}

function deleteRank(operation: Operation): 0 | 1 {
  return operation.commands.some((command) => command.action === "series.stop_future" || /(?:^|\.)delete$/.test(command.action)) ? 1 : 0;
}

/** Compare total edit order K; canonical UUID hex order equals network-byte order. */
export function compareOperations(left: Operation, right: Operation): number {
  const clockOrder = compareEditClock(left.edit_time, right.edit_time);
  if (clockOrder !== 0) return clockOrder;
  const leftRank = deleteRank(left);
  const rightRank = deleteRank(right);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  const leftDevice = left.device_id.replaceAll("-", "");
  const rightDevice = right.device_id.replaceAll("-", "");
  if (leftDevice !== rightDevice) return leftDevice < rightDevice ? -1 : 1;
  const leftId = left.operation_id.replaceAll("-", "");
  const rightId = right.operation_id.replaceAll("-", "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export interface DependencyOrder {
  ready: Operation[];
  blocked: Array<{ operation: Operation; dependency_ids: UUID[] }>;
}

/**
 * Order a pending batch by K while enforcing recorded/in-batch dependencies.
 * `knownOperations` must contain only authenticated, recorded events for this owner.
 */
export function orderOperationsByDependencies(
  pending: readonly Operation[],
  knownOperations: ReadonlyMap<UUID, Operation> = new Map(),
): DependencyOrder {
  const byId = new Map<UUID, Operation>();
  let ownerId: UUID | null = null;
  for (const operation of pending) {
    assertOperationEnvelope(operation);
    if (ownerId !== null && ownerId !== operation.owner_id) fail("a pending batch cannot mix owners");
    ownerId = operation.owner_id;
    if (byId.has(operation.operation_id)) fail(`duplicate operation_id in pending batch: ${operation.operation_id}`);
    if (knownOperations.has(operation.operation_id)) fail(`pending operation_id is already recorded: ${operation.operation_id}`);
    byId.set(operation.operation_id, operation);
  }

  for (const operation of knownOperations.values()) {
    assertOperationEnvelope(operation);
    if (ownerId !== null && operation.owner_id !== ownerId) fail("known recorded operations must be scoped to the pending owner");
  }
  const all = new Map(knownOperations);
  for (const [id, operation] of byId) all.set(id, operation);

  const missingById = new Map<UUID, Set<UUID>>();
  for (const operation of pending) {
    const missing = new Set<UUID>();
    for (const dependencyId of operation.dependencies) {
      const dependency = all.get(dependencyId);
      if (!dependency) {
        missing.add(dependencyId);
        continue;
      }
      if (dependency.owner_id !== operation.owner_id) fail(`dependency ${dependencyId} belongs to a different owner`);
      if (compareEditClock(dependency.edit_time, operation.edit_time) >= 0) {
        fail(`dependency ${dependencyId} must have an earlier HLC than ${operation.operation_id}`);
      }
    }
    missingById.set(operation.operation_id, missing);
  }

  // A pending operation with a missing dependency also blocks its descendants.
  let changed = true;
  while (changed) {
    changed = false;
    for (const operation of pending) {
      const missing = missingById.get(operation.operation_id)!;
      for (const dependencyId of operation.dependencies) {
        if (byId.has(dependencyId) && missingById.get(dependencyId)!.size > 0 && !missing.has(dependencyId)) {
          missing.add(dependencyId);
          changed = true;
        }
      }
    }
  }

  const ready = pending.filter((operation) => missingById.get(operation.operation_id)!.size === 0).sort(compareOperations);
  const blocked = pending
    .filter((operation) => missingById.get(operation.operation_id)!.size > 0)
    .map((operation) => ({ operation, dependency_ids: [...missingById.get(operation.operation_id)!].sort() }));
  return { ready, blocked };
}

export interface EditTimeSeed {
  utc_estimate_ms: number;
  raw_wall_ms: number;
  calibration_id: UUID;
  quality: EditTimeQuality;
  local?: Pick<EditTime, "physical_ms" | "logical"> | null;
  observed?: readonly Pick<EditTime, "physical_ms" | "logical">[];
}

/** Create the next HLC value; callers must commit it with sequence and operation in one storage transaction. */
export function nextEditTime(seed: EditTimeSeed): EditTime {
  assertSafeMillis(seed.utc_estimate_ms, "utc_estimate_ms");
  assertSafeMillis(seed.raw_wall_ms, "raw_wall_ms");
  assertUuid(seed.calibration_id, "calibration_id");

  const prior = [...(seed.local ? [seed.local] : []), ...(seed.observed ?? [])];
  for (const time of prior) {
    assertSafeMillis(time.physical_ms, "observed physical_ms");
    if (!Number.isInteger(time.logical) || time.logical < 0 || time.logical > UINT32_MAX) {
      fail("observed logical must be an unsigned 32-bit integer");
    }
  }

  const largestPriorPhysical = prior.reduce((largest, time) => Math.max(largest, time.physical_ms), -1);
  const physicalMs = Math.max(seed.utc_estimate_ms, largestPriorPhysical);
  let logical = 0;
  if (physicalMs === largestPriorPhysical) {
    const largestPriorLogical = prior
      .filter((time) => time.physical_ms === physicalMs)
      .reduce((largest, time) => Math.max(largest, time.logical), -1);
    logical = largestPriorLogical + 1;
  }
  if (logical > UINT32_MAX) fail("HLC logical counter exhausted; a new device lane is required");

  return {
    physical_ms: physicalMs,
    logical,
    calibration_id: seed.calibration_id,
    raw_wall_ms: seed.raw_wall_ms,
    quality: seed.quality,
  };
}

export function assertSyncPage(value: unknown): asserts value is SyncPage {
  if (!isRecord(value) || !hasExactKeys(value, [
    "epoch", "through_cursor", "next_cursor", "has_more", "next_page_token", "groups",
  ])) fail("sync page has an invalid shape");
  assertUuid(value.epoch, "page.epoch");
  assertUInt64Decimal(value.through_cursor, "page.through_cursor", true);
  assertUInt64Decimal(value.next_cursor, "page.next_cursor", true);
  if (typeof value.has_more !== "boolean") fail("page.has_more must be a boolean");
  if (value.next_page_token !== null && (typeof value.next_page_token !== "string" || value.next_page_token.length < 1 || value.next_page_token.length > 4096)) {
    fail("page.next_page_token must be null or a 1..4096 character token");
  }
  if (!Array.isArray(value.groups) || value.groups.length > PAGE_MAX_GROUPS) fail("page.groups exceeds the 200 group limit");
  if (value.has_more && (value.groups.length === 0 || typeof value.next_page_token !== "string")) {
    fail("a continuing page must contain a group and a next-page token");
  }
  if (!value.has_more && value.next_page_token !== null) fail("a final page must not have a next-page token");

  let previousCursor: DecimalCursor | null = null;
  for (const [index, group] of value.groups.entries()) {
    if (!isRecord(group) || !hasExactKeys(group, ["cursor", "committed_at", "operation"])) {
      fail(`page.groups[${index}] has an invalid shape`);
    }
    assertUInt64Decimal(group.cursor, `page.groups[${index}].cursor`, false);
    if (typeof group.committed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(group.committed_at) || !Number.isFinite(Date.parse(group.committed_at))) {
      fail(`page.groups[${index}].committed_at must be a UTC millisecond timestamp`);
    }
    assertOperationEnvelope(group.operation);
    if (previousCursor !== null && compareDecimal(group.cursor, previousCursor) <= 0) {
      fail("page group cursors must be strictly increasing");
    }
    if (compareDecimal(group.cursor, value.through_cursor as string) > 0) fail("group cursor cannot exceed the page watermark");
    previousCursor = group.cursor;
  }

  if (!value.has_more && compareDecimal(value.next_cursor as string, value.through_cursor as string) !== 0) {
    fail("a final page next_cursor must equal through_cursor");
  }
  if (value.groups.length > 0 && compareDecimal(value.groups[value.groups.length - 1].cursor, value.next_cursor as string) !== 0) {
    fail("page next_cursor must equal the final returned group cursor");
  }
  if (value.has_more && value.groups.length > 0 && compareDecimal(value.next_cursor as string, value.through_cursor as string) >= 0) {
    fail("a continuing page must leave at least one cursor before the watermark");
  }

}

/** Parse the raw response so the page byte limit is checked against actual wire bytes. */
export function parseSyncPageResponse(rawBody: string): SyncPage {
  if (utf8ByteLength(rawBody) > PAGE_MAX_BYTES) fail("page exceeds the 8 MiB UTF-8 limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    fail("sync page is not valid JSON");
  }
  assertSyncPage(parsed);
  return parsed;
}

/** Validates the exact v1 /version compatibility and limits advertised by T03. */
export function assertVersionInfo(value: unknown): asserts value is {
  api_major: 1;
  protocol_versions: [1];
  reducer_versions: [1];
  server_time: string;
  limits: SyncProtocolLimits;
} {
  if (!isRecord(value) || !hasExactKeys(value, ["api_major", "protocol_versions", "reducer_versions", "server_time", "limits"])) {
    fail("version response has an invalid shape");
  }
  if (value.api_major !== 1 || !Array.isArray(value.protocol_versions) || value.protocol_versions.length !== 1 || value.protocol_versions[0] !== 1 ||
      !Array.isArray(value.reducer_versions) || value.reducer_versions.length !== 1 || value.reducer_versions[0] !== 1) {
    fail("server does not advertise the supported v1 protocol/reducer");
  }
  if (typeof value.server_time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.server_time) || !Number.isFinite(Date.parse(value.server_time))) {
    fail("version.server_time must be a UTC millisecond timestamp");
  }
  const limits = value.limits;
  if (!isRecord(limits) || !hasExactKeys(limits, [
    "push_operations", "push_request_bytes", "operation_bytes", "commands_per_operation",
    "page_operations", "page_bytes", "page_token_ttl_seconds",
  ])) fail("version.limits has an invalid shape");
  const expected: SyncProtocolLimits = {
    push_operations: 100,
    push_request_bytes: 8_388_608,
    operation_bytes: 2_097_152,
    commands_per_operation: 1000,
    page_operations: 200,
    page_bytes: 8_388_608,
    page_token_ttl_seconds: 1800,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (limits[key] !== expectedValue) fail(`server version limit ${key} is incompatible with protocol v1`);
  }
}

/** Serialize a push batch without changing any operation and enforce the published request limits. */
export function serializePushRequest(operations: readonly Operation[]): string {
  if (operations.length < 1 || operations.length > PUSH_MAX_OPERATIONS) fail("push must contain 1..100 operations");
  for (const operation of operations) assertOperationEnvelope(operation);
  const body = canonicalizeJson({ operations });
  if (utf8ByteLength(body) > PUSH_MAX_BYTES) fail("push request exceeds the 8 MiB UTF-8 limit");
  return body;
}
