import {
  assertOperationEnvelope,
  canonicalizeJson,
  compareOperations,
  orderOperationsByDependencies,
  type Operation,
  type SyncCommand,
  type UUID,
} from "./protocol";

export type Period = "morning" | "afternoon" | "evening";
export type ColorId = "neutral" | "earth" | "green" | "teal" | "blue" | "purple" | "pink" | "coral" | "sand";
export type RootKind = "plan" | "milestone" | "work_item";

export interface RootRef { kind: RootKind; id: UUID }
export interface PlanData { name: string; color_id: ColorId }
export interface TaskData {
  title: string;
  date: string;
  period: Period;
  duration_minutes: number | null;
  plan_id: UUID | null;
  standalone_color_id: ColorId;
  status: "pending" | "completed";
  order_key: string;
}
export interface TaskTemplate {
  title: string;
  period: Period;
  duration_minutes: number | null;
  plan_id: UUID | null;
  standalone_color_id: ColorId;
  order_key: string;
}
export interface MilestoneData {
  title: string;
  date: string;
  period: Period | null;
  note: string;
  plan_id: UUID | null;
  standalone_color_id: ColorId;
  show_in_work_calendar: boolean;
}
export interface RecurrenceRule { weekdays: number[] }
export interface SegmentOrigin {
  segment_id: UUID;
  born_from_date: string;
  created_by_operation_id: UUID;
  command_index: number;
}
export interface RuleSegment {
  segment_id: UUID;
  from_date: string;
  until_date: string | null;
  rule: RecurrenceRule;
  template: TaskTemplate;
}
export interface OccurrenceOverride {
  override_id: UUID;
  original_date: string;
  source_segment_id: UUID;
  kind: "replacement" | "deleted" | "detached";
  replacement: TaskData | null;
  detached_task_id: UUID | null;
}
export interface OccurrenceOrderOverride {
  original_date: string;
  source_segment_id: UUID;
  order_key: string;
}
export interface DetachedTask {
  task_id: UUID;
  source_occurrence_id: UUID;
  original_date: string;
  data: TaskData;
  deleted: boolean;
}

export interface PlanRoot { owner_id: UUID; deleted: boolean; data: PlanData }
export interface MilestoneRoot { owner_id: UUID; deleted: boolean; data: MilestoneData }
export interface SingleWorkRoot {
  owner_id: UUID;
  deleted: boolean;
  kind: "single";
  single: TaskData;
  segment_origins: SegmentOrigin[];
  family: null;
}
export interface FamilyWorkRoot {
  owner_id: UUID;
  deleted: boolean;
  kind: "recurrence_family";
  single: null;
  segment_origins: SegmentOrigin[];
  family: { segments: RuleSegment[]; overrides: OccurrenceOverride[]; order_overrides: OccurrenceOrderOverride[]; detached: DetachedTask[] };
}
export type WorkRoot = SingleWorkRoot | FamilyWorkRoot;
export type RootValue = PlanRoot | MilestoneRoot | WorkRoot;

export interface ProjectionState {
  owner_id: UUID;
  roots: Record<string, RootValue>;
}
export type NoOpReason = "duplicate_target" | "reference_unavailable" | "target_retired" | "precondition_failed" | "undo_not_applicable";
export type OperationEffect = "applied" | "no_op";
export interface OperationOutcome {
  operation_id: UUID;
  effect: OperationEffect;
  reason: NoOpReason | null;
  changed_roots: RootRef[];
}
export interface ReplayResult { state: ProjectionState; outcomes: OperationOutcome[] }

export class ReducerValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ReducerValidationError"; }
}
class ReducerNoOp extends Error {
  constructor(readonly reason: NoOpReason) { super(reason); this.name = "ReducerNoOp"; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const COLORS = new Set<ColorId>(["neutral", "earth", "green", "teal", "blue", "purple", "pink", "coral", "sand"]);
const PERIODS = new Set<Period>(["morning", "afternoon", "evening"]);
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function rootKey(root: RootRef): string { return `${root.kind}:${root.id}`; }
function uuidOrder(id: UUID): string { return id.replaceAll("-", ""); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function clone<T>(value: T): T { return structuredClone(value); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ReducerValidationError(`${label} has an invalid field set`);
  }
}
function assertUuid(value: unknown, label: string): asserts value is UUID {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new ReducerValidationError(`${label} must be a lowercase UUID v4 or v5`);
}
function assertLocalDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^(\d{4})-(\d{2})-(\d{2})$/.test(value)) throw new ReducerValidationError(`${label} must be YYYY-MM-DD`);
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new ReducerValidationError(`${label} is not a Gregorian date`);
  }
}
function codePoints(value: string): number { return [...value].length; }
function assertCanonicalText(value: unknown, label: string, max: number, note = false): asserts value is string {
  if (typeof value !== "string") throw new ReducerValidationError(`${label} must be text`);
  const normalized = value.normalize("NFC");
  const canonical = note ? normalized.replace(/\r\n?/g, "\n") : normalized.trim();
  if (canonical !== value) throw new ReducerValidationError(`${label} is not canonical`);
  if (codePoints(value) > max || (!note && codePoints(value) < 1)) throw new ReducerValidationError(`${label} has an invalid length`);
  const controls = note ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (controls.test(value) || (!note && /[\r\n]/.test(value))) throw new ReducerValidationError(`${label} contains forbidden control characters`);
}
function assertColor(value: unknown, label: string): asserts value is ColorId {
  if (typeof value !== "string" || !COLORS.has(value as ColorId)) throw new ReducerValidationError(`${label} is not a supported color`);
}
function assertPeriod(value: unknown, label: string, nullable = false): asserts value is Period | null {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !PERIODS.has(value as Period)) throw new ReducerValidationError(`${label} is not a supported period`);
}
function assertPlanId(value: unknown, label: string): asserts value is UUID | null {
  if (value === null) return;
  assertUuid(value, label);
}
function assertOrderKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw new ReducerValidationError(`${label} must be a canonical signed integer string`);
  const rank = BigInt(value);
  if (rank < INT64_MIN || rank > INT64_MAX) throw new ReducerValidationError(`${label} is outside signed int64`);
}
function assertTaskData(value: unknown, label: string): asserts value is TaskData {
  if (!isRecord(value)) throw new ReducerValidationError(`${label} must be an object`);
  exactKeys(value, ["title", "date", "period", "duration_minutes", "plan_id", "standalone_color_id", "status", "order_key"], label);
  assertCanonicalText(value.title, `${label}.title`, 120);
  assertLocalDate(value.date, `${label}.date`);
  assertPeriod(value.period, `${label}.period`);
  if (value.duration_minutes !== null && (!Number.isInteger(value.duration_minutes) || (value.duration_minutes as number) < 1 || (value.duration_minutes as number) > 1440)) {
    throw new ReducerValidationError(`${label}.duration_minutes is invalid`);
  }
  assertPlanId(value.plan_id, `${label}.plan_id`);
  assertColor(value.standalone_color_id, `${label}.standalone_color_id`);
  if (value.status !== "pending" && value.status !== "completed") throw new ReducerValidationError(`${label}.status is invalid`);
  assertOrderKey(value.order_key, `${label}.order_key`);
}
function assertTaskTemplate(value: unknown, label: string): asserts value is TaskTemplate {
  if (!isRecord(value)) throw new ReducerValidationError(`${label} must be an object`);
  exactKeys(value, ["title", "period", "duration_minutes", "plan_id", "standalone_color_id", "order_key"], label);
  assertCanonicalText(value.title, `${label}.title`, 120);
  assertPeriod(value.period, `${label}.period`);
  if (value.duration_minutes !== null && (!Number.isInteger(value.duration_minutes) || (value.duration_minutes as number) < 1 || (value.duration_minutes as number) > 1440)) {
    throw new ReducerValidationError(`${label}.duration_minutes is invalid`);
  }
  assertPlanId(value.plan_id, `${label}.plan_id`);
  assertColor(value.standalone_color_id, `${label}.standalone_color_id`);
  assertOrderKey(value.order_key, `${label}.order_key`);
}
function assertPlanData(value: unknown, label: string): asserts value is PlanData {
  if (!isRecord(value)) throw new ReducerValidationError(`${label} must be an object`);
  exactKeys(value, ["name", "color_id"], label);
  assertCanonicalText(value.name, `${label}.name`, 100);
  assertColor(value.color_id, `${label}.color_id`);
}
function assertMilestoneData(value: unknown, label: string): asserts value is MilestoneData {
  if (!isRecord(value)) throw new ReducerValidationError(`${label} must be an object`);
  exactKeys(value, ["title", "date", "period", "note", "plan_id", "standalone_color_id", "show_in_work_calendar"], label);
  assertCanonicalText(value.title, `${label}.title`, 120);
  assertLocalDate(value.date, `${label}.date`);
  assertPeriod(value.period, `${label}.period`, true);
  assertCanonicalText(value.note, `${label}.note`, 4000, true);
  assertPlanId(value.plan_id, `${label}.plan_id`);
  assertColor(value.standalone_color_id, `${label}.standalone_color_id`);
  if (typeof value.show_in_work_calendar !== "boolean") throw new ReducerValidationError(`${label}.show_in_work_calendar is invalid`);
}
function assertRule(value: unknown, label: string): asserts value is RecurrenceRule {
  if (!isRecord(value)) throw new ReducerValidationError(`${label} must be an object`);
  exactKeys(value, ["weekdays"], label);
  const weekdays = value.weekdays;
  if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7 ||
      weekdays.some((day, index) => !Number.isInteger(day) || day < 1 || day > 7 || (index > 0 && day <= weekdays[index - 1]))) {
    throw new ReducerValidationError(`${label}.weekdays must be unique ascending ISO weekdays`);
  }
}

