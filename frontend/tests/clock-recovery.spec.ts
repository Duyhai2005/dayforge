import { expect, test } from "@playwright/test";
import { prepareClockReauthorBatch } from "../lib/sync/clock-recovery";
import { hashOperation, type Operation, type UUID } from "../lib/sync/protocol";
import { replayOperations, semanticRootHash } from "../lib/sync/reducer";
import { encryptOwnerPayload, type OwnerSnapshot } from "../lib/storage/vault";
import type { StoredOutboxEnvelope } from "../lib/sync/outbox";

test("clock repair creates a trusted replacement lane without changing task intent", async () => {
  const ownerId = "11111111-1111-4111-8111-111111111111" as UUID;
  const operationId = "22222222-2222-4222-8222-222222222222" as UUID;
  const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
  const keyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
  const calibrationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
  const root = { kind: "work_item" as const, id: "55555555-5555-4555-8555-555555555555" as UUID };
  const instant = Date.now();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const operation: Operation = {
    protocol_version: 1,
    reducer_version: 1,
    operation_id: operationId,
    owner_id: ownerId,
    device_id: deviceId,
    device_sequence: "1",
    edit_time: {
      physical_ms: 1_000,
      logical: 0,
      calibration_id: calibrationId,
      raw_wall_ms: 1_000,
      quality: "untrusted",
    },
    dependencies: [],
    commands: [{
      root,
      action: "work_item.create_single",
      payload: { data: {
        title: "Task preserved during clock repair",
        date: "2026-11-02",
        period: "morning",
        duration_minutes: 30,
        plan_id: null,
        standalone_color_id: "neutral",
        status: "pending",
        order_key: "0",
      } },
      precondition: { expected_root_hash: await semanticRootHash(root, null) },
    }],
  };
  const envelope: StoredOutboxEnvelope = {
    operation,
    request_hash: await hashOperation(operation),
    state: "quarantined",
    ever_recorded: false,
    commit_uncertain: false,
    attempts: 0,
    next_attempt_at_ms: null,
    superseded_by: null,
    receipt: null,
    problem_code: "time_invalid",
  };
  const cipher = await encryptOwnerPayload({ ownerId, store: "outbox", recordId: operationId, keyId, key, payload: envelope });
  const snapshot: OwnerSnapshot = {
    metadata: {
      owner_id: ownerId,
      local_state_revision: 1,
      lock_epoch: 0,
      sync_generation: 0,
      server_epoch: null,
      pull_cursor: "0",
      device_id: deviceId,
      device_sequence: "1",
      local_hlc: null,
      observed_hlc: null,
      key_id: keyId,
      clock_calibration: {
        calibration_id: calibrationId,
        server_time_ms: instant,
        raw_wall_at_receive_ms: instant,
        monotonic_at_receive_ms: performance.now(),
        offset_ms: 0,
        round_trip_ms: 10,
        calibrated_at_wall_ms: instant,
      },
    },
    auth: { owner_id: ownerId, locked: false, lock_epoch: 0, crypto_key: key, logout_ticket: null },
    outbox: [{
      id: `${ownerId}:${operationId}`,
      owner_id: ownerId,
      record_id: operationId,
      key_id: keyId,
      ...cipher,
      state: envelope.state,
      request_hash: envelope.request_hash,
      superseded_by: null,
      created_at_ms: instant,
    }],
    shadow: [],
    projection: [],
    diagnostics: [],
    drafts: [],
    journal: [],
  };

  const prepared = await prepareClockReauthorBatch({ snapshot, sourceOperations: [operation] });
  const replacement = prepared.replacements.get(operationId);
  expect(replacement).toBeDefined();
  expect(prepared.newDeviceId).not.toBe(deviceId);
  expect(replacement?.operation_id).not.toBe(operationId);
  expect(replacement?.device_id).toBe(prepared.newDeviceId);
  expect(replacement?.device_sequence).toBe("1");
  expect(replacement?.edit_time.quality).toBe("calibrated");
  expect(replacement?.commands[0].payload).toEqual(operation.commands[0].payload);
  expect(replacement?.commands[0].precondition?.expected_root_hash).toBe(await semanticRootHash(root, null));
  expect(await replayOperations([replacement!], ownerId)).toMatchObject({
    state: await replayOperations([operation], ownerId).then((result) => result.state),
  });
});
