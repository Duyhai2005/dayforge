import { StorageError } from "./errors";
import { type EncryptedRecord } from "./crypto";
import { type HlcEditTime, validateHlc } from "./clock-state";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

const VALID_ACTIONS_BY_KIND: Record<SupportedRootKind, readonly SupportedAction[]> = {
  plan: ["plan.create", "plan.replace", "undo"],
  milestone: ["milestone.create", "milestone.replace", "milestone.delete", "undo"],
  work_item: [
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
  ],
};

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
  action: SupportedAction;
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

const VALID_COLORS = new Set([
  "neutral",
  "earth",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "coral",
  "sand",
]);

const VALID_PERIODS = new Set(["morning", "afternoon", "evening"]);

function validatePlanData(data: unknown, prefix: string): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new StorageError("invalid_data", `${prefix} data must be a non-null object`);
  }
  const obj = data as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== "name" && k !== "color_id") {
      throw new StorageError("invalid_data", `${prefix} data contains unknown property '${k}'`);
    }
  }
  if (
    typeof obj.name !== "string" ||
    obj.name.length < 1 ||
    obj.name.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(obj.name)
  ) {
    throw new StorageError("invalid_data", `${prefix} data.name must be 1..100 chars without control characters`);
  }
  if (typeof obj.color_id !== "string" || !VALID_COLORS.has(obj.color_id)) {
    throw new StorageError("invalid_data", `${prefix} data.color_id must be a valid Color`);
  }
}

function validateMilestoneData(data: unknown, prefix: string): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new StorageError("invalid_data", `${prefix} data must be a non-null object`);
  }
  const obj = data as Record<string, unknown>;
  const allowed = new Set([
    "title",
    "date",
    "period",
    "note",
    "plan_id",
    "standalone_color_id",
    "show_in_work_calendar",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new StorageError("invalid_data", `${prefix} data contains unknown property '${k}'`);
    }
  }
  if (
    typeof obj.title !== "string" ||
    obj.title.length < 1 ||
    obj.title.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(obj.title)
  ) {
    throw new StorageError("invalid_data", `${prefix} data.title must be 1..120 chars without control characters`);
  }
  if (typeof obj.date !== "string" || !DATE_PATTERN.test(obj.date)) {
    throw new StorageError("invalid_data", `${prefix} data.date must be YYYY-MM-DD`);
  }
  if (obj.period !== null && (typeof obj.period !== "string" || !VALID_PERIODS.has(obj.period))) {
    throw new StorageError("invalid_data", `${prefix} data.period must be Period or null`);
  }
  if (
    typeof obj.note !== "string" ||
    [...obj.note].length > 4000 ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(obj.note)
  ) {
    throw new StorageError("invalid_data", `${prefix} data.note must be a string up to 4000 chars without control characters`);
  }
  if (obj.plan_id !== null && (typeof obj.plan_id !== "string" || !UUID_PATTERN.test(obj.plan_id))) {
    throw new StorageError("invalid_data", `${prefix} data.plan_id must be UUID or null`);
  }
  if (typeof obj.standalone_color_id !== "string" || !VALID_COLORS.has(obj.standalone_color_id)) {
    throw new StorageError("invalid_data", `${prefix} data.standalone_color_id must be a valid Color`);
  }
  if (typeof obj.show_in_work_calendar !== "boolean") {
    throw new StorageError("invalid_data", `${prefix} data.show_in_work_calendar must be a boolean`);
  }
}