function isLeapYear(year: number): boolean { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }
function daysInMonth(year: number, month: number): number { return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]; }
function nextLocalDate(value: string): string {
  let [year, month, day] = value.split("-").map(Number);
  if (day < daysInMonth(year, month)) day += 1;
  else if (month < 12) { month += 1; day = 1; }
  else { year += 1; month = 1; day = 1; }
  if (year > 9999) throw new ReducerValidationError("Recurrence date range exceeds year 9999");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function isoWeekday(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  const priorYear = year - 1;
  const beforeYear = priorYear * 365 + Math.floor(priorYear / 4) - Math.floor(priorYear / 100) + Math.floor(priorYear / 400);
  const priorMonths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].slice(0, month - 1).reduce((a, b) => a + b, 0);
  return ((beforeYear + priorMonths + day - 1) % 7) + 1;
}
function dateBefore(left: string, right: string): boolean { return left < right; }
function dateBeforeOrEqual(left: string, right: string): boolean { return left <= right; }
function dateInSegment(date: string, segment: RuleSegment): boolean {
  return dateBeforeOrEqual(segment.from_date, date) && (segment.until_date === null || dateBefore(date, segment.until_date));
}
function compareDateThenId(a: { from_date: string; segment_id: UUID }, b: { from_date: string; segment_id: UUID }): number {
  return compareText(a.from_date, b.from_date) || compareText(uuidOrder(a.segment_id), uuidOrder(b.segment_id));
}
function sortFamily(root: FamilyWorkRoot): void {
  root.segment_origins.sort((a, b) => compareText(uuidOrder(a.segment_id), uuidOrder(b.segment_id)));
  root.family.segments.sort(compareDateThenId);
  root.family.overrides.sort((a, b) => compareText(a.original_date, b.original_date));
  root.family.order_overrides.sort((a, b) => compareText(a.original_date, b.original_date));
  root.family.detached.sort((a, b) => compareText(uuidOrder(a.task_id), uuidOrder(b.task_id)));
}
function semanticRootState(root: RootRef, value: RootValue | null): unknown {
  if (value === null) return null;
  if (root.kind === "plan" && "data" in value && !("kind" in value)) {
    const plan = value as PlanRoot;
    return { owner_id: plan.owner_id, deleted: plan.deleted, data: plan.data };
  }
  if (root.kind === "milestone" && "data" in value && !("kind" in value)) {
    const milestone = value as MilestoneRoot;
    return { owner_id: milestone.owner_id, deleted: milestone.deleted, data: milestone.data };
  }
  if (root.kind !== "work_item" || !("kind" in value)) throw new ReducerValidationError("Root kind does not match projection value");
  const item = value as WorkRoot;
  if (item.kind === "single") {
    return {
      owner_id: item.owner_id,
      deleted: item.deleted,
      kind: "single",
      single: item.single,
      segment_origins: [...item.segment_origins].sort((a, b) => compareText(uuidOrder(a.segment_id), uuidOrder(b.segment_id))),
      family: null,
    };
  }
  const family = clone(item);
  sortFamily(family);
  return {
    owner_id: family.owner_id,
    deleted: family.deleted,
    kind: "recurrence_family",
    single: null,
    segment_origins: family.segment_origins,
    family: {
      segments: family.family.segments,
      overrides: family.family.overrides,
      order_overrides: family.family.order_overrides,
      detached: family.family.detached,
    },
  };
}

