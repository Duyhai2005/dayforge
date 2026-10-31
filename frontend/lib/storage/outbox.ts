import { StorageError } from "./errors";
import { type EncryptedRecord } from "./crypto";
import { type HlcEditTime } from "./clock-state";

export interface OperationEnvelope {
  protocol_version: 1;
  reducer_version: 1;
  operation_id: string; // UUID
  owner_id: string; // UUID
  device_id: string; // UUID
  device_sequence: string; // unsigned 64-bit decimal string, e.g. "1"
  edit_time: HlcEditTime;
  dependencies: readonly string[];
  commands: readonly unknown[];
}

export type OutboxStatus =
  | "pending"
  | "ack_waiting_pull"
  | "blocked"
  | "time_invalid"
  | "superseded_by";

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

export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  const valType = typeof value;

  if (valType === "boolean") {
    return value ? "true" : "false";
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
    return JSON.stringify(value);
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
