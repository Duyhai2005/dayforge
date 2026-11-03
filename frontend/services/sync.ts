import {
  assertHash,
  assertOperationEnvelope,
  assertVersionInfo,
  compareDecimal,
  hashOperation,
  parseSyncPageResponse,
  serializePushRequest,
  type DecimalCursor,
  type Operation,
  type SyncPage,
  type SyncProtocolLimits,
  type UUID,
} from "../lib/sync/protocol";

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  request_id: UUID;
  retryable: boolean;
  server_time: string;
  field_errors?: Array<{ path: string; code: string }>;
  retry_after_seconds?: number;
}

export interface VersionInfo {
  api_major: 1;
  protocol_versions: [1];
  reducer_versions: [1];
  server_time: string;
  limits: SyncProtocolLimits;
}

export interface ClockView {
  calibration_id: UUID;
  server_time_ms: number;
  server_time: string;
  max_future_skew_ms: 300_000;
}

export interface Receipt {
  operation_id: UUID;
  request_hash: string;
  recorded: true;
  commit_cursor: DecimalCursor;
  effect_at_commit: "applied" | "superseded" | "no_op";
  reason_at_commit: string | null;
}

export type PushResult =
  | { operation_id: UUID; status: "recorded" | "duplicate"; receipt: Receipt }
  | { operation_id: UUID; status: "deferred"; problem: Problem }
  | { operation_id: UUID | null; status: "rejected"; problem: Problem };

export interface PushResponse {
  epoch: UUID;
  head_cursor: DecimalCursor;
  results: PushResult[];
}

export class SyncHttpError extends Error {
  readonly status: number;
  readonly problem: Problem | null;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, problem: Problem | null, retryAfterMs: number | null) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
    this.problem = problem;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.includes(key));
}

function assertUuid(value: unknown, label: string): asserts value is UUID {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${label} is not a supported lowercase UUID`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} is not a UTC millisecond timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is not a valid UTC timestamp`);
  }
}

function assertProblem(value: unknown, expectedStatus?: number): asserts value is Problem {
  if (!isRecord(value)) throw new Error("problem response is not an object");
  const required = ["type", "title", "status", "detail", "instance", "code", "request_id", "retryable", "server_time"];
  const allowed = [...required, "field_errors", "retry_after_seconds"];
  if (!hasKeys(value, required, allowed)) throw new Error("problem response has an invalid shape");
  if (typeof value.type !== "string" || typeof value.title !== "string" || !value.title ||
      !Number.isInteger(value.status) || (value.status as number) < 400 || (value.status as number) > 599 ||
      typeof value.detail !== "string" || typeof value.instance !== "string" ||
      typeof value.code !== "string" || !value.code || typeof value.retryable !== "boolean") {
    throw new Error("problem response contains invalid fields");
  }
  assertUuid(value.request_id, "problem.request_id");
  assertTimestamp(value.server_time, "problem.server_time");
  if (expectedStatus !== undefined && value.status !== expectedStatus) throw new Error("problem status does not match HTTP status");
  if (value.retry_after_seconds !== undefined && (!Number.isInteger(value.retry_after_seconds) || (value.retry_after_seconds as number) < 0)) {
    throw new Error("problem.retry_after_seconds is invalid");
  }
  if (value.field_errors !== undefined && (!Array.isArray(value.field_errors) || value.field_errors.some((entry) =>
      !isRecord(entry) || !hasKeys(entry, ["path", "code"], ["path", "code"]) || typeof entry.path !== "string" || typeof entry.code !== "string"))) {
    throw new Error("problem.field_errors is invalid");
  }
}

function parseRetryAfter(response: Response, problem: Problem | null): number | null {
  const header = response.headers.get("Retry-After");
  let headerMs: number | null = null;
  if (header !== null) {
    if (/^\d+$/.test(header)) {
      headerMs = Number(header) * 1000;
    } else {
      const dateMs = Date.parse(header);
      if (Number.isFinite(dateMs)) headerMs = Math.max(0, dateMs - Date.now());
    }
  }
  const problemMs = problem?.retry_after_seconds === undefined ? null : problem.retry_after_seconds * 1000;
  if (headerMs !== null && problemMs !== null && /^\d+$/.test(header ?? "") && headerMs !== problemMs) {
    throw new Error("Retry-After does not match problem.retry_after_seconds");
  }
  return headerMs === null ? problemMs : problemMs === null ? headerMs : Math.max(headerMs, problemMs);
}