async function sha256(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalizeJson(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function uuidV5(namespace: UUID, name: string): Promise<UUID> {
  const namespaceBytes = new Uint8Array(namespace.replaceAll("-", "").match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function semanticRootHash(root: RootRef, value: RootValue | null): Promise<string> {
  return sha256({ root, state: semanticRootState(root, value) });
}

function taskFromTemplate(template: TaskTemplate, date: string): TaskData {
  return {
    title: template.title,
    date,
    period: template.period,
    duration_minutes: template.duration_minutes,
    plan_id: template.plan_id,
    standalone_color_id: template.standalone_color_id,
    status: "pending",
    order_key: template.order_key,
  };
}
function matchingSegment(root: FamilyWorkRoot, date: string): RuleSegment | null {
  const matches = root.family.segments.filter((segment) => dateInSegment(date, segment) && segment.rule.weekdays.includes(isoWeekday(date)));
  if (matches.length > 1) throw new ReducerValidationError("Family segments overlap at an occurrence date");
  return matches[0] ?? null;
}
function findOverride(root: FamilyWorkRoot, date: string): OccurrenceOverride | null {
  return root.family.overrides.find((override) => override.original_date === date) ?? null;
}
async function occurrenceId(rootId: UUID, date: string): Promise<UUID> { return uuidV5(rootId, `occurrence:${date}`); }
async function overrideId(rootId: UUID, date: string): Promise<UUID> { return uuidV5(rootId, `override:${date}`); }
async function detachedId(rootId: UUID, date: string): Promise<UUID> { return uuidV5(rootId, `detached:${date}`); }
function activeOrderOverride(root: FamilyWorkRoot, date: string, segmentId: UUID): OccurrenceOrderOverride | null {
  return root.family.order_overrides.find((entry) => entry.original_date === date && entry.source_segment_id === segmentId) ?? null;
}

async function occurrenceData(root: FamilyWorkRoot, segment: RuleSegment, date: string): Promise<TaskData> {
  const override = findOverride(root, date);
  if (override) {
    if (override.kind !== "replacement" || !override.replacement) throw new ReducerNoOp("target_retired");
    return clone(override.replacement);
  }
  const data = taskFromTemplate(segment.template, date);
  const rank = activeOrderOverride(root, date, segment.segment_id);
  if (rank) data.order_key = rank.order_key;
  return data;
}

interface BucketCard { root_id: UUID; card_id: UUID; date: string; period: Period; order_key: string }
async function bucketCards(state: ProjectionState, date: string, period: Period): Promise<BucketCard[]> {
  const cards: BucketCard[] = [];
  for (const [key, value] of Object.entries(state.roots)) {
    const root = parseRootKey(key);
    if (!value || root.kind !== "work_item" || value.deleted || !("kind" in value)) continue;
    const rootId = root.id;
    const item = value as WorkRoot;
    if (item.kind === "single") {
      if (item.single.date === date && item.single.period === period) cards.push({ root_id: rootId, card_id: rootId, date, period, order_key: item.single.order_key });
      continue;
    }
    for (const child of item.family.detached) {
      if (!child.deleted && child.data.date === date && child.data.period === period) {
        cards.push({ root_id: rootId, card_id: child.task_id, date, period, order_key: child.data.order_key });
      }
    }
    for (const override of item.family.overrides) {
      if (override.kind === "replacement" && override.replacement?.date === date && override.replacement.period === period) {
        cards.push({
          root_id: rootId,
          card_id: await occurrenceId(rootId, override.original_date),
          date,
          period,
          order_key: override.replacement.order_key,
        });
      }
    }
    const segment = matchingSegment(item, date);
    if (!segment) continue;
    const override = findOverride(item, date);
    if (override) continue;
    const task = taskFromTemplate(segment.template, date);
    const rank = activeOrderOverride(item, date, segment.segment_id);
    if (rank) task.order_key = rank.order_key;
    if (task.period === period) cards.push({ root_id: rootId, card_id: await occurrenceId(rootId, date), date, period, order_key: task.order_key });
  }
  cards.sort((a, b) => {
    const ar = BigInt(a.order_key); const br = BigInt(b.order_key);
    return (ar < br ? -1 : ar > br ? 1 : 0) || compareText(uuidOrder(a.card_id), uuidOrder(b.card_id));
  });
  return cards;
}
export async function nextOrderKeyForBucket(state: ProjectionState, date: string, period: Period): Promise<string> {
  assertLocalDate(date, "bucket.date");
  const cards = await bucketCards(state, date, period);
  const last = cards.at(-1);
  if (!last) return "0";
  const lastRank = BigInt(last.order_key);
  const spacedRank = lastRank + 1024n;
  if (spacedRank <= INT64_MAX) return spacedRank.toString();
  if (lastRank < INT64_MAX) return INT64_MAX.toString();
  throw new Error("Không còn khoảng thứ tự để thêm công việc trong buổi này.");
}
export async function bucketOrderHash(state: ProjectionState, date: string, period: Period): Promise<string> {
  assertLocalDate(date, "bucket.date");
  return sha256({ date, period, cards: await bucketCards(state, date, period) });
}

function rootValue(state: ProjectionState, root: RootRef): RootValue | null { return state.roots[rootKey(root)] ?? null; }
function putRoot(state: ProjectionState, root: RootRef, value: RootValue): void { state.roots[rootKey(root)] = value; }
function rootKindMatches(root: RootRef, kind: RootKind): void {
  if (root.kind !== kind) throw new ReducerValidationError(`Action requires a ${kind} root`);
}
function payloadRecord(command: SyncCommand, keys: readonly string[]): Record<string, unknown> {
  const value = command.payload;
  exactKeys(value, keys, `${command.action}.payload`);
  return value;
}
function assertPlanExists(state: ProjectionState, planId: UUID | null, label: string): void {
  if (planId === null) return;
  const plan = rootValue(state, { kind: "plan", id: planId });
  if (!plan || "kind" in plan || plan.deleted) throw new ReducerNoOp("reference_unavailable");
}
function taskTemplate(data: TaskData): TaskTemplate {
  return {
    title: data.title,
    period: data.period,
    duration_minutes: data.duration_minutes,
    plan_id: data.plan_id,
    standalone_color_id: data.standalone_color_id,
    order_key: data.order_key,
  };
}
async function makeSegment(rootId: UUID, operation: Operation, commandIndex: number, fromDate: string, rule: RecurrenceRule, template: TaskTemplate): Promise<RuleSegment> {
  return {
    segment_id: await uuidV5(rootId, `segment:${operation.operation_id}:${commandIndex}`),
    from_date: fromDate,
    until_date: null,
    rule: clone(rule),
    template: clone(template),
  };
}
function makeFamilyRoot(ownerId: UUID, segment: RuleSegment, operationId: UUID, commandIndex: number): FamilyWorkRoot {
  const family: FamilyWorkRoot = {
    owner_id: ownerId,
    deleted: false,
    kind: "recurrence_family",
    single: null,
    segment_origins: [{
      segment_id: segment.segment_id,
      born_from_date: segment.from_date,
      created_by_operation_id: operationId,
      command_index: commandIndex,
    }],
    family: { segments: [segment], overrides: [], order_overrides: [], detached: [] },
  };
  return family;
}
function putOverride(root: FamilyWorkRoot, override: OccurrenceOverride): void {
  const index = root.family.overrides.findIndex((entry) => entry.original_date === override.original_date);
  if (index < 0) root.family.overrides.push(override);
  else root.family.overrides[index] = override;
}
function removeOrderOverride(root: FamilyWorkRoot, date: string): void {
  root.family.order_overrides = root.family.order_overrides.filter((entry) => entry.original_date !== date);
}
function sourceOrigin(root: FamilyWorkRoot, sourceId: UUID, cutoff: string): SegmentOrigin {
  const origin = root.segment_origins.find((candidate) => candidate.segment_id === sourceId);
  if (!origin || dateBefore(cutoff, origin.born_from_date)) throw new ReducerNoOp("target_retired");
  return origin;
}
async function assertFamilyIntegrity(rootId: UUID, root: FamilyWorkRoot): Promise<void> {
  const origins = new Map<UUID, SegmentOrigin>(root.segment_origins.map((origin) => [origin.segment_id, origin] as const));
  if (origins.size !== root.segment_origins.length) throw new ReducerValidationError("Segment origin ids must be unique");
  for (const origin of root.segment_origins) {
    exactKeys(origin as unknown as Record<string, unknown>, ["segment_id", "born_from_date", "created_by_operation_id", "command_index"], "segment_origin");
    assertLocalDate(origin.born_from_date, "segment_origin.born_from_date");
    assertUuid(origin.created_by_operation_id, "segment_origin.created_by_operation_id");
    if (!Number.isInteger(origin.command_index) || origin.command_index < 0 ||
        origin.segment_id !== await uuidV5(rootId, `segment:${origin.created_by_operation_id}:${origin.command_index}`)) {
      throw new ReducerValidationError("Segment origin provenance is invalid");
    }
  }
  const segments = [...root.family.segments].sort(compareDateThenId);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    exactKeys(segment as unknown as Record<string, unknown>, ["segment_id", "from_date", "until_date", "rule", "template"], "rule_segment");
    if (!origins.has(segment.segment_id)) throw new ReducerValidationError("Every rule segment must have an origin");
    if (origins.get(segment.segment_id)!.born_from_date !== segment.from_date) throw new ReducerValidationError("Segment origin date does not match the segment start");
    if (segment.until_date !== null && !dateBefore(segment.from_date, segment.until_date)) throw new ReducerValidationError("Rule segment interval is empty or inverted");
    if (segment.until_date !== null) assertLocalDate(segment.until_date, "segment.until_date");
    assertLocalDate(segment.from_date, "segment.from_date");
    assertRule(segment.rule, "segment.rule");
    assertTaskTemplate(segment.template, "segment.template");
    if (index > 0) {
      const previous = segments[index - 1];
      if (previous.until_date === null || dateBefore(segment.from_date, previous.until_date)) throw new ReducerValidationError("Rule segment intervals overlap");
    }
  }
  const overrides = new Set<string>();
  for (const override of root.family.overrides) {
    exactKeys(override as unknown as Record<string, unknown>, ["override_id", "original_date", "source_segment_id", "kind", "replacement", "detached_task_id"], "occurrence_override");
    assertLocalDate(override.original_date, "override.original_date");
    assertUuid(override.override_id, "override.override_id");
    assertUuid(override.source_segment_id, "override.source_segment_id");
    if (override.override_id !== await overrideId(rootId, override.original_date)) throw new ReducerValidationError("Occurrence override id is not canonical");
    if (overrides.has(override.original_date)) throw new ReducerValidationError("Occurrence override dates must be unique");
    overrides.add(override.original_date);
    if (!origins.has(override.source_segment_id)) throw new ReducerValidationError("Occurrence override source is not in the origin catalog");
    if (override.kind === "replacement") {
      if (!override.replacement || override.detached_task_id !== null) throw new ReducerValidationError("Replacement override payload is invalid");
      assertTaskData(override.replacement, "override.replacement");
      const segment = matchingSegment(root, override.original_date);
      if (!segment || segment.segment_id !== override.source_segment_id) throw new ReducerValidationError("Replacement override is not attached to its current source slot");
    } else if (override.kind === "deleted") {
      if (override.replacement !== null || override.detached_task_id !== null) throw new ReducerValidationError("Deleted override payload is invalid");
    } else if (override.kind === "detached") {
      if (override.replacement !== null || !override.detached_task_id) throw new ReducerValidationError("Detached override payload is invalid");
    } else throw new ReducerValidationError("Unsupported override kind");
  }
  const rankDates = new Set<string>();
  for (const order of root.family.order_overrides) {
    exactKeys(order as unknown as Record<string, unknown>, ["original_date", "source_segment_id", "order_key"], "occurrence_order_override");
    assertLocalDate(order.original_date, "order_override.original_date");
    assertUuid(order.source_segment_id, "order_override.source_segment_id");
    assertOrderKey(order.order_key, "order_override.order_key");
    if (rankDates.has(order.original_date) || overrides.has(order.original_date)) throw new ReducerValidationError("Rank override conflicts with another slot override");
    rankDates.add(order.original_date);
    if (!origins.has(order.source_segment_id)) throw new ReducerValidationError("Rank override source is not in the origin catalog");
    const segment = matchingSegment(root, order.original_date);
    if (!segment || segment.segment_id !== order.source_segment_id) throw new ReducerValidationError("Rank override must target a currently generated slot");
  }
  const detachedIds = new Set<string>();
  for (const child of root.family.detached) {
    exactKeys(child as unknown as Record<string, unknown>, ["task_id", "source_occurrence_id", "original_date", "data", "deleted"], "detached_task");
    assertUuid(child.task_id, "detached.task_id");
    assertUuid(child.source_occurrence_id, "detached.source_occurrence_id");
    assertLocalDate(child.original_date, "detached.original_date");
    assertTaskData(child.data, "detached.data");
    if (child.task_id !== await detachedId(rootId, child.original_date) || child.source_occurrence_id !== await occurrenceId(rootId, child.original_date)) {
      throw new ReducerValidationError("Detached task ids are not canonical");
    }
    if (detachedIds.has(child.task_id)) throw new ReducerValidationError("Detached task ids must be unique");
    detachedIds.add(child.task_id);
  }
  for (const override of root.family.overrides) {
    if (override.kind === "detached") {
      const child = root.family.detached.find((entry) => entry.task_id === override.detached_task_id);
      if (!child || child.original_date !== override.original_date ||
          child.source_occurrence_id !== await occurrenceId(rootId, override.original_date)) {
        throw new ReducerValidationError("Detached override must reference its canonical retained child");
      }
    }
  }
}

async function applyOccurrenceEdit(input: {
  state: ProjectionState;
  rootRef: RootRef;
  root: FamilyWorkRoot;
  operation: Operation;
  action: "occurrence.replace" | "occurrence.delete";
  sourceSegmentId: UUID;
  originalDate: string;
  data?: TaskData;
}): Promise<void> {
  if (input.root.deleted) throw new ReducerNoOp("target_retired");
  const existingOverride = findOverride(input.root, input.originalDate);
  if (existingOverride?.kind === "detached") {
    const child = input.root.family.detached.find((entry) => entry.task_id === existingOverride.detached_task_id);
    if (!child) throw new ReducerValidationError("Detached mapping refers to a missing child");
    if (input.action === "occurrence.delete") child.deleted = true;
    else {
      assertTaskData(input.data, "occurrence.replace.data");
      assertPlanExists(input.state, input.data.plan_id, "occurrence.replace.data.plan_id");
      child.data = clone(input.data);
      child.deleted = false;
    }
    return;
  }
  const segment = matchingSegment(input.root, input.originalDate);
  if (!segment || segment.segment_id !== input.sourceSegmentId) throw new ReducerNoOp("target_retired");
  const override: OccurrenceOverride = {
    override_id: await overrideId(input.rootRef.id, input.originalDate),
    original_date: input.originalDate,
    source_segment_id: input.sourceSegmentId,
    kind: input.action === "occurrence.delete" ? "deleted" : "replacement",
    replacement: input.action === "occurrence.delete" ? null : clone(input.data!),
    detached_task_id: null,
  };
  putOverride(input.root, override);
  removeOrderOverride(input.root, input.originalDate);
}

async function applySeriesEdit(input: {
  rootId: UUID;
  root: FamilyWorkRoot;
  operation: Operation;
  commandIndex: number;
  cutoff: string;
  sourceSegmentId: UUID;
  rule?: RecurrenceRule;
  template?: TaskTemplate;
  editFuture: boolean;
}): Promise<void> {
  if (input.root.deleted) throw new ReducerNoOp("target_retired");
  sourceOrigin(input.root, input.sourceSegmentId, input.cutoff);
  const priorRoot = clone(input.root);
  const cutoff = input.cutoff;
  const keptSegments: RuleSegment[] = [];
  for (const segment of input.root.family.segments) {
    if (segment.until_date !== null && dateBeforeOrEqual(segment.until_date, cutoff)) {
      keptSegments.push(segment);
    } else if (dateBefore(segment.from_date, cutoff)) {
      keptSegments.push({ ...segment, until_date: cutoff });
    }
  }

  const nextOverrides: OccurrenceOverride[] = [];
  const nextChildren = input.root.family.detached.map((child) => clone(child));
  for (const override of input.root.family.overrides) {
    if (dateBefore(override.original_date, cutoff)) {
      nextOverrides.push(clone(override));
      continue;
    }
    if (!input.editFuture) {
      if (override.kind === "replacement") {
        nextOverrides.push({ ...override, kind: "deleted", replacement: null, detached_task_id: null });
      } else {
        nextOverrides.push(clone(override));
      }
      continue;
    }
    if (override.kind === "replacement") {
      const childId = await detachedId(input.rootId, override.original_date);
      const child: DetachedTask = {
        task_id: childId,
        source_occurrence_id: await occurrenceId(input.rootId, override.original_date),
        original_date: override.original_date,
        data: clone(override.replacement!),
        deleted: false,
      };
      const childIndex = nextChildren.findIndex((entry) => entry.task_id === childId);
      if (childIndex < 0) nextChildren.push(child);
      else nextChildren[childIndex] = child;
      nextOverrides.push({
        ...override,
        kind: "detached",
        replacement: null,
        detached_task_id: childId,
      });
    } else {
      nextOverrides.push(clone(override));
    }
  }

  const rankOverrides: OccurrenceOrderOverride[] = [];
  for (const override of input.root.family.order_overrides) {
    if (dateBefore(override.original_date, cutoff)) {
      rankOverrides.push(clone(override));
      continue;
    }
    if (!input.editFuture || !input.rule || !input.template) continue;
    const priorSegment = matchingSegment(priorRoot, override.original_date);
    if (!priorSegment || !input.rule.weekdays.includes(isoWeekday(override.original_date))) continue;
    if (priorSegment.template.period !== input.template.period || priorSegment.template.order_key !== input.template.order_key) continue;
    const successor = await makeSegment(input.rootId, input.operation, input.commandIndex, cutoff, input.rule, input.template);
    rankOverrides.push({ ...override, source_segment_id: successor.segment_id });
  }

  input.root.family.segments = keptSegments;
  input.root.family.overrides = nextOverrides;
  input.root.family.order_overrides = rankOverrides;
  input.root.family.detached = nextChildren;
  if (input.editFuture) {
    const segment = await makeSegment(input.rootId, input.operation, input.commandIndex, cutoff, input.rule!, input.template!);
    input.root.family.segments.push(segment);
    input.root.segment_origins.push({
      segment_id: segment.segment_id,
      born_from_date: cutoff,
      created_by_operation_id: input.operation.operation_id,
      command_index: input.commandIndex,
    });
    for (const override of input.root.family.order_overrides) {
      if (!dateBefore(override.original_date, cutoff) && override.source_segment_id !== segment.segment_id &&
          input.rule!.weekdays.includes(isoWeekday(override.original_date))) {
        override.source_segment_id = segment.segment_id;
      }
    }
  }
}

async function applyCommand(state: ProjectionState, operation: Operation, command: SyncCommand, index: number): Promise<void> {
  const root = command.root as RootRef;
  const current = rootValue(state, root);
  switch (command.action) {
    case "plan.create": {
      rootKindMatches(root, "plan");
      const payload = payloadRecord(command, ["data"]);
      assertPlanData(payload.data, "plan.create.data");
      if (current) throw new ReducerNoOp("duplicate_target");
      putRoot(state, root, { owner_id: operation.owner_id, deleted: false, data: clone(payload.data) });
      return;
    }
    case "plan.replace": {
      rootKindMatches(root, "plan");
      const payload = payloadRecord(command, ["data"]);
      assertPlanData(payload.data, "plan.replace.data");
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if ("kind" in current) throw new ReducerValidationError("Plan id conflicts with a work-item root");
      putRoot(state, root, { owner_id: operation.owner_id, deleted: false, data: clone(payload.data) });
      return;
    }
    case "milestone.create": {
      rootKindMatches(root, "milestone");
      const payload = payloadRecord(command, ["data"]);
      assertMilestoneData(payload.data, "milestone.create.data");
      if (current) throw new ReducerNoOp("duplicate_target");
      assertPlanExists(state, payload.data.plan_id, "milestone.create.data.plan_id");
      putRoot(state, root, { owner_id: operation.owner_id, deleted: false, data: clone(payload.data) });
      return;
    }
    case "milestone.replace": {
      rootKindMatches(root, "milestone");
      const payload = payloadRecord(command, ["data"]);
      assertMilestoneData(payload.data, "milestone.replace.data");
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if ("kind" in current) throw new ReducerValidationError("Milestone id conflicts with a work-item root");
      assertPlanExists(state, payload.data.plan_id, "milestone.replace.data.plan_id");
      putRoot(state, root, { owner_id: operation.owner_id, deleted: false, data: clone(payload.data) });
      return;
    }
    case "milestone.delete": {
      rootKindMatches(root, "milestone");
      payloadRecord(command, []);
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if ("kind" in current) throw new ReducerValidationError("Milestone id conflicts with a work-item root");
      if (current.deleted) throw new ReducerNoOp("target_retired");
      putRoot(state, root, { ...current, deleted: true });
      return;
    }
    case "work_item.create_single": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, ["data"]);
      assertTaskData(payload.data, "work_item.create_single.data");
      if (current) throw new ReducerNoOp("duplicate_target");
      assertPlanExists(state, payload.data.plan_id, "work_item.create_single.data.plan_id");
      putRoot(state, root, { owner_id: operation.owner_id, deleted: false, kind: "single", single: clone(payload.data), segment_origins: [], family: null });
      return;
    }
    case "work_item.create_recurrence": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, ["start_date", "rule", "template"]);
      assertLocalDate(payload.start_date, "work_item.create_recurrence.start_date");
      assertRule(payload.rule, "work_item.create_recurrence.rule");
      assertTaskTemplate(payload.template, "work_item.create_recurrence.template");
      if (current) throw new ReducerNoOp("duplicate_target");
      assertPlanExists(state, payload.template.plan_id, "work_item.create_recurrence.template.plan_id");
      const segment = await makeSegment(root.id, operation, index, payload.start_date, payload.rule, payload.template);
      putRoot(state, root, makeFamilyRoot(operation.owner_id, segment, operation.operation_id, index));
      return;
    }
    case "work_item.enable_recurrence": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, ["data", "rule"]);
      assertTaskData(payload.data, "work_item.enable_recurrence.data");
      assertRule(payload.rule, "work_item.enable_recurrence.rule");
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if (!("kind" in current) || current.kind !== "single" || current.deleted) throw new ReducerNoOp("target_retired");
      if (!payload.rule.weekdays.includes(isoWeekday(payload.data.date))) throw new ReducerValidationError("Enable recurrence date must match a selected weekday");
      assertPlanExists(state, payload.data.plan_id, "work_item.enable_recurrence.data.plan_id");
      const segment = await makeSegment(root.id, operation, index, payload.data.date, payload.rule, taskTemplate(payload.data));
      const family = makeFamilyRoot(operation.owner_id, segment, operation.operation_id, index);
      family.family.overrides.push({
        override_id: await overrideId(root.id, payload.data.date),
        original_date: payload.data.date,
        source_segment_id: segment.segment_id,
        kind: "replacement",
        replacement: clone(payload.data),
        detached_task_id: null,
      });
      family.segment_origins = [...current.segment_origins, ...family.segment_origins];
      putRoot(state, root, family);
      return;
    }
    case "single.replace": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, ["data"]);
      assertTaskData(payload.data, "single.replace.data");
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if (!("kind" in current) || current.kind !== "single") throw new ReducerNoOp("target_retired");
      assertPlanExists(state, payload.data.plan_id, "single.replace.data.plan_id");
      putRoot(state, root, { ...current, deleted: false, single: clone(payload.data) });
      return;
    }
    case "single.delete": {
      rootKindMatches(root, "work_item");
      payloadRecord(command, []);
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if (!("kind" in current) || current.kind !== "single" || current.deleted) throw new ReducerNoOp("target_retired");
      putRoot(state, root, { ...current, deleted: true });
      return;
    }
    case "occurrence.replace":
    case "occurrence.delete": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, command.action === "occurrence.replace"
        ? ["source_segment_id", "original_date", "data"] : ["source_segment_id", "original_date"]);
      assertUuid(payload.source_segment_id, `${command.action}.source_segment_id`);
      assertLocalDate(payload.original_date, `${command.action}.original_date`);
      if (command.action === "occurrence.replace") {
        assertTaskData(payload.data, "occurrence.replace.data");
        assertPlanExists(state, payload.data.plan_id, "occurrence.replace.data.plan_id");
      }
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if (!("kind" in current) || current.kind !== "recurrence_family") throw new ReducerNoOp("target_retired");
      await applyOccurrenceEdit({
        state, rootRef: root, root: current, operation,
        action: command.action,
        sourceSegmentId: payload.source_segment_id,
        originalDate: payload.original_date,
        data: command.action === "occurrence.replace" ? payload.data as TaskData : undefined,
      });
      return;
    }
    case "detached.replace":
    case "detached.delete": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, command.action === "detached.replace" ? ["task_id", "data"] : ["task_id"]);
      assertUuid(payload.task_id, `${command.action}.task_id`);
      if (command.action === "detached.replace") {
        assertTaskData(payload.data, "detached.replace.data");
        assertPlanExists(state, payload.data.plan_id, "detached.replace.data.plan_id");
      }
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if (!("kind" in current) || current.kind !== "recurrence_family" || current.deleted) throw new ReducerNoOp("target_retired");
      const child = current.family.detached.find((entry) => entry.task_id === payload.task_id);
      if (!child) throw new ReducerNoOp("target_retired");
      if (command.action === "detached.delete") child.deleted = true;
      else { child.data = clone(payload.data as TaskData); child.deleted = false; }
      return;
    }
    case "series.edit_future":
    case "series.stop_future": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, command.action === "series.edit_future"
        ? ["source_segment_id", "cutoff_original_date", "rule", "template"] : ["source_segment_id", "cutoff_original_date"]);
      assertUuid(payload.source_segment_id, `${command.action}.source_segment_id`);
      assertLocalDate(payload.cutoff_original_date, `${command.action}.cutoff_original_date`);
      if (command.action === "series.edit_future") {
        assertRule(payload.rule, "series.edit_future.rule");
        assertTaskTemplate(payload.template, "series.edit_future.template");
        assertPlanExists(state, payload.template.plan_id, "series.edit_future.template.plan_id");
      }
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if (!("kind" in current) || current.kind !== "recurrence_family" || current.deleted) throw new ReducerNoOp("target_retired");
      await applySeriesEdit({
        rootId: root.id,
        root: current,
        operation,
        commandIndex: index,
        cutoff: payload.cutoff_original_date,
        sourceSegmentId: payload.source_segment_id,
        rule: command.action === "series.edit_future" ? payload.rule as RecurrenceRule : undefined,
        template: command.action === "series.edit_future" ? payload.template as TaskTemplate : undefined,
        editFuture: command.action === "series.edit_future",
      });
      return;
    }
    case "set_order": {
      rootKindMatches(root, "work_item");
      const payload = payloadRecord(command, ["target", "order_key", "intent"]);
      assertOrderKey(payload.order_key, "set_order.order_key");
      if (payload.intent !== "user_reorder" && payload.intent !== "rank_maintenance") throw new ReducerValidationError("set_order.intent is invalid");
      if (!isRecord(payload.target)) throw new ReducerValidationError("set_order.target must be an object");
      if (!current) throw new ReducerNoOp("reference_unavailable");
      if (!("kind" in current) || current.deleted) throw new ReducerNoOp("target_retired");
      const item = current as WorkRoot;
      const target = payload.target as Record<string, unknown>;
      if (item.kind === "single") {
        exactKeys(target, ["kind"], "set_order.target");
        if (target.kind !== "single") throw new ReducerValidationError("set_order target kind does not match root");
        item.single.order_key = payload.order_key;
        return;
      }
      if (target.kind === "detached") {
        exactKeys(target, ["kind", "task_id"], "set_order.target");
        assertUuid(target.task_id, "set_order.target.task_id");
        const taskId = target.task_id;
        const child = item.family.detached.find((entry) => entry.task_id === taskId);
        if (!child || child.deleted) throw new ReducerNoOp("target_retired");
        child.data.order_key = payload.order_key;
        return;
      }
      if (target.kind !== "occurrence") throw new ReducerValidationError("set_order target kind does not match root");
      exactKeys(target, ["kind", "source_segment_id", "original_date"], "set_order.target");
      assertUuid(target.source_segment_id, "set_order.target.source_segment_id");
      assertLocalDate(target.original_date, "set_order.target.original_date");
      const date = target.original_date;
      const override = findOverride(item, date);
      if (override?.kind === "detached") {
        const child = item.family.detached.find((entry) => entry.task_id === override.detached_task_id);
        if (!child || child.deleted) throw new ReducerNoOp("target_retired");
        child.data.order_key = payload.order_key;
        return;
      }
      const segment = matchingSegment(item, date);
      if (!segment || segment.segment_id !== payload.target.source_segment_id || override?.kind === "deleted") {
        throw new ReducerNoOp("target_retired");
      }
      if (override?.kind === "replacement") {
        override.replacement!.order_key = payload.order_key;
        return;
      }
      if (payload.intent === "rank_maintenance") {
        const rank = activeOrderOverride(item, date, segment.segment_id);
        if (rank) rank.order_key = payload.order_key;
        else item.family.order_overrides.push({ original_date: date, source_segment_id: segment.segment_id, order_key: payload.order_key });
      } else {
        const data = taskFromTemplate(segment.template, date);
        const rank = activeOrderOverride(item, date, segment.segment_id);
        if (rank) data.order_key = rank.order_key;
        data.order_key = payload.order_key;
        putOverride(item, {
          override_id: await overrideId(root.id, date),
          original_date: date,
          source_segment_id: segment.segment_id,
          kind: "replacement",
          replacement: data,
          detached_task_id: null,
        });
        removeOrderOverride(item, date);
      }
      return;
    }
    case "undo":
      throw new ReducerValidationError("Undo commands must be reduced with canonical operation history");
    default:
      throw new ReducerValidationError(`Unsupported reducer action: ${command.action}`);
  }
}

