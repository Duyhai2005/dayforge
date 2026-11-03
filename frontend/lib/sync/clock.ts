import type { UUID } from "./protocol";

const MAX_SAMPLE_RTT_MS = 10_000;
const MAX_CLOCK_JUMP_MS = 120_000;
const MAX_SAFE_MILLIS = Number.MAX_SAFE_INTEGER;

export interface ClockProbe {
  calibration_id: UUID;
  server_time_ms: number;
  wall_started_ms: number;
  wall_received_ms: number;
  monotonic_started_ms: number;
  monotonic_received_ms: number;
}

export interface ClockCalibration {
  calibration_id: UUID;
  server_time_ms: number;
  raw_wall_at_receive_ms: number;
  monotonic_at_receive_ms: number;
  offset_ms: number;
  round_trip_ms: number;
}

export type ClockEstimate =
  | { trusted: true; utc_ms: number; raw_wall_ms: number; calibration_id: UUID }
  | { trusted: false; reason: "clock_jump" | "invalid_elapsed" | "unsafe_time" };

function isSafeMillis(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteMonotonic(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertProbe(probe: ClockProbe): void {
  if (!isSafeMillis(probe.server_time_ms) || !isSafeMillis(probe.wall_started_ms) || !isSafeMillis(probe.wall_received_ms) ||
      !isFiniteMonotonic(probe.monotonic_started_ms) || !isFiniteMonotonic(probe.monotonic_received_ms)) {
    throw new Error("clock probe contains an invalid timestamp");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(probe.calibration_id)) {
    throw new Error("clock probe calibration_id is not a supported lowercase UUID");
  }
}

/** Select the lowest-RTT sample among the required three, excluding slow or clock-jump samples. */
export function selectClockCalibration(probes: readonly ClockProbe[]): ClockCalibration {
  if (probes.length !== 3) throw new Error("clock calibration requires exactly three samples");
  const candidates: Array<{ probe: ClockProbe; rtt: number }> = [];

  for (const probe of probes) {
    assertProbe(probe);
    const rtt = probe.monotonic_received_ms - probe.monotonic_started_ms;
    const wallElapsed = probe.wall_received_ms - probe.wall_started_ms;
    if (rtt < 0 || Math.abs(wallElapsed - rtt) > MAX_CLOCK_JUMP_MS || rtt > MAX_SAMPLE_RTT_MS) continue;
    candidates.push({ probe, rtt });
  }

  candidates.sort((left, right) => left.rtt - right.rtt);
  const selected = candidates[0];
  if (!selected) throw new Error("no clock sample completed within 10 seconds without a clock jump");

  const { probe, rtt } = selected;
  const wallMidpoint = (probe.wall_started_ms + probe.wall_received_ms) / 2;
  const offset = probe.server_time_ms - wallMidpoint;
  return {
    calibration_id: probe.calibration_id,
    server_time_ms: probe.server_time_ms,
    raw_wall_at_receive_ms: probe.wall_received_ms,
    monotonic_at_receive_ms: probe.monotonic_received_ms,
    offset_ms: offset,
    round_trip_ms: rtt,
  };
}

/** Estimate UTC from an online anchor and monotonic elapsed time, rejecting detected wall-clock jumps. */
export function estimateUtcFromAnchor(
  calibration: ClockCalibration,
  rawWallNowMs: number,
  monotonicNowMs: number,
): ClockEstimate {
  if (!isSafeMillis(rawWallNowMs) || !isFiniteMonotonic(monotonicNowMs)) return { trusted: false, reason: "unsafe_time" };
  const monotonicElapsed = monotonicNowMs - calibration.monotonic_at_receive_ms;
  const wallElapsed = rawWallNowMs - calibration.raw_wall_at_receive_ms;
  if (monotonicElapsed < 0) return { trusted: false, reason: "invalid_elapsed" };
  if (Math.abs(wallElapsed - monotonicElapsed) > MAX_CLOCK_JUMP_MS) return { trusted: false, reason: "clock_jump" };

  const utc = calibration.server_time_ms + calibration.round_trip_ms / 2 + monotonicElapsed;
  if (!Number.isSafeInteger(Math.round(utc)) || utc < 0 || utc > MAX_SAFE_MILLIS) return { trusted: false, reason: "unsafe_time" };
  return {
    trusted: true,
    utc_ms: Math.round(utc),
    raw_wall_ms: rawWallNowMs,
    calibration_id: calibration.calibration_id,
  };
}

/** Offline restart estimate using the persisted offset; a large backward jump remains untrusted. */
export function estimateUtcAfterRestart(
  calibration: Pick<ClockCalibration, "calibration_id" | "offset_ms">,
  rawWallNowMs: number,
  latestObservedPhysicalMs: number | null,
): ClockEstimate {
  if (!isSafeMillis(rawWallNowMs) || !Number.isFinite(calibration.offset_ms)) return { trusted: false, reason: "unsafe_time" };
  if (latestObservedPhysicalMs !== null && !isSafeMillis(latestObservedPhysicalMs)) return { trusted: false, reason: "unsafe_time" };
  const utc = rawWallNowMs + calibration.offset_ms;
  if (!Number.isSafeInteger(Math.round(utc)) || utc < 0 || utc > MAX_SAFE_MILLIS) return { trusted: false, reason: "unsafe_time" };
  if (latestObservedPhysicalMs !== null && utc < latestObservedPhysicalMs - MAX_CLOCK_JUMP_MS) {
    return { trusted: false, reason: "clock_jump" };
  }
  return {
    trusted: true,
    utc_ms: Math.round(utc),
    raw_wall_ms: rawWallNowMs,
    calibration_id: calibration.calibration_id,
  };
}

/** Recalibration this far away requires queued operations from the prior calibration to be reviewed. */
export function calibrationNeedsReview(previousOffsetMs: number, nextOffsetMs: number): boolean {
  if (!Number.isFinite(previousOffsetMs) || !Number.isFinite(nextOffsetMs)) return true;
  return Math.abs(nextOffsetMs - previousOffsetMs) > MAX_CLOCK_JUMP_MS;
}
