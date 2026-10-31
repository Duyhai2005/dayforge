import { StorageError } from "./errors";
import { type EncryptedRecord } from "./crypto";
import { type HlcEditTime, validateHlc } from "./clock-state";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export type SupportedRootKind = "plan" | "milestone" | "work_item";

export const SUPPORTED_ACTIONS = [
  "plan.create",
  "plan.replace",
  "milestone.create",
  "milestone.replace",
  "milestone.delete",
  "work_item.create_single",
  "work_item.create_recurrence",
  "work_item.enable_recurrence",
  "single.replace",
  "single.delete",
  "occurrence.replace",
  "occurrence.delete",
  "detached.replace",
  "detached.delete",
  "series.edit_future",
  "series.stop_future",
  "set_order",
  "undo",
] as const;

export type SupportedAction = (typeof SUPPORTED_ACTIONS)[number];

export interface StorageBucketPrecondition {
  date: string;
  period: "morning" | "afternoon" | "evening";
  order_hash: string;
}

export interface StoragePrecondition {
  expected_root_hash?: string;
  expected_bucket?: StorageBucketPrecondition;
}

export interface StorageCommand {
  root: {
    kind: SupportedRootKind;
    id: string;
  };
  action: SupportedAction | string;
  payload: Record<string, unknown>;
  precondition?: null | StoragePrecondition;
}

export interface OperationEnvelope {
  protocol_version: 1;
  reducer_version: 1;
  operation_id: string; // UUID
  owner_id: string; // UUID
  device_id: string; // UUID
  device_sequence: string; // unsigned 64-bit decimal string, e.g. "1"
  edit_time: HlcEditTime;
  dependencies: readonly string[];
  commands: readonly StorageCommand[];
}

export type OutboxStatus =
  | "queued"
  | "sending"
  | "ack_waiting_pull"
  | "blocked"
  | "time_invalid"
  | "superseded_by"
  | "pending";

export interface OutboxEntry {
  owner_id: string;
  operation_id: string;
  device_sequence: string;
  status: OutboxStatus;
  request_hash: string; // 64-hex SHA-256 of JCS canonical JSON
  superseded_by?: string;
  encrypted_envelope: EncryptedRecord;
  created_at: string;
}