function parseRootKey(key: string): RootRef {
  const separator = key.indexOf(":");
  if (separator < 1) throw new ReducerValidationError("Projection root key is invalid");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (kind !== "plan" && kind !== "milestone" && kind !== "work_item") throw new ReducerValidationError("Projection root kind is invalid");
  assertUuid(id, "projection.root.id");
  return { kind, id };
}

function changedRootRefs(before: ProjectionState, after: ProjectionState): RootRef[] {
  const keys = new Set([...Object.keys(before.roots), ...Object.keys(after.roots)]);
  return [...keys].filter((key) => canonicalizeJson(before.roots[key] ?? null) !== canonicalizeJson(after.roots[key] ?? null))
    .map(parseRootKey)
    .sort((a, b) => compareText(a.kind, b.kind) || compareText(uuidOrder(a.id), uuidOrder(b.id)));
}

async function getSetOrderBucket(state: ProjectionState, command: SyncCommand): Promise<{ date: string; period: Period } | null> {
  const root = command.root as RootRef;
  const value = rootValue(state, root);
  if (!value || !("kind" in value) || value.deleted) return null;
  const target = command.payload.target;
  if (!isRecord(target)) return null;
  const item = value as WorkRoot;
  if (item.kind === "single") {
    if (target.kind !== "single") return null;
    return { date: item.single.date, period: item.single.period };
  }
  if (target.kind === "detached" && typeof target.task_id === "string") {
    const child = item.family.detached.find((entry) => entry.task_id === target.task_id && !entry.deleted);
    return child ? { date: child.data.date, period: child.data.period } : null;
  }
  if (target.kind === "occurrence" && typeof target.original_date === "string") {
    const override = findOverride(item, target.original_date);
    if (override?.kind === "detached") {
      const child = item.family.detached.find((entry) => entry.task_id === override.detached_task_id && !entry.deleted);
      return child ? { date: child.data.date, period: child.data.period } : null;
    }
    if (override?.kind === "deleted") return null;
    const segment = matchingSegment(item, target.original_date);
    if (!segment || (typeof target.source_segment_id === "string" && segment.segment_id !== target.source_segment_id)) return null;
    const data = override?.kind === "replacement" ? override.replacement : taskFromTemplate(segment.template, target.original_date);
    return data ? { date: data.date, period: data.period } : null;
  }
  return null;
}

