import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { replayOperations } from "../lib/sync/reducer";
import { assertSyncPage, compareDecimal, type Operation, type UUID } from "../lib/sync/protocol";

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}

test("TypeScript reducer matches the shared basic fixture for every arrival permutation", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-basic.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    operations: Operation[];
    expected_projection: unknown;
  };
  for (const operations of permutations(fixture.operations)) {
    const result = await replayOperations(operations, fixture.owner_id);
    expect(result.state).toEqual(fixture.expected_projection);
  }
});

test("TypeScript reducer matches the shared recurrence and detached-task fixture", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-recurrence.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    operations: Operation[];
    expected_projection: unknown;
    expected_effects: string[];
  };
  for (const operations of permutations(fixture.operations)) {
    const result = await replayOperations(operations, fixture.owner_id);
    expect(result.state).toEqual(fixture.expected_projection);
    expect(result.outcomes.every((outcome) => outcome.reason === null)).toBe(true);
  }
  const fixtureOrder = await replayOperations(fixture.operations, fixture.owner_id);
  expect(fixtureOrder.outcomes.map((outcome) => outcome.effect)).toEqual(fixture.expected_effects);
});

test("TypeScript reducer matches the shared undo fixture", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-undo.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    operations: Operation[];
    expected_projection: unknown;
    expected_effects: string[];
  };
  for (const operations of permutations(fixture.operations)) {
    const result = await replayOperations(operations, fixture.owner_id);
    expect(result.state).toEqual(fixture.expected_projection);
    expect(result.outcomes.every((outcome) => outcome.reason === null)).toBe(true);
  }
  const fixtureOrder = await replayOperations(fixture.operations, fixture.owner_id);
  expect(fixtureOrder.outcomes.map((outcome) => outcome.effect)).toEqual(fixture.expected_effects);
});

test("TypeScript reducer matches the guarded set_order fixture", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-set-order.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    operations: Operation[];
    expected_projection: unknown;
    expected_effects: string[];
  };
  for (const operations of permutations(fixture.operations)) {
    const result = await replayOperations(operations, fixture.owner_id);
    expect(result.state).toEqual(fixture.expected_projection);
  }
  const fixtureOrder = await replayOperations(fixture.operations, fixture.owner_id);
  expect(fixtureOrder.outcomes.map((outcome) => outcome.effect)).toEqual(fixture.expected_effects);

  const phantom = structuredClone(fixture.operations[1]);
  phantom.operation_id = "88888888-8888-4888-8888-888888888888";
  phantom.device_sequence = "4";
  phantom.edit_time = { ...phantom.edit_time, physical_ms: 3000, raw_wall_ms: 3000 };
  phantom.dependencies = [fixture.operations[2].operation_id];
  phantom.commands[0].root.id = "77777777-7777-4777-8777-777777777777";
  const phantomData = phantom.commands[0].payload.data as Record<string, unknown>;
  phantom.commands[0].payload.data = {
    ...phantomData,
    title: "Phantom insert",
    order_key: "30",
  };
  const withPhantom = await replayOperations([...fixture.operations.slice(0, -1), phantom, fixture.operations.at(-1)!], fixture.owner_id);
  const withoutRebalance = await replayOperations([...fixture.operations.slice(0, -1), phantom], fixture.owner_id);
  expect(withPhantom.outcomes.at(-1)?.effect).toBe("no_op");
  expect(withPhantom.outcomes.at(-1)?.reason).toBe("precondition_failed");
  expect(withPhantom.state).toEqual(withoutRebalance.state);
  expect((withPhantom.state.roots["work_item:aaaaaaaa-bbbb-4aaa-8bbb-cccccccccccc"] as {
    single: { order_key: string };
  }).single.order_key).toBe("20");
});

test("TypeScript reducer rejects a rank above signed int64", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-set-order.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    operations: Operation[];
  };
  const operations = structuredClone(fixture.operations);
  operations.at(-1)!.commands[0].payload.order_key = "9223372036854775808";
  await expect(replayOperations(operations, fixture.owner_id)).rejects.toThrow("set_order.order_key is outside signed int64");
});

test("TypeScript reducer matches UUID byte tie-break fixtures for every arrival order", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-k-tiebreak.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    scenarios: Array<{ operations: Operation[]; expected_projection: unknown }>;
  };
  for (const scenario of fixture.scenarios) {
    for (const operations of permutations(scenario.operations)) {
      const result = await replayOperations(operations, fixture.owner_id);
      expect(result.state).toEqual(scenario.expected_projection);
      expect(result.outcomes.every((outcome) => outcome.reason === null)).toBe(true);
    }
  }
});

test("TypeScript reducer matches the remaining v1 action fixtures for every arrival order", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-actions.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    scenarios: Array<{ name: string; operations: Operation[]; expected_projection: unknown }>;
  };
  for (const scenario of fixture.scenarios) {
    for (const operations of permutations(scenario.operations)) {
      const result = await replayOperations(operations, fixture.owner_id);
      expect(result.state, scenario.name).toEqual(scenario.expected_projection);
      expect(result.outcomes.every((outcome) => outcome.reason === null), scenario.name).toBe(true);
    }
  }
});

test("TypeScript reducer makes undo a safe no-op after a later edit", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-undo-late.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    owner_id: UUID;
    operations: Operation[];
    expected_projection: unknown;
    expected_effects: string[];
    expected_reasons: (string | null)[];
  };
  for (const operations of permutations(fixture.operations)) {
    const result = await replayOperations(operations, fixture.owner_id);
    expect(result.state).toEqual(fixture.expected_projection);
    expect(result.outcomes).toHaveLength(fixture.operations.length);
  }
  const fixtureOrder = await replayOperations(fixture.operations, fixture.owner_id);
  expect(fixtureOrder.outcomes.map((outcome) => outcome.effect)).toEqual(fixture.expected_effects);
  expect(fixtureOrder.outcomes.map((outcome) => outcome.reason)).toEqual(fixture.expected_reasons);
});

test("sync protocol preserves uint64 sequence and cursor boundaries as decimal strings", async () => {
  const fixturePath = path.resolve(process.cwd(), "../docs/tasks/t12/fixtures/reducer-v1-basic.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    operations: Operation[];
  };
  const maximum = "18446744073709551615";
  const overflow = "18446744073709551616";
  const operation = structuredClone(fixture.operations[0]);
  operation.device_sequence = maximum;
  const page = {
    epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    through_cursor: maximum,
    next_cursor: maximum,
    has_more: false,
    next_page_token: null,
    groups: [{
      cursor: maximum,
      committed_at: "2026-11-02T00:00:00.000Z",
      operation,
    }],
  };

  expect(() => assertSyncPage(page)).not.toThrow();
  expect(compareDecimal(maximum, "18446744073709551614")).toBe(1);
  expect(() => assertSyncPage({ ...page, through_cursor: overflow, next_cursor: overflow,
    groups: [{ ...page.groups[0], cursor: overflow }] })).toThrow("page.through_cursor must be a canonical unsigned 64-bit decimal string");
  expect(() => assertSyncPage({ ...page, groups: [{ ...page.groups[0], operation: {
    ...operation,
    device_sequence: overflow,
  } }] })).toThrow("device_sequence must be a canonical unsigned 64-bit decimal string");
});
