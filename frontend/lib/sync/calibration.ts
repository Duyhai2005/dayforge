import { getClock } from "../../services/sync";
import {
  commitOwnerChanges,
  type BuildGate,
  type OwnerSnapshot,
} from "../storage/vault";
import {
  estimateUtcAfterRestart,
  estimateUtcFromAnchor,
  calibrationNeedsReview,
  selectClockCalibration,
  type ClockCalibration,
  type ClockProbe,
} from "./clock";
import { nextEditTime, type EditTime, type EditTimeQuality, type UUID } from "./protocol";

const RECALIBRATE_AFTER_MS = 10 * 60 * 1_000;

export async function sampleOwnerClock(input: {
  snapshot: OwnerSnapshot;
  deviceId?: UUID;
  signal?: AbortSignal;
}): Promise<ClockCalibration> {
  const probes: ClockProbe[] = [];
  const deviceId = input.deviceId ?? input.snapshot.metadata.device_id;
  for (let sample = 0; sample < 3; sample += 1) {
    if (input.signal?.aborted) throw new DOMException("Clock calibration aborted", "AbortError");
    const wallStarted = Date.now();
    const monotonicStarted = performance.now();
    const response = await getClock({
      deviceId,
      verifiedOwnerId: input.snapshot.metadata.owner_id,
      signal: input.signal,
    });
    const monotonicReceived = performance.now();
    const wallReceived = Date.now();
    probes.push({
      calibration_id: response.calibration_id,
      server_time_ms: response.server_time_ms,
      wall_started_ms: wallStarted,
      wall_received_ms: wallReceived,
      monotonic_started_ms: monotonicStarted,
      monotonic_received_ms: monotonicReceived,
    });
  }
  return selectClockCalibration(probes);
}

export function ownerNeedsClockCalibration(snapshot: OwnerSnapshot, nowMs = Date.now()): boolean {
  const prior = snapshot.metadata.clock_calibration;
  return !prior || !Number.isSafeInteger(nowMs) || nowMs < prior.calibrated_at_wall_ms ||
    nowMs - prior.calibrated_at_wall_ms >= RECALIBRATE_AFTER_MS;
}

/** Capture three server samples and persist the lowest-RTT anchor under owner CAS. */
export async function calibrateOwnerClock(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  expectedFencingToken: number;
  signal?: AbortSignal;
}): Promise<{ calibration: ClockCalibration; committed: boolean; reviewCalibrationId: UUID | null }> {
  const calibration = await sampleOwnerClock({ snapshot: input.snapshot, signal: input.signal });
  const previous = input.snapshot.metadata.clock_calibration;
  const committed = await commitOwnerChanges({
    database: input.database,
    guard: {
      owner_id: input.snapshot.metadata.owner_id,
      expected_revision: input.snapshot.metadata.local_state_revision,
      expected_lock_epoch: input.snapshot.metadata.lock_epoch,
      expected_generation: input.snapshot.metadata.sync_generation,
      expected_server_epoch: input.snapshot.metadata.server_epoch,
      expected_cursor: input.snapshot.metadata.pull_cursor,
      expected_build: input.expectedBuild,
      expected_gate_revision: input.gate.revision,
      expected_fencing_token: input.expectedFencingToken,
    },
    writes: [],
    metadataPatch: {
      clock_calibration: {
        ...calibration,
        calibrated_at_wall_ms: Date.now(),
      },
    },
  });
  return {
    calibration,
    committed: committed.committed,
    reviewCalibrationId: previous && calibrationNeedsReview(previous.offset_ms, calibration.offset_ms)
      ? previous.calibration_id
      : null,
  };
}

export function calibratedEditTime(input: {
  calibration: OwnerSnapshot["metadata"]["clock_calibration"];
  local?: OwnerSnapshot["metadata"]["local_hlc"];
  observed: OwnerSnapshot["metadata"]["observed_hlc"];
  rawWallMs?: number;
  monotonicMs?: number;
}): EditTime {
  const rawWall = input.rawWallMs ?? Date.now();
  const monotonic = input.monotonicMs ?? performance.now();
  let utcEstimate = rawWall;
  let calibrationId = input.calibration?.calibration_id ?? crypto.randomUUID();
  let quality: EditTimeQuality = "untrusted";
  if (input.calibration) {
    const anchor: ClockCalibration = {
      calibration_id: input.calibration.calibration_id,
      server_time_ms: input.calibration.server_time_ms,
      raw_wall_at_receive_ms: input.calibration.raw_wall_at_receive_ms,
      monotonic_at_receive_ms: input.calibration.monotonic_at_receive_ms,
      offset_ms: input.calibration.offset_ms,
      round_trip_ms: input.calibration.round_trip_ms,
    };
    const sameSession = monotonic >= anchor.monotonic_at_receive_ms;
    const estimate = sameSession
      ? estimateUtcFromAnchor(anchor, rawWall, monotonic)
      : estimateUtcAfterRestart(anchor, rawWall, input.observed?.physical_ms ?? null);
    if (estimate.trusted) {
      utcEstimate = estimate.utc_ms;
      calibrationId = estimate.calibration_id;
      quality = sameSession ? "calibrated" : "offline_estimate";
    }
  }
  return nextEditTime({
    utc_estimate_ms: utcEstimate,
    raw_wall_ms: rawWall,
    calibration_id: calibrationId,
    quality,
    local: input.local,
    observed: input.observed ? [input.observed] : [],
  });
}