interface BucketPrecondition { date: string; period: Period; order_hash: string }
function parsePreconditions(operation: Operation): {
  roots: Array<{ root: RootRef; hash: string }>;
  buckets: BucketPrecondition[];
} {
  const roots: Array<{ root: RootRef; hash: string }> = [];
  const buckets: BucketPrecondition[] = [];
  for (const command of operation.commands) {
    const value = command.precondition;
    if (value === null) continue;
    if (!isRecord(value)) throw new ReducerValidationError("Command precondition must be an object or null");
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "expected_root_hash" && key !== "expected_bucket") || keys.length === 0) {
      throw new ReducerValidationError("Command precondition has an invalid shape");
    }
    if (Object.hasOwn(value, "expected_root_hash")) {
      if (typeof value.expected_root_hash !== "string" || !HASH_RE.test(value.expected_root_hash)) throw new ReducerValidationError("expected_root_hash is invalid");
      roots.push({ root: command.root as RootRef, hash: value.expected_root_hash });
    }
    if (Object.hasOwn(value, "expected_bucket")) {
      const bucket = value.expected_bucket;
      if (!isRecord(bucket)) throw new ReducerValidationError("expected_bucket must be an object");
      exactKeys(bucket, ["date", "period", "order_hash"], "expected_bucket");
      assertLocalDate(bucket.date, "expected_bucket.date");
      assertPeriod(bucket.period, "expected_bucket.period");
      if (typeof bucket.order_hash !== "string" || !HASH_RE.test(bucket.order_hash)) throw new ReducerValidationError("expected_bucket.order_hash is invalid");
      buckets.push({ date: bucket.date, period: bucket.period as Period, order_hash: bucket.order_hash });
    }
  }
  return { roots, buckets };
}