export function validateCommand(cmd: unknown, index = 0): cmd is StorageCommand {
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} must be a non-null object`
    );
  }
  const candidate = cmd as Partial<StorageCommand>;

  if (
    !candidate.root ||
    typeof candidate.root !== "object" ||
    Array.isArray(candidate.root)
  ) {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} missing 'root' object`
    );
  }

  const kind = candidate.root.kind;
  if (kind !== "plan" && kind !== "milestone" && kind !== "work_item") {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} has unsupported root kind '${String(kind)}'`
    );
  }

  if (
    typeof candidate.root.id !== "string" ||
    !UUID_PATTERN.test(candidate.root.id)
  ) {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} root id must be a valid UUID: '${candidate.root.id}'`
    );
  }

  if (
    typeof candidate.action !== "string" ||
    !(SUPPORTED_ACTIONS as readonly string[]).includes(candidate.action)
  ) {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} has unsupported action '${String(candidate.action)}'`
    );
  }

  if (
    !candidate.payload ||
    typeof candidate.payload !== "object" ||
    Array.isArray(candidate.payload)
  ) {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} payload must be a non-null object`
    );
  }

  if (
    candidate.precondition !== undefined &&
    candidate.precondition !== null
  ) {
    if (
      typeof candidate.precondition !== "object" ||
      Array.isArray(candidate.precondition)
    ) {
      throw new StorageError(
        "invalid_data",
        `Command at index ${index} precondition must be null or an object`
      );
    }
    const preKeys = Object.keys(candidate.precondition);
    if (preKeys.length === 0) {
      throw new StorageError(
        "invalid_data",
        `Command at index ${index} precondition must not be empty`
      );
    }
    for (const key of preKeys) {
      if (key !== "expected_root_hash" && key !== "expected_bucket") {
        throw new StorageError(
          "invalid_data",
          `Command at index ${index} precondition contains unknown property '${key}'`
        );
      }
    }
    if (candidate.precondition.expected_root_hash !== undefined) {
      if (
        typeof candidate.precondition.expected_root_hash !== "string" ||
        !HASH_PATTERN.test(candidate.precondition.expected_root_hash)
      ) {
        throw new StorageError(
          "invalid_data",
          `Command at index ${index} precondition expected_root_hash must be a 64-hex string`
        );
      }
    }
    if (candidate.precondition.expected_bucket !== undefined) {
      const bucket = candidate.precondition.expected_bucket as unknown as Record<string, unknown>;
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
        throw new StorageError(
          "invalid_data",
          `Command at index ${index} precondition expected_bucket must be an object`
        );
      }
      const bKeys = Object.keys(bucket);
      for (const bk of bKeys) {
        if (bk !== "date" && bk !== "period" && bk !== "order_hash") {
          throw new StorageError(
            "invalid_data",
            `Command at index ${index} precondition expected_bucket contains unknown property '${bk}'`
          );
        }
      }
      if (typeof bucket.date !== "string" || !DATE_PATTERN.test(bucket.date)) {
        throw new StorageError(
          "invalid_data",
          `Command at index ${index} precondition expected_bucket date must be YYYY-MM-DD`
        );
      }
      if (
        bucket.period !== "morning" &&
        bucket.period !== "afternoon" &&
        bucket.period !== "evening"
      ) {
        throw new StorageError(
          "invalid_data",
          `Command at index ${index} precondition expected_bucket period must be morning, afternoon, or evening`
        );
      }
      if (
        typeof bucket.order_hash !== "string" ||
        !HASH_PATTERN.test(bucket.order_hash)
      ) {
        throw new StorageError(
          "invalid_data",
          `Command at index ${index} precondition expected_bucket order_hash must be a 64-hex string`
        );
      }
    }
  }

  return true;
}

export function validateOperationDraft(input: {
  operationId: string;
  ownerId?: string;
  deviceId: string;
  commands: readonly unknown[];
  dependencies: readonly string[];
  editTime?: HlcEditTime;
}): void {
  if (
    typeof input.operationId !== "string" ||
    !UUID_PATTERN.test(input.operationId)
  ) {
    throw new StorageError(
      "invalid_data",
      `Invalid operation ID: '${input.operationId}'`
    );
  }

  if (
    input.ownerId !== undefined &&
    (typeof input.ownerId !== "string" || !UUID_PATTERN.test(input.ownerId))
  ) {
    throw new StorageError(
      "invalid_data",
      `Invalid owner ID: '${input.ownerId}'`
    );
  }

  if (
    typeof input.deviceId !== "string" ||
    !UUID_PATTERN.test(input.deviceId)
  ) {
    throw new StorageError(
      "invalid_data",
      `Invalid device ID: '${input.deviceId}'`
    );
  }

  if (!Array.isArray(input.commands)) {
    throw new StorageError(
      "invalid_data",
      "Operation 'commands' must be an array"
    );
  }

  if (input.commands.length === 0 || input.commands.length > 1000) {
    throw new StorageError(
      "invalid_data",
      `Operation commands length must be between 1 and 1000 (got ${input.commands.length})`
    );
  }

  for (let i = 0; i < input.commands.length; i++) {
    validateCommand(input.commands[i], i);
  }

  if (!Array.isArray(input.dependencies)) {
    throw new StorageError(
      "invalid_data",
      "Operation 'dependencies' must be an array"
    );
  }

  if (input.dependencies.length > 1000) {
    throw new StorageError(
      "invalid_data",
      `Operation dependencies length must not exceed 1000 (got ${input.dependencies.length})`
    );
  }

  const seenDeps = new Set<string>();
  for (let i = 0; i < input.dependencies.length; i++) {
    const dep = input.dependencies[i];
    if (typeof dep !== "string" || !UUID_PATTERN.test(dep)) {
      throw new StorageError(
        "invalid_data",
        `Dependency at index ${i} is not a valid UUID: '${dep}'`
      );
    }
    if (seenDeps.has(dep)) {
      throw new StorageError(
        "invalid_data",
        `Duplicate dependency UUID at index ${i}: '${dep}'`
      );
    }
    seenDeps.add(dep);
  }

  if (input.editTime !== undefined && !validateHlc(input.editTime)) {
    throw new StorageError(
      "invalid_data",
      "Operation 'editTime' contains invalid HLC fields"
    );
  }
}

