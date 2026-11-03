import type { Operation, SyncCommand, UUID } from "../../lib/sync/protocol";
import { replayOperations, type MilestoneData } from "../../lib/sync/reducer";
import type { Page } from "@playwright/test";

export const DENSITY_OWNER_ID: UUID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID: UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALIBRATION_ID: UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORK_START_DATE = "2026-11-02";
const MOVED_ORIGINAL_DATE = "2026-11-03";
const MOVED_DATE = "2026-11-04";
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

function numberedUuid(prefix: string, index: number): UUID {
  return `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function buildDensityRecurrenceCommands(): SyncCommand[] {
  return Array.from({ length: 24 }, (_, index) => {
    const id = numberedUuid("20000000", index + 1);
    return {
      root: { kind: "work_item", id },
      action: "work_item.create_recurrence",
      payload: {
        start_date: WORK_START_DATE,
        rule: { weekdays: WEEKDAYS },
        template: {
          title: `Dense series ${String(index + 1).padStart(2, "0")}`,
          period: "morning",
          duration_minutes: 30,
          plan_id: null,
          standalone_color_id: "blue",
          order_key: "0",
        },
      },
      precondition: null,
    };
  });
}

export function buildMovedOccurrenceCommand(rootId: UUID, segmentId: UUID): SyncCommand {
  return {
    root: { kind: "work_item", id: rootId },
    action: "occurrence.replace",
    payload: {
      source_segment_id: segmentId,
      original_date: MOVED_ORIGINAL_DATE,
      data: {
        title: "Moved dense occurrence",
        date: MOVED_DATE,
        period: "afternoon",
        duration_minutes: 30,
        plan_id: null,
        standalone_color_id: "purple",
        status: "pending",
        order_key: "1",
      },
    },
    precondition: null,
  };
}

export function buildDenseSeriesSplitCommand(rootId: UUID, segmentId: UUID): SyncCommand {
  return {
    root: { kind: "work_item", id: rootId },
    action: "series.edit_future",
    payload: {
      source_segment_id: segmentId,
      cutoff_original_date: MOVED_ORIGINAL_DATE,
      rule: { weekdays: WEEKDAYS },
      template: {
        title: "Dense series 01",
        period: "morning",
        duration_minutes: 30,
        plan_id: null,
        standalone_color_id: "blue",
        order_key: "0",
      },
    },
    precondition: null,
  };
}

export function buildDensityMilestoneCommands(): SyncCommand[] {
  const milestoneDates: string[] = Array.from({ length: 20 }, () => MOVED_DATE);
  milestoneDates.push("2025-12-31", "2027-01-01");

  const yearStart = Date.UTC(2026, 0, 1);
  const oneDay = 24 * 60 * 60 * 1000;
  let dayOffset = 0;
  while (milestoneDates.length < 1_200) {
    const date = new Date(yearStart + (dayOffset % 365) * oneDay).toISOString().slice(0, 10);
    dayOffset += 1;
    if (date !== MOVED_DATE) milestoneDates.push(date);
  }

  return milestoneDates.map((date, index) => {
    const data: MilestoneData = {
      title: `Density marker ${String(index + 1).padStart(4, "0")}`,
      date,
      period: [null, "morning", "afternoon", "evening"][index % 4] as MilestoneData["period"],
      note: "",
      plan_id: null,
      standalone_color_id: ["neutral", "earth", "green", "teal", "blue", "purple", "pink", "coral", "sand"][index % 9] as MilestoneData["standalone_color_id"],
      show_in_work_calendar: true,
    };
    return {
      root: { kind: "milestone", id: numberedUuid("30000000", index + 1) },
      action: "milestone.create",
      payload: { data },
      precondition: null,
    };
  });
}

function makeOperation(sequence: number, commands: SyncCommand[], dependency: UUID | null): Operation {
  const operationId = numberedUuid("10000000", sequence);
  return {
    protocol_version: 1,
    reducer_version: 1,
    operation_id: operationId,
    owner_id: DENSITY_OWNER_ID,
    device_id: DEVICE_ID,
    device_sequence: String(sequence),
    edit_time: {
      physical_ms: 1_800_000_000_000 + sequence,
      logical: 0,
      calibration_id: CALIBRATION_ID,
      raw_wall_ms: 1_800_000_000_000 + sequence,
      quality: "calibrated",
    },
    dependencies: dependency ? [dependency] : [],
    commands,
  };
}

export async function buildDenseWorkWeekOperations(): Promise<Operation[]> {
  const createSeries = makeOperation(1, buildDensityRecurrenceCommands(), null);
  const rootId = numberedUuid("20000000", 1);
  const projection = (await replayOperations([createSeries], DENSITY_OWNER_ID)).state;
  const root = projection.roots[`work_item:${rootId}`];
  if (!root || !("kind" in root) || root.kind !== "recurrence_family") throw new Error("Density recurrence did not create a family root");
  const segmentId = root.family.segments[0]?.segment_id;
  if (!segmentId) throw new Error("Density recurrence did not create a rule segment");

  const move = makeOperation(2, [buildMovedOccurrenceCommand(rootId, segmentId)], createSeries.operation_id);
  const split = makeOperation(3, [buildDenseSeriesSplitCommand(rootId, segmentId)], move.operation_id);
  return [createSeries, move, split];
}

export function buildDensityMilestoneOperations(): Operation[] {
  const commands = buildDensityMilestoneCommands();
  const createFirst = makeOperation(10, commands.slice(0, 1_000), null);
  const createRemaining = makeOperation(11, commands.slice(1_000), createFirst.operation_id);
  return [createFirst, createRemaining];
}

export function expectedDensityYearCounts(commands = buildDensityMilestoneCommands()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const command of commands) {
    const data = command.payload.data as MilestoneData;
    if (!data.date.startsWith("2026-")) continue;
    const month = data.date.slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return counts;
}

export type CalendarDensityHarness = {
  inspect(): Promise<{
    recurrenceFamilies: Array<{ rootId: UUID; family: { segments: Array<{ segment_id: UUID }> } }>;
  }>;
  seedDensityCommands(commands: SyncCommand[], dependencies?: UUID[]): Promise<{ operationId: UUID; requestHash: string }>;
  refreshCalendar(): Promise<void>;
};

type FixtureWindow = Window & { __dayforgeSyncBrowserHarness?: CalendarDensityHarness };

export async function seedCalendarDensityFixture(page: Page): Promise<void> {
  const recurrenceCommands = buildDensityRecurrenceCommands();
  const first = await page.evaluate((commands) => {
    const harness = (window as FixtureWindow).__dayforgeSyncBrowserHarness;
    if (!harness) throw new Error("The sync browser harness is unavailable");
    return harness.seedDensityCommands(commands);
  }, recurrenceCommands);
  const firstRoot = recurrenceCommands[0].root.id;
  const segmentId = await page.evaluate(async (rootId) => {
    const harness = (window as FixtureWindow).__dayforgeSyncBrowserHarness;
    if (!harness) throw new Error("The sync browser harness is unavailable");
    const state = await harness.inspect();
    const family = state.recurrenceFamilies.find((entry) => entry.rootId === rootId);
    const segment = (family?.family as { segments?: Array<{ segment_id: UUID }> } | undefined)?.segments?.[0]?.segment_id;
    if (!segment) throw new Error("The dense recurrence fixture has no segment");
    return segment;
  }, firstRoot);
  const moved = await page.evaluate(({ command, dependency }) => {
    const harness = (window as FixtureWindow).__dayforgeSyncBrowserHarness;
    if (!harness) throw new Error("The sync browser harness is unavailable");
    return harness.seedDensityCommands([command], [dependency]);
  }, { command: buildMovedOccurrenceCommand(firstRoot, segmentId), dependency: first.operationId });
  const split = await page.evaluate(({ command, dependency }) => {
    const harness = (window as FixtureWindow).__dayforgeSyncBrowserHarness;
    if (!harness) throw new Error("The sync browser harness is unavailable");
    return harness.seedDensityCommands([command], [dependency]);
  }, { command: buildDenseSeriesSplitCommand(firstRoot, segmentId), dependency: moved.operationId });

  const milestoneCommands = buildDensityMilestoneCommands();
  const firstMilestones = await page.evaluate(({ commands, dependency }) => {
    const harness = (window as FixtureWindow).__dayforgeSyncBrowserHarness;
    if (!harness) throw new Error("The sync browser harness is unavailable");
    return harness.seedDensityCommands(commands, [dependency]);
  }, { commands: milestoneCommands.slice(0, 1_000), dependency: split.operationId });
  await page.evaluate(({ commands, dependency }) => {
    const harness = (window as FixtureWindow).__dayforgeSyncBrowserHarness;
    if (!harness) throw new Error("The sync browser harness is unavailable");
    return harness.seedDensityCommands(commands, [dependency]);
  }, { commands: milestoneCommands.slice(1_000), dependency: firstMilestones.operationId });
  await page.evaluate(() => {
    const value = (window as FixtureWindow).__dayforgeSyncBrowserHarness;
    if (!value) throw new Error("The sync browser harness is unavailable");
    return value.refreshCalendar();
  });
}