async function checkOperationPreconditions(state: ProjectionState, operation: Operation): Promise<BucketPrecondition[]> {
  const preconditions = parsePreconditions(operation);
  for (const command of operation.commands) {
    if (command.action === "set_order") {
      const condition = command.precondition;
      if (!isRecord(condition) || typeof condition.expected_root_hash !== "string") {
        throw new ReducerValidationError("Each set_order command requires an expected_root_hash");
      }
    }
  }
  for (const precondition of preconditions.roots) {
    if (await semanticRootHash(precondition.root, rootValue(state, precondition.root)) !== precondition.hash) {
      throw new ReducerNoOp("precondition_failed");
    }
  }
  const seenBuckets = new Set<string>();
  for (const bucket of preconditions.buckets) {
    const key = `${bucket.date}:${bucket.period}`;
    if (seenBuckets.has(key)) continue;
    seenBuckets.add(key);
    if (await bucketOrderHash(state, bucket.date, bucket.period) !== bucket.order_hash) {
      throw new ReducerNoOp("precondition_failed");
    }
  }
  const bucketKeys = new Set(preconditions.buckets.map((bucket) => `${bucket.date}:${bucket.period}`));
  for (const command of operation.commands.filter((entry) => entry.action === "set_order")) {
    const bucket = await getSetOrderBucket(state, command);
    if (bucket && !bucketKeys.has(`${bucket.date}:${bucket.period}`)) {
      throw new ReducerValidationError("Operation is missing the expected bucket hash for a set_order target");
    }
    if (!bucket && preconditions.buckets.length === 0) {
      throw new ReducerValidationError("Operation is missing an expected bucket hash for set_order");
    }
  }
  return preconditions.buckets;
}