function hasLoneSurrogates(str: string): boolean {
  if (typeof str.isWellFormed === "function") {
    return !str.isWellFormed();
  }
  // Regex checking for unpaired high or low surrogate code units
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    str
  );
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  const valType = typeof value;

  if (valType === "boolean") {
    return value ? "true" : "false";
  }

  if (valType === "bigint") {
    throw new StorageError(
      "invalid_data",
      "BigInt values are not supported in canonical JSON"
    );
  }

  if (valType === "number") {
    const num = value as number;
    if (!Number.isFinite(num)) {
      throw new StorageError(
        "invalid_data",
        "Non-finite numbers (NaN, Infinity) are not permitted in canonical JSON"
      );
    }
    if (Object.is(num, -0)) {
      return "0";
    }
    return JSON.stringify(num);
  }

  if (valType === "string") {
    const str = value as string;
    if (hasLoneSurrogates(str)) {
      throw new StorageError(
        "invalid_data",
        "Strings with unpaired surrogate code points are forbidden in canonical JSON (RFC 8785)"
      );
    }
    return JSON.stringify(str);
  }

  if (valType === "undefined" || valType === "function" || valType === "symbol") {
    throw new StorageError(
      "invalid_data",
      `Cannot canonicalize primitive value of type ${valType}`
    );
  }

  // Handle toJSON() if present
  if (
    value &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    return canonicalizeJson((value as { toJSON: () => unknown }).toJSON());
  }

  if (Array.isArray(value)) {
    const serializedElements = value.map((element) => {
      if (
        element === undefined ||
        typeof element === "function" ||
        typeof element === "symbol"
      ) {
        return "null";
      }
      return canonicalizeJson(element);
    });
    return `[${serializedElements.join(",")}]`;
  }

  // Plain object
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries: string[] = [];

  for (const key of keys) {
    if (hasLoneSurrogates(key)) {
      throw new StorageError(
        "invalid_data",
        "Object key with unpaired surrogate code points is forbidden in canonical JSON (RFC 8785)"
      );
    }
    const propVal = obj[key];
    if (
      propVal === undefined ||
      typeof propVal === "function" ||
      typeof propVal === "symbol"
    ) {
      continue;
    }
    const serializedKey = JSON.stringify(key);
    const serializedVal = canonicalizeJson(propVal);
    entries.push(`${serializedKey}:${serializedVal}`);
  }

  return `{${entries.join(",")}}`;
}

export async function sha256Hex(data: string): Promise<string> {
  const c =
    typeof crypto !== "undefined"
      ? crypto
      : (globalThis as unknown as { crypto?: Crypto }).crypto;

  if (!c || !c.subtle) {
    throw new StorageError(
      "unavailable",
      "Web Crypto API (subtle) is not available"
    );
  }

  const encoded = new TextEncoder().encode(data);
  const digestBuffer = await c.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digestBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function computeCanonicalHash(
  value: unknown
): Promise<{ canonicalJson: string; hash: string }> {
  const canonicalJson = canonicalizeJson(value);
  const hash = await sha256Hex(canonicalJson);
  return { canonicalJson, hash };
}