function parseJson(rawBody: string, label: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readResponse(response: Response): Promise<string> {
  return response.text();
}

function assertNoStore(response: Response): void {
  const value = response.headers.get("Cache-Control") ?? "";
  if (!value.split(",").some((directive) => directive.trim().toLowerCase() === "no-store")) {
    throw new Error("sync response is missing Cache-Control: no-store");
  }
}

async function send(path: string, options: {
  method?: "GET" | "POST";
  body?: string;
  csrfToken?: string;
  signal?: AbortSignal;
  requireNoStore?: boolean;
} = {}): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json, application/problem+json" });
  if (method === "POST") {
    if (!options.csrfToken || !/^[A-Za-z0-9_-]{43}$/.test(options.csrfToken)) {
      throw new Error("a valid session CSRF token is required for sync POST");
    }
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", options.csrfToken);
  }

  const response = await fetch(path, {
    method,
    headers,
    body: method === "POST" ? options.body : undefined,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal: options.signal,
  });
  if (options.requireNoStore !== false) assertNoStore(response);
  if (!response.ok) {
    const rawBody = await readResponse(response);
    let problem: Problem | null = null;
    const contentType = (response.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType === "application/problem+json" || contentType === "application/json") {
      try {
        const parsed = parseJson(rawBody, "problem response");
        assertProblem(parsed, response.status);
        problem = parsed;
      } catch {
        // Preserve the HTTP failure even when the server's problem body is malformed.
      }
    }
    throw new SyncHttpError(
      response.status,
      problem?.code ?? `sync_http_${response.status}`,
      problem,
      parseRetryAfter(response, problem),
    );
  }
  return response;
}

async function readVersionResponse(response: Response): Promise<VersionInfo> {
  const parsed = parseJson(await readResponse(response), "version response");
  assertVersionInfo(parsed);
  return parsed;
}

async function readPageResponse(response: Response): Promise<SyncPage> {
  return parseSyncPageResponse(await readResponse(response));
}

function assertPageOwner(page: SyncPage, verifiedOwnerId: UUID): void {
  assertUuid(verifiedOwnerId, "verified_owner_id");
  for (const group of page.groups) {
    if (group.operation.owner_id !== verifiedOwnerId) {
      throw new Error(`sync page contains an operation for another owner: ${group.operation.operation_id}`);
    }
  }
}

export async function getVersion(signal?: AbortSignal): Promise<VersionInfo> {
  const response = await send("/api/v1/version", { signal, requireNoStore: false });
  return readVersionResponse(response);
}

export async function getClock(input: {
  deviceId: UUID;
  verifiedOwnerId: UUID;
  signal?: AbortSignal;
}): Promise<ClockView> {
  assertUuid(input.verifiedOwnerId, "verified_owner_id");
  const deviceId = input.deviceId;
  assertUuid(deviceId, "device_id");
  const query = new URLSearchParams({ device_id: deviceId });
  const response = await send(`/api/v1/sync/clock?${query}`, { signal: input.signal });
  const value = parseJson(await readResponse(response), "clock response");
  if (!isRecord(value) || !hasKeys(value,
    ["calibration_id", "server_time_ms", "server_time", "max_future_skew_ms"],
    ["calibration_id", "server_time_ms", "server_time", "max_future_skew_ms"],
  )) throw new Error("clock response has an invalid shape");
  assertUuid(value.calibration_id, "clock.calibration_id");
  if (!Number.isSafeInteger(value.server_time_ms) || (value.server_time_ms as number) < 0) throw new Error("clock.server_time_ms is invalid");
  assertTimestamp(value.server_time, "clock.server_time");
  if (Date.parse(value.server_time) !== value.server_time_ms || value.max_future_skew_ms !== 300_000) {
    throw new Error("clock response time or skew limit is inconsistent with protocol v1");
  }
  return value as unknown as ClockView;
}

export async function bootstrap(input: {
  verifiedOwnerId: UUID;
  pageToken?: string;
  signal?: AbortSignal;
}): Promise<SyncPage> {
  assertUuid(input.verifiedOwnerId, "verified_owner_id");
  if (input.pageToken !== undefined && (input.pageToken.length < 1 || input.pageToken.length > 4096)) {
    throw new Error("bootstrap page token must contain 1..4096 characters");
  }
  const query = input.pageToken === undefined ? "" : `?${new URLSearchParams({ page_token: input.pageToken })}`;
  const response = await send(`/api/v1/sync/bootstrap${query}`, { signal: input.signal });
  const page = await readPageResponse(response);
  assertPageOwner(page, input.verifiedOwnerId);
  return page;
}

export async function pull(input: {
  epoch: UUID;
  verifiedOwnerId: UUID;
  after?: DecimalCursor;
  pageToken?: string;
}, signal?: AbortSignal): Promise<SyncPage> {
  assertUuid(input.verifiedOwnerId, "verified_owner_id");
  assertUuid(input.epoch, "pull.epoch");
  if (input.pageToken !== undefined && (input.pageToken.length < 1 || input.pageToken.length > 4096)) {
    throw new Error("pull page token must contain 1..4096 characters");
  }
  let query: URLSearchParams;
  if (input.pageToken !== undefined) {
    if (input.after !== undefined) throw new Error("pull continuation must use only page_token");
    query = new URLSearchParams({ page_token: input.pageToken });
  } else {
    if (input.after === undefined) throw new Error("first pull request requires after cursor");
    compareDecimal(input.after, "0");
    query = new URLSearchParams({ epoch: input.epoch, after: input.after });
  }
  const response = await send(`/api/v1/sync/pull?${query}`, { signal });
  const page = await readPageResponse(response);
  assertPageOwner(page, input.verifiedOwnerId);
  return page;
}