/** Validate that root/bucket guards on a candidate match the supplied canonical pre-state. */
export async function operationPreconditionsMatch(state: ProjectionState, operation: Operation): Promise<boolean> {
  try {
    await checkOperationPreconditions(state, operation);
    return true;
  } catch (error) {
    if (error instanceof ReducerNoOp && error.reason === "precondition_failed") return false;
    throw error;
  }
}

async function verifyRankMaintenance(before: ProjectionState, after: ProjectionState, operation: Operation, buckets: readonly BucketPrecondition[]): Promise<void> {
  const orderCommands = operation.commands.filter((command) => command.action === "set_order");
  if (orderCommands.length === 0) return;
  const hasUserReorder = orderCommands.some((command) => command.payload.intent === "user_reorder");
  const userTargets = new Set<UUID>();
  for (const command of orderCommands) {
    if (command.payload.intent !== "user_reorder") continue;
    const target = command.payload.target;
    if (!isRecord(target)) continue;
    if (target.kind === "single") userTargets.add(command.root.id);
    else if (target.kind === "detached" && typeof target.task_id === "string") userTargets.add(target.task_id as UUID);
    else if (target.kind === "occurrence" && typeof target.original_date === "string") {
      const value = rootValue(before, command.root as RootRef);
      const override = value && "kind" in value && value.kind === "recurrence_family"
        ? findOverride(value, target.original_date)
        : null;
      userTargets.add(override?.kind === "detached" && override.detached_task_id
        ? override.detached_task_id
        : await occurrenceId(command.root.id, target.original_date));
    }
  }
  for (const bucket of buckets) {
    const previous = (await bucketCards(before, bucket.date, bucket.period)).map((card) => card.card_id);
    const next = (await bucketCards(after, bucket.date, bucket.period)).map((card) => card.card_id);
    if (!hasUserReorder) {
      if (previous.length !== next.length || previous.some((id, index) => id !== next[index])) {
        throw new ReducerNoOp("precondition_failed");
      }
      continue;
    }
    const priorUntouched = previous.filter((id) => !userTargets.has(id));
    const nextUntouched = next.filter((id) => !userTargets.has(id));
    if (priorUntouched.length !== nextUntouched.length || priorUntouched.some((id, index) => id !== nextUntouched[index])) {
      throw new ReducerNoOp("precondition_failed");
    }
  }
}

async function validateProjection(state: ProjectionState): Promise<void> {
  assertUuid(state.owner_id, "projection.owner_id");
  if (!isRecord(state.roots)) throw new ReducerValidationError("Projection roots must be an object");
  for (const [key, value] of Object.entries(state.roots)) {
    const root = parseRootKey(key);
    if (!isRecord(value) || value.owner_id !== state.owner_id || typeof value.deleted !== "boolean") {
      throw new ReducerValidationError("Projection root metadata is invalid");
    }
    if (root.kind === "plan") {
      if ("kind" in value) throw new ReducerValidationError("Plan root fields are invalid");
      exactKeys(value, ["owner_id", "deleted", "data"], "plan_root");
      assertPlanData(value.data, "plan.data");
      continue;
    }
    if (root.kind === "milestone") {
      if ("kind" in value) throw new ReducerValidationError("Milestone root fields are invalid");
      exactKeys(value, ["owner_id", "deleted", "data"], "milestone_root");
      assertMilestoneData(value.data, "milestone.data");
      if (!value.deleted) assertPlanExists(state, value.data.plan_id, "milestone.data.plan_id");
      continue;
    }
    if (value.kind === "single") {
      exactKeys(value, ["owner_id", "deleted", "kind", "single", "segment_origins", "family"], "work_item.single");
      if (value.family !== null || !Array.isArray(value.segment_origins)) throw new ReducerValidationError("Single work-item branch is invalid");
      assertTaskData(value.single, "work_item.single.data");
      if (!value.deleted) assertPlanExists(state, value.single.plan_id, "work_item.single.plan_id");
      if (value.segment_origins.length > 0) {
        for (const origin of value.segment_origins) {
          if (!isRecord(origin)) throw new ReducerValidationError("Segment origin is invalid");
          assertUuid(origin.segment_id, "segment_origin.segment_id");
          assertLocalDate(origin.born_from_date, "segment_origin.born_from_date");
          assertUuid(origin.created_by_operation_id, "segment_origin.created_by_operation_id");
          const originValue = origin as unknown as Record<string, unknown>;
          if (typeof originValue.command_index !== "number" || !Number.isInteger(originValue.command_index) || originValue.command_index < 0 ||
              originValue.segment_id !== await uuidV5(root.id, `segment:${originValue.created_by_operation_id}:${originValue.command_index}`)) {
            throw new ReducerValidationError("Single work-item segment catalog is invalid");
          }
        }
      }
      continue;
    }
    if (value.kind !== "recurrence_family") throw new ReducerValidationError("Work-item kind is invalid");
    exactKeys(value, ["owner_id", "deleted", "kind", "single", "segment_origins", "family"], "work_item.family");
    if (value.single !== null || !Array.isArray(value.segment_origins) || !isRecord(value.family)) throw new ReducerValidationError("Family work-item branch is invalid");
    exactKeys(value.family, ["segments", "overrides", "order_overrides", "detached"], "work_item.family");
    if (!Array.isArray(value.family.segments) || !Array.isArray(value.family.overrides) ||
        !Array.isArray(value.family.order_overrides) || !Array.isArray(value.family.detached)) {
      throw new ReducerValidationError("Family collections are invalid");
    }
    const family = value as unknown as FamilyWorkRoot;
    await assertFamilyIntegrity(root.id, family);
    if (!family.deleted) {
      for (const segment of family.family.segments) assertPlanExists(state, segment.template.plan_id, "segment.template.plan_id");
      for (const override of family.family.overrides) if (override.kind === "replacement") assertPlanExists(state, override.replacement!.plan_id, "override.replacement.plan_id");
      for (const child of family.family.detached) if (!child.deleted) assertPlanExists(state, child.data.plan_id, "detached.data.plan_id");
    }
  }
}

