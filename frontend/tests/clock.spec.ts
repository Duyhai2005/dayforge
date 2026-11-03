import { expect, test } from "@playwright/test";
import {
  calibrationNeedsReview,
  estimateUtcAfterRestart,
  estimateUtcFromAnchor,
  selectClockCalibration,
  type ClockCalibration,
  type ClockProbe,
} from "../lib/sync/clock";
import { nextEditTime, type UUID } from "../lib/sync/protocol";

const calibrationIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as UUID[];

function probe(
  index: number,
  wallStart: number,
  wallElapsed: number,
  monotonicStart: number,
  roundTrip: number,
  serverTime: number,
): ClockProbe {
  return {
    calibration_id: calibrationIds[index],
    server_time_ms: serverTime,
    wall_started_ms: wallStart,
    wall_received_ms: wallStart + wallElapsed,
    monotonic_started_ms: monotonicStart,
    monotonic_received_ms: monotonicStart + roundTrip,
  };
}

test("clock calibration chooses the fastest valid sample and rejects slow or jumped samples", () => {
  const calibration = selectClockCalibration([
    probe(0, 1_000_000, 110, 10, 110, 1_000_055),
    probe(1, 1_000_200, 14, 120, 14, 1_000_207),
    probe(2, 1_000_300, 300_000, 140, 8, 1_000_304),
  ]);
  expect(calibration.calibration_id).toBe(calibrationIds[1]);
  expect(calibration.round_trip_ms).toBe(14);
  expect(calibration.offset_ms).toBe(0);

  expect(() => selectClockCalibration([
    probe(0, 1_000_000, 10_001, 10, 10_001, 1_005_000),
    probe(1, 1_020_000, 10_001, 20_000, 10_001, 1_025_000),
    probe(2, 1_040_000, 10_001, 40_000, 10_001, 1_045_000),
  ])).toThrow("no clock sample completed");
});

test("monotonic anchors detect forward and backward wall-clock jumps", () => {
  const anchor: ClockCalibration = {
    calibration_id: calibrationIds[0],
    server_time_ms: 2_000_000,
    raw_wall_at_receive_ms: 2_000_100,
    monotonic_at_receive_ms: 500,
    offset_ms: 0,
    round_trip_ms: 20,
  };
  expect(estimateUtcFromAnchor(anchor, 2_010_105, 10_500)).toMatchObject({
    trusted: true,
    utc_ms: 2_010_010,
  });
  expect(estimateUtcFromAnchor(anchor, 2_300_100, 10_500)).toMatchObject({
    trusted: false,
    reason: "clock_jump",
  });
  expect(estimateUtcFromAnchor(anchor, 1_700_100, 10_500)).toMatchObject({
    trusted: false,
    reason: "clock_jump",
  });
});

test("offline restart keeps HLC monotonic and flags large recalibration changes for review", () => {
  const calibration = { calibration_id: calibrationIds[1], offset_ms: 5_000 };
  const restarted = estimateUtcAfterRestart(calibration, 500_000, 502_000);
  expect(restarted).toMatchObject({ trusted: true, utc_ms: 505_000 });

  const editTime = nextEditTime({
    utc_estimate_ms: restarted.trusted ? restarted.utc_ms : 0,
    raw_wall_ms: 500_000,
    calibration_id: calibration.calibration_id,
    quality: "offline_estimate",
    observed: [{ physical_ms: 510_000, logical: 7 }],
  });
  expect(editTime).toMatchObject({ physical_ms: 510_000, logical: 8, quality: "offline_estimate" });

  expect(estimateUtcAfterRestart(calibration, 100_000, 500_000)).toMatchObject({
    trusted: false,
    reason: "clock_jump",
  });
  expect(calibrationNeedsReview(5_000, 125_001)).toBe(true);
  expect(calibrationNeedsReview(5_000, 125_000)).toBe(false);
});