function validateTaskData(data: unknown, prefix: string): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new StorageError("invalid_data", `${prefix} data must be a non-null object`);
  }
  const obj = data as Record<string, unknown>;
  const allowed = new Set([
    "title",
    "date",
    "period",
    "duration_minutes",
    "plan_id",
    "standalone_color_id",
    "status",
    "order_key",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new StorageError("invalid_data", `${prefix} data contains unknown property '${k}'`);
    }
  }
  if (
    typeof obj.title !== "string" ||
    obj.title.length < 1 ||
    obj.title.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(obj.title)
  ) {
    throw new StorageError("invalid_data", `${prefix} data.title must be 1..120 chars without control characters`);
  }
  if (typeof obj.date !== "string" || !DATE_PATTERN.test(obj.date)) {
    throw new StorageError("invalid_data", `${prefix} data.date must be YYYY-MM-DD`);
  }
  if (typeof obj.period !== "string" || !VALID_PERIODS.has(obj.period)) {
    throw new StorageError("invalid_data", `${prefix} data.period must be Period`);
  }
  if (
    obj.duration_minutes !== null &&
    (typeof obj.duration_minutes !== "number" ||
      !Number.isInteger(obj.duration_minutes) ||
      obj.duration_minutes < 1 ||
      obj.duration_minutes > 1440)
  ) {
    throw new StorageError("invalid_data", `${prefix} data.duration_minutes must be integer 1..1440 or null`);
  }
  if (obj.plan_id !== null && (typeof obj.plan_id !== "string" || !UUID_PATTERN.test(obj.plan_id))) {
    throw new StorageError("invalid_data", `${prefix} data.plan_id must be UUID or null`);
  }
  if (typeof obj.standalone_color_id !== "string" || !VALID_COLORS.has(obj.standalone_color_id)) {
    throw new StorageError("invalid_data", `${prefix} data.standalone_color_id must be Color`);
  }
  if (obj.status !== "pending" && obj.status !== "completed") {
    throw new StorageError("invalid_data", `${prefix} data.status must be 'pending' or 'completed'`);
  }
  if (
    typeof obj.order_key !== "string" ||
    obj.order_key.length > 20 ||
    !/^(0|-?[1-9][0-9]*)$/.test(obj.order_key)
  ) {
    throw new StorageError("invalid_data", `${prefix} data.order_key must be signed int64 decimal string`);
  }
}

function validateTaskTemplate(template: unknown, prefix: string): void {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new StorageError("invalid_data", `${prefix} template must be a non-null object`);
  }
  const obj = template as Record<string, unknown>;
  const allowed = new Set([
    "title",
    "period",
    "duration_minutes",
    "plan_id",
    "standalone_color_id",
    "order_key",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new StorageError("invalid_data", `${prefix} template contains unknown property '${k}'`);
    }
  }
  if (
    typeof obj.title !== "string" ||
    obj.title.length < 1 ||
    obj.title.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(obj.title)
  ) {
    throw new StorageError("invalid_data", `${prefix} template.title must be 1..120 chars`);
  }
  if (typeof obj.period !== "string" || !VALID_PERIODS.has(obj.period)) {
    throw new StorageError("invalid_data", `${prefix} template.period must be Period`);
  }
  if (
    obj.duration_minutes !== null &&
    (typeof obj.duration_minutes !== "number" ||
      !Number.isInteger(obj.duration_minutes) ||
      obj.duration_minutes < 1 ||
      obj.duration_minutes > 1440)
  ) {
    throw new StorageError("invalid_data", `${prefix} template.duration_minutes must be integer 1..1440 or null`);
  }
  if (obj.plan_id !== null && (typeof obj.plan_id !== "string" || !UUID_PATTERN.test(obj.plan_id))) {
    throw new StorageError("invalid_data", `${prefix} template.plan_id must be UUID or null`);
  }
  if (typeof obj.standalone_color_id !== "string" || !VALID_COLORS.has(obj.standalone_color_id)) {
    throw new StorageError("invalid_data", `${prefix} template.standalone_color_id must be Color`);
  }
  if (
    typeof obj.order_key !== "string" ||
    obj.order_key.length > 20 ||
    !/^(0|-?[1-9][0-9]*)$/.test(obj.order_key)
  ) {
    throw new StorageError("invalid_data", `${prefix} template.order_key must be signed int64 decimal string`);
  }
}

function validateRecurrenceRule(rule: unknown, prefix: string): void {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new StorageError("invalid_data", `${prefix} rule must be a non-null object`);
  }
  const obj = rule as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== "weekdays") {
      throw new StorageError("invalid_data", `${prefix} rule contains unknown property '${k}'`);
    }
  }
  if (!Array.isArray(obj.weekdays) || obj.weekdays.length < 1 || obj.weekdays.length > 7) {
    throw new StorageError("invalid_data", `${prefix} rule.weekdays must be array of 1..7 integers`);
  }
  const seen = new Set<number>();
  for (const day of obj.weekdays) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7 || seen.has(day)) {
      throw new StorageError("invalid_data", `${prefix} rule.weekdays must contain unique integers 1..7`);
    }
    seen.add(day);
  }
}