interface OperationHistory {
  operation: Operation;
  roots: RootRef[];
  before: Map<string, RootValue | null>;
  effect: OperationEffect;
}

function tombstone(value: RootValue): RootValue {
  return { ...value, deleted: true } as RootValue;
}
function mergeOrigins(current: WorkRoot, restored: WorkRoot): WorkRoot {
  const byId = new Map<UUID, SegmentOrigin>();
  for (const origin of [...current.segment_origins, ...restored.segment_origins]) {
    const existing = byId.get(origin.segment_id);
    if (existing && canonicalizeJson(existing) !== canonicalizeJson(origin)) throw new ReducerNoOp("undo_not_applicable");
    byId.set(origin.segment_id, clone(origin));
  }
  restored.segment_origins = [...byId.values()].sort((a, b) => compareText(uuidOrder(a.segment_id), uuidOrder(b.segment_id)));
  return restored;
}
function hasLivePlanReference(state: ProjectionState, planId: UUID): boolean {
  for (const value of Object.values(state.roots)) {
    if (!value || value.deleted) continue;
    if (!("kind" in value)) {
      if ((value as MilestoneRoot).data.plan_id === planId) return true;
      continue;
    }
    const item = value as WorkRoot;
    if (item.kind === "single") {
      if (item.single.plan_id === planId) return true;
      continue;
    }
    if (item.family.segments.some((segment) => segment.template.plan_id === planId)) return true;
    if (item.family.overrides.some((override) => override.kind === "replacement" && override.replacement?.plan_id === planId)) return true;
    if (item.family.detached.some((child) => !child.deleted && child.data.plan_id === planId)) return true;
  }
  return false;
}

async function applyUndo(input: {
  state: ProjectionState;
  operation: Operation;
  command: SyncCommand;
  history: ReadonlyMap<UUID, OperationHistory>;
  latestByRoot: ReadonlyMap<string, UUID>;
}): Promise<void> {
  const command = input.command;
  if (input.operation.commands.length !== 1 || command.action !== "undo") throw new ReducerValidationError("An undo operation must contain exactly one undo command");
  const payload = command.payload;
  exactKeys(payload, ["original_operation_id", "expected_states"], "undo.payload");
  assertUuid(payload.original_operation_id, "undo.original_operation_id");
  if (!Array.isArray(payload.expected_states)) throw new ReducerValidationError("undo.expected_states must be an array");
  if (!input.operation.dependencies.includes(payload.original_operation_id)) {
    throw new ReducerValidationError("Undo operation must depend on its original operation");
  }
  const original = input.history.get(payload.original_operation_id);
  if (!original || original.effect !== "applied" || original.roots.length === 0) throw new ReducerNoOp("undo_not_applicable");
  if (!original.roots.some((root) => root.kind === command.root.kind && root.id === command.root.id)) throw new ReducerNoOp("undo_not_applicable");
  const expected = new Map<string, string>();
  for (const entry of payload.expected_states) {
    if (!isRecord(entry) || !isRecord(entry.root) || typeof entry.hash !== "string" || !HASH_RE.test(entry.hash)) {
      throw new ReducerValidationError("undo.expected_states contains an invalid entry");
    }
    exactKeys(entry, ["root", "hash"], "undo.expected_state");
    exactKeys(entry.root, ["kind", "id"], "undo.expected_state.root");
    assertUuid(entry.root.id, "undo.expected_state.root.id");
    if (entry.root.kind !== "plan" && entry.root.kind !== "milestone" && entry.root.kind !== "work_item") {
      throw new ReducerValidationError("undo.expected_state.root.kind is invalid");
    }
    const root = entry.root as unknown as RootRef;
    const key = rootKey(root);
    if (expected.has(key)) throw new ReducerValidationError("undo.expected_states contains a duplicate root");
    expected.set(key, entry.hash);
  }
  if (expected.size !== original.roots.length || original.roots.some((root) => !expected.has(rootKey(root)))) throw new ReducerNoOp("undo_not_applicable");

  for (const root of original.roots) {
    const key = rootKey(root);
    if (input.latestByRoot.get(key) !== payload.original_operation_id) throw new ReducerNoOp("undo_not_applicable");
    if (await semanticRootHash(root, rootValue(input.state, root)) !== expected.get(key)) throw new ReducerNoOp("undo_not_applicable");
  }

  const inverseState = clone(input.state);
  for (const root of original.roots) {
    const key = rootKey(root);
    const previous = original.before.get(key) ?? null;
    const current = rootValue(input.state, root);
    if (previous === null) {
      if (!current) throw new ReducerNoOp("undo_not_applicable");
      putRoot(inverseState, root, tombstone(clone(current)));
    } else {
      if ("kind" in previous && current && "kind" in current) {
        putRoot(inverseState, root, mergeOrigins(clone(current as WorkRoot), clone(previous as WorkRoot)));
      } else {
        putRoot(inverseState, root, clone(previous));
      }
    }
  }
  for (const root of original.roots.filter((candidate) => candidate.kind === "plan")) {
    if (hasLivePlanReference(inverseState, root.id)) throw new ReducerNoOp("undo_not_applicable");
  }
  try { await validateProjection(inverseState); } catch { throw new ReducerNoOp("undo_not_applicable"); }
  input.state.roots = inverseState.roots;
}

export function emptyProjection(ownerId: UUID): ProjectionState {
  assertUuid(ownerId, "owner_id");
  return { owner_id: ownerId, roots: {} };
}

/** Canonical owner-wide replay. Operations are applied in edit order K, atomically per operation. */
export async function replayOperations(operations: readonly Operation[], ownerId: UUID): Promise<ReplayResult> {
  assertUuid(ownerId, "owner_id");
  const uniqueIds = new Set<UUID>();
  for (const operation of operations) {
    assertOperationEnvelope(operation);
    if (operation.owner_id !== ownerId) throw new ReducerValidationError("Replay input contains another owner's operation");
    if (uniqueIds.has(operation.operation_id)) throw new ReducerValidationError("Replay input contains a duplicate operation id");
    uniqueIds.add(operation.operation_id);
  }
  const ordered = orderOperationsByDependencies(operations);
  if (ordered.blocked.length > 0) throw new ReducerValidationError("Canonical replay is missing one or more operation dependencies");
  const state = emptyProjection(ownerId);
  const history = new Map<UUID, OperationHistory>();
  const latestByRoot = new Map<string, UUID>();
  const outcomes: OperationOutcome[] = [];

  for (const operation of ordered.ready.sort(compareOperations)) {
    const beforeState = clone(state);
    let effect: OperationEffect = "applied";
    let reason: NoOpReason | null = null;
    let nextState = clone(state);
    try {
      const buckets = await checkOperationPreconditions(state, operation);
      if (operation.commands.some((command) => command.action === "undo")) {
        await applyUndo({ state: nextState, operation, command: operation.commands[0], history, latestByRoot });
      } else {
        for (const [index, command] of operation.commands.entries()) await applyCommand(nextState, operation, command, index);
        await validateProjection(nextState);
        await verifyRankMaintenance(state, nextState, operation, buckets);
      }
    } catch (error) {
      if (error instanceof ReducerNoOp) {
        effect = "no_op";
        reason = error.reason;
        nextState = beforeState;
      } else {
        throw error;
      }
    }

    const changed = effect === "applied" ? changedRootRefs(beforeState, nextState) : [];
    state.roots = nextState.roots;
    const beforeRoots = new Map<string, RootValue | null>();
    for (const root of changed) beforeRoots.set(rootKey(root), rootValue(beforeState, root) ? clone(rootValue(beforeState, root)!) : null);
    const historyEntry: OperationHistory = { operation, roots: changed, before: beforeRoots, effect };
    history.set(operation.operation_id, historyEntry);
    for (const root of changed) latestByRoot.set(rootKey(root), operation.operation_id);
    outcomes.push({ operation_id: operation.operation_id, effect, reason, changed_roots: changed });
  }
  return { state, outcomes };
}