function assertReceipt(value: unknown, operation: Operation, expectedHash: string): asserts value is Receipt {
  if (!isRecord(value) || !hasKeys(value,
    ["operation_id", "request_hash", "recorded", "commit_cursor", "effect_at_commit", "reason_at_commit"],
    ["operation_id", "request_hash", "recorded", "commit_cursor", "effect_at_commit", "reason_at_commit"],
  )) throw new Error("push receipt has an invalid shape");
  assertUuid(value.operation_id, "receipt.operation_id");
  assertHash(value.request_hash, "receipt.request_hash");
  if (value.operation_id !== operation.operation_id || value.request_hash !== expectedHash || value.recorded !== true) {
    throw new Error(`receipt does not acknowledge the exact operation envelope ${operation.operation_id}`);
  }
  if (typeof value.commit_cursor !== "string" || compareDecimal(value.commit_cursor, "0") <= 0) {
    throw new Error("receipt.commit_cursor must be a positive uint64 cursor");
  }
  if (!["applied", "superseded", "no_op"].includes(String(value.effect_at_commit))) {
    throw new Error("receipt.effect_at_commit is invalid");
  }
  if (value.reason_at_commit !== null && (typeof value.reason_at_commit !== "string" || value.reason_at_commit.length === 0)) {
    throw new Error("receipt.reason_at_commit is invalid");
  }
  if (value.effect_at_commit === "no_op" && ![
    "duplicate_target", "reference_unavailable", "target_retired", "precondition_failed", "undo_not_applicable",
  ].includes(String(value.reason_at_commit))) throw new Error("no_op receipt is missing a supported reason");
}

function assertPushResponse(value: unknown, operations: readonly Operation[], hashes: readonly string[]): asserts value is PushResponse {
  if (!isRecord(value) || !hasKeys(value, ["epoch", "head_cursor", "results"], ["epoch", "head_cursor", "results"])) {
    throw new Error("push response has an invalid shape");
  }
  assertUuid(value.epoch, "push.epoch");
  if (typeof value.head_cursor !== "string") throw new Error("push.head_cursor is invalid");
  compareDecimal(value.head_cursor, "0");
  if (!Array.isArray(value.results) || value.results.length !== operations.length) throw new Error("push result count does not match the request");

  for (let index = 0; index < operations.length; index += 1) {
    const result = value.results[index];
    if (!isRecord(result) || typeof result.status !== "string") throw new Error(`push result ${index} has an invalid shape`);
    if (result.status === "recorded" || result.status === "duplicate") {
      if (!hasKeys(result, ["operation_id", "status", "receipt"], ["operation_id", "status", "receipt"])) {
        throw new Error(`push result ${index} has unexpected fields`);
      }
      assertUuid(result.operation_id, `results[${index}].operation_id`);
      if (result.operation_id !== operations[index].operation_id) throw new Error(`push result ${index} is out of request order`);
      assertReceipt(result.receipt, operations[index], hashes[index]);
    } else if (result.status === "deferred" || result.status === "rejected") {
      if (!hasKeys(result, ["operation_id", "status", "problem"], ["operation_id", "status", "problem"])) {
        throw new Error(`push result ${index} has unexpected fields`);
      }
      if (result.operation_id !== operations[index].operation_id) throw new Error(`push failure ${index} does not match the request operation`);
      assertProblem(result.problem);
    } else {
      throw new Error(`push result ${index} has an unsupported status`);
    }
  }
}

export async function push(input: {
  operations: readonly Operation[];
  verifiedOwnerId: UUID;
  csrfToken: string;
  signal?: AbortSignal;
}): Promise<PushResponse> {
  assertUuid(input.verifiedOwnerId, "verified_owner_id");
  for (const operation of input.operations) {
    assertOperationEnvelope(operation);
    if (operation.owner_id !== input.verifiedOwnerId) throw new Error("cannot push an operation for a different signed-in owner");
  }

  const body = serializePushRequest(input.operations);
  const hashes = await Promise.all(input.operations.map(hashOperation));
  const response = await send("/api/v1/sync/push", {
    method: "POST",
    body,
    csrfToken: input.csrfToken,
    signal: input.signal,
  });
  const parsed = parseJson(await readResponse(response), "push response");
  assertPushResponse(parsed, input.operations, hashes);
  return parsed;
}