function validateTaskTarget(target: unknown, prefix: string): void {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new StorageError("invalid_data", `${prefix} target must be a non-null object`);
  }
  const obj = target as Record<string, unknown>;
  if (obj.kind === "single") {
    for (const k of Object.keys(obj)) {
      if (k !== "kind") throw new StorageError("invalid_data", `${prefix} target single has unknown property '${k}'`);
    }
  } else if (obj.kind === "occurrence") {
    for (const k of Object.keys(obj)) {
      if (k !== "kind" && k !== "source_segment_id" && k !== "original_date") {
        throw new StorageError("invalid_data", `${prefix} target occurrence has unknown property '${k}'`);
      }
    }
    if (typeof obj.source_segment_id !== "string" || !UUID_PATTERN.test(obj.source_segment_id)) {
      throw new StorageError("invalid_data", `${prefix} target.source_segment_id must be UUID`);
    }
    if (typeof obj.original_date !== "string" || !DATE_PATTERN.test(obj.original_date)) {
      throw new StorageError("invalid_data", `${prefix} target.original_date must be YYYY-MM-DD`);
    }
  } else if (obj.kind === "detached") {
    for (const k of Object.keys(obj)) {
      if (k !== "kind" && k !== "task_id") {
        throw new StorageError("invalid_data", `${prefix} target detached has unknown property '${k}'`);
      }
    }
    if (typeof obj.task_id !== "string" || !UUID_PATTERN.test(obj.task_id)) {
      throw new StorageError("invalid_data", `${prefix} target.task_id must be UUID`);
    }
  } else {
    throw new StorageError("invalid_data", `${prefix} target.kind must be 'single', 'occurrence', or 'detached'`);
  }
}

