import { expect, test } from "@playwright/test";
import { RecoveryIntegrityError, planEpochRecovery, type RecoveryEnvelope } from "../lib/sync/recovery";
import { hashOperation, type Operation, type UUID } from "../lib/sync/protocol";

const ownerId = "11111111-1111-4111-8111-111111111111" as UUID;
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const calibrationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const operationId = "22222222-2222-4222-8222-222222222222" as UUID;
const rootId = "33333333-3333-4333-8333-333333333333" as UUID;

function operation(name: string): Operation {
  return {
    protocol_version: 1,
    reducer_version: 1,
    operation_id: operationId,
    owner_id: ownerId,
    device_id: deviceId,
    device_sequence: "1",
    edit_time: {
      physical_ms: 1_800_000_000_000,
      logical: 0,
      calibration_id: calibrationId,
      raw_wall_ms: 1_800_000_000_000,
      quality: "calibrated",
    },
    dependencies: [],
    commands: [{
      root: { kind: "plan", id: rootId },
      action: "plan.create",
      payload: { data: { name, color_id: "neutral" } },
      precondition: null,
    }],
  };
}

async function envelope(value: Operation): Promise<RecoveryEnvelope> {
  return { operation: value, request_hash: await hashOperation(value) };
}

test("epoch recovery rejects a restored server reusing an operation id with another hash", async () => {
  const old = await envelope(operation("Original plan"));
  const restored = await envelope(operation("Conflicting plan"));

  await expect(planEpochRecovery({
    ownerId,
    oldShadow: [old],
    activeOutbox: [],
    newServerPrefix: [restored],
  })).rejects.toBeInstanceOf(RecoveryIntegrityError);
});

test("epoch recovery excludes locally superseded originals from replay and reupload", async () => {
  const original = await envelope(operation("Superseded plan"));
  const plan = await planEpochRecovery({
    ownerId,
    oldShadow: [],
    activeOutbox: [{
      ...original,
      state: "queued",
      superseded_by: "44444444-4444-4444-8444-444444444444" as UUID,
    }],
    newServerPrefix: [],
  });

  expect(plan.replay_union).toEqual([]);
  expect(plan.upload_ready).toEqual([]);
  expect(plan.upload_blocked).toEqual([]);
});