export function validateCommand(cmd: unknown, index = 0): cmd is StorageCommand {
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} must be a non-null object`
    );
  }
  const candidate = cmd as Partial<StorageCommand>;

  for (const k of Object.keys(cmd as object)) {
    if (k !== "root" && k !== "action" && k !== "payload" && k !== "precondition") {
      throw new StorageError(
        "invalid_data",
        `Command at index ${index} contains unknown property '${k}'`
      );
    }
  }

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

  for (const k of Object.keys(candidate.root as object)) {
    if (k !== "kind" && k !== "id") {
      throw new StorageError(
        "invalid_data",
        `Command at index ${index} root contains unknown property '${k}'`
      );
    }
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
      `Command at index ${index} root id must be a valid canonical UUID: '${candidate.root.id}'`
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

  const allowedActions = VALID_ACTIONS_BY_KIND[kind];
  if (!allowedActions.includes(candidate.action as SupportedAction)) {
    throw new StorageError(
      "invalid_data",
      `Command at index ${index} action '${candidate.action}' is not supported for root kind '${kind}'`
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

  const pKeys = Object.keys(candidate.payload);
  const prefix = `Command at index ${index}`;

  switch (candidate.action) {
    case "plan.create":
    case "plan.replace": {
      for (const k of pKeys) {
        if (k !== "data") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (!candidate.payload.data) {
        throw new StorageError("invalid_data", `${prefix} payload missing required property 'data'`);
      }
      validatePlanData(candidate.payload.data, prefix);
      break;
    }
    case "milestone.create":
    case "milestone.replace": {
      for (const k of pKeys) {
        if (k !== "data") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (!candidate.payload.data) {
        throw new StorageError("invalid_data", `${prefix} payload missing required property 'data'`);
      }
      validateMilestoneData(candidate.payload.data, prefix);
      break;
    }
    case "milestone.delete":
    case "single.delete": {
      if (pKeys.length > 0) {
        throw new StorageError("invalid_data", `${prefix} payload for '${candidate.action}' must be empty object`);
      }
      break;
    }
    case "work_item.create_single":
    case "single.replace": {
      for (const k of pKeys) {
        if (k !== "data") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (!candidate.payload.data) {
        throw new StorageError("invalid_data", `${prefix} payload missing required property 'data'`);
      }
      validateTaskData(candidate.payload.data, prefix);
      break;
    }
    case "work_item.create_recurrence": {
      for (const k of pKeys) {
        if (k !== "start_date" && k !== "rule" && k !== "template") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.start_date !== "string" || !DATE_PATTERN.test(candidate.payload.start_date)) {
        throw new StorageError("invalid_data", `${prefix} payload.start_date must be YYYY-MM-DD`);
      }
      validateRecurrenceRule(candidate.payload.rule, prefix);
      validateTaskTemplate(candidate.payload.template, prefix);
      break;
    }
    case "work_item.enable_recurrence": {
      for (const k of pKeys) {
        if (k !== "data" && k !== "rule") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      validateTaskData(candidate.payload.data, prefix);
      validateRecurrenceRule(candidate.payload.rule, prefix);
      break;
    }
    case "occurrence.replace": {
      for (const k of pKeys) {
        if (k !== "source_segment_id" && k !== "original_date" && k !== "data") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.source_segment_id !== "string" || !UUID_PATTERN.test(candidate.payload.source_segment_id)) {
        throw new StorageError("invalid_data", `${prefix} payload.source_segment_id must be UUID`);
      }
      if (typeof candidate.payload.original_date !== "string" || !DATE_PATTERN.test(candidate.payload.original_date)) {
        throw new StorageError("invalid_data", `${prefix} payload.original_date must be YYYY-MM-DD`);
      }
      validateTaskData(candidate.payload.data, prefix);
      break;
    }
    case "occurrence.delete": {
      for (const k of pKeys) {
        if (k !== "source_segment_id" && k !== "original_date") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.source_segment_id !== "string" || !UUID_PATTERN.test(candidate.payload.source_segment_id)) {
        throw new StorageError("invalid_data", `${prefix} payload.source_segment_id must be UUID`);
      }
      if (typeof candidate.payload.original_date !== "string" || !DATE_PATTERN.test(candidate.payload.original_date)) {
        throw new StorageError("invalid_data", `${prefix} payload.original_date must be YYYY-MM-DD`);
      }
      break;
    }
    case "detached.replace": {
      for (const k of pKeys) {
        if (k !== "task_id" && k !== "data") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.task_id !== "string" || !UUID_PATTERN.test(candidate.payload.task_id)) {
        throw new StorageError("invalid_data", `${prefix} payload.task_id must be UUID`);
      }
      validateTaskData(candidate.payload.data, prefix);
      break;
    }
    case "detached.delete": {
      for (const k of pKeys) {
        if (k !== "task_id") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.task_id !== "string" || !UUID_PATTERN.test(candidate.payload.task_id)) {
        throw new StorageError("invalid_data", `${prefix} payload.task_id must be UUID`);
      }
      break;
    }
    case "series.edit_future": {
      for (const k of pKeys) {
        if (k !== "source_segment_id" && k !== "cutoff_original_date" && k !== "rule" && k !== "template") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.source_segment_id !== "string" || !UUID_PATTERN.test(candidate.payload.source_segment_id)) {
        throw new StorageError("invalid_data", `${prefix} payload.source_segment_id must be UUID`);
      }
      if (typeof candidate.payload.cutoff_original_date !== "string" || !DATE_PATTERN.test(candidate.payload.cutoff_original_date)) {
        throw new StorageError("invalid_data", `${prefix} payload.cutoff_original_date must be YYYY-MM-DD`);
      }
      validateRecurrenceRule(candidate.payload.rule, prefix);
      validateTaskTemplate(candidate.payload.template, prefix);
      break;
    }
    case "series.stop_future": {
      for (const k of pKeys) {
        if (k !== "source_segment_id" && k !== "cutoff_original_date") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.source_segment_id !== "string" || !UUID_PATTERN.test(candidate.payload.source_segment_id)) {
        throw new StorageError("invalid_data", `${prefix} payload.source_segment_id must be UUID`);
      }
      if (typeof candidate.payload.cutoff_original_date !== "string" || !DATE_PATTERN.test(candidate.payload.cutoff_original_date)) {
        throw new StorageError("invalid_data", `${prefix} payload.cutoff_original_date must be YYYY-MM-DD`);
      }
      break;
    }
    case "set_order": {
      for (const k of pKeys) {
        if (k !== "target" && k !== "order_key" && k !== "intent") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      validateTaskTarget(candidate.payload.target, prefix);
      if (
        typeof candidate.payload.order_key !== "string" ||
        candidate.payload.order_key.length > 20 ||
        !/^(0|-?[1-9][0-9]*)$/.test(candidate.payload.order_key)
      ) {
        throw new StorageError("invalid_data", `${prefix} payload.order_key must be signed int64 decimal string`);
      }
      if (candidate.payload.intent !== "user_reorder" && candidate.payload.intent !== "rank_maintenance") {
        throw new StorageError("invalid_data", `${prefix} payload.intent must be 'user_reorder' or 'rank_maintenance'`);
      }
      if (
        !candidate.precondition ||
        typeof candidate.precondition !== "object" ||
        typeof candidate.precondition.expected_root_hash !== "string" ||
        !HASH_PATTERN.test(candidate.precondition.expected_root_hash)
      ) {
        throw new StorageError("invalid_data", `${prefix} action 'set_order' requires a precondition with 'expected_root_hash'`);
      }
      break;
    }
    case "undo": {
      for (const k of pKeys) {
        if (k !== "original_operation_id" && k !== "expected_states") {
          throw new StorageError("invalid_data", `${prefix} payload contains unknown property '${k}'`);
        }
      }
      if (typeof candidate.payload.original_operation_id !== "string" || !UUID_PATTERN.test(candidate.payload.original_operation_id)) {
        throw new StorageError("invalid_data", `${prefix} payload.original_operation_id must be UUID`);
      }
      if (!Array.isArray(candidate.payload.expected_states) || candidate.payload.expected_states.length === 0 || candidate.payload.expected_states.length > 1000) {
        throw new StorageError("invalid_data", `${prefix} payload.expected_states must be array of 1..1000 items`);
      }
      for (let sIdx = 0; sIdx < candidate.payload.expected_states.length; sIdx++) {
        const state = candidate.payload.expected_states[sIdx] as Record<string, unknown>;
        if (!state || typeof state !== "object") {
          throw new StorageError("invalid_data", `${prefix} expected_states[${sIdx}] must be an object`);
        }
        const stateRoot = state.root as Record<string, unknown> | undefined;
        if (!stateRoot || typeof stateRoot !== "object" || !stateRoot.kind || !stateRoot.id) {
          throw new StorageError("invalid_data", `${prefix} expected_states[${sIdx}].root must have kind and id`);
        }
        if (stateRoot.kind !== "plan" && stateRoot.kind !== "milestone" && stateRoot.kind !== "work_item") {
          throw new StorageError("invalid_data", `${prefix} expected_states[${sIdx}].root.kind must be plan, milestone, or work_item`);
        }
        if (typeof stateRoot.id !== "string" || !UUID_PATTERN.test(stateRoot.id as string)) {
          throw new StorageError("invalid_data", `${prefix} expected_states[${sIdx}].root.id must be UUID`);
        }
        if (typeof state.hash !== "string" || !HASH_PATTERN.test(state.hash)) {
          throw new StorageError("invalid_data", `${prefix} expected_states[${sIdx}].hash must be 64-hex string`);
        }
      }
      break;
    }
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

  let hasUndo = false;
  let hasSetOrder = false;
  let hasExpectedBucket = false;

  for (let i = 0; i < input.commands.length; i++) {
    const rawCmd = input.commands[i];
    validateCommand(rawCmd, i);
    const cmd = rawCmd as StorageCommand;
    if (cmd.action === "undo") {
      hasUndo = true;
    }
    if (cmd.action === "set_order") {
      hasSetOrder = true;
    }
    if (cmd.precondition?.expected_bucket) {
      hasExpectedBucket = true;
    }
  }

  if (hasUndo && input.commands.length !== 1) {
    throw new StorageError(
      "invalid_data",
      `Operation with 'undo' action must contain exactly 1 command (got ${input.commands.length})`
    );
  }

  if (hasSetOrder && !hasExpectedBucket) {
    throw new StorageError(
      "invalid_data",
      "Operation containing 'set_order' action must include an 'expected_bucket' precondition guard"
    );
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
