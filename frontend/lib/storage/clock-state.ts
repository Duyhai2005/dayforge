import { StorageError } from "./errors";

export interface HlcEditTime {
  physical_ms: number;
  logical: number;
  calibration_id: string; // UUID
  raw_wall_ms: number;
  quality: "calibrated" | "offline_estimate" | "untrusted";
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const UINT32_MAX = 0xffffffff;

export function validateHlc(hlc: unknown): hlc is HlcEditTime {
  if (!hlc || typeof hlc !== "object") {
    return false;
  }
  const candidate = hlc as Partial<HlcEditTime>;
  if (
    typeof candidate.physical_ms !== "number" ||
    !Number.isInteger(candidate.physical_ms) ||
    candidate.physical_ms < 0 ||
    candidate.physical_ms > Number.MAX_SAFE_INTEGER
  ) {
    return false;
  }
  if (
    typeof candidate.logical !== "number" ||
    !Number.isInteger(candidate.logical) ||
    candidate.logical < 0 ||
    candidate.logical > UINT32_MAX
  ) {
    return false;
  }
  if (
    typeof candidate.raw_wall_ms !== "number" ||
    !Number.isFinite(candidate.raw_wall_ms) ||
    candidate.raw_wall_ms < 0
  ) {
    return false;
  }
  if (
    typeof candidate.calibration_id !== "string" ||
    !UUID_REGEX.test(candidate.calibration_id)
  ) {
    return false;
  }
  if (
    candidate.quality !== "calibrated" &&
    candidate.quality !== "offline_estimate" &&
    candidate.quality !== "untrusted"
  ) {
    return false;
  }
  return true;
}

export function advanceHlc(
  currentHlc: HlcEditTime | null,
  estimatedUtcMs: number,
  calibrationId: string,
  quality: "calibrated" | "offline_estimate" | "untrusted" = "calibrated",
  rawWallMs: number = estimatedUtcMs
): HlcEditTime {
  if (
    !Number.isFinite(estimatedUtcMs) ||
    estimatedUtcMs < 0 ||
    estimatedUtcMs > Number.MAX_SAFE_INTEGER
  ) {
    throw new StorageError(
      "invalid_data",
      `Invalid estimated UTC milliseconds: ${estimatedUtcMs}`
    );
  }
  if (
    !Number.isFinite(rawWallMs) ||
    rawWallMs < 0 ||
    rawWallMs > Number.MAX_SAFE_INTEGER
  ) {
    throw new StorageError(
      "invalid_data",
      `Invalid raw wall milliseconds: ${rawWallMs}`
    );
  }
  if (!UUID_REGEX.test(calibrationId)) {
    throw new StorageError(
      "invalid_data",
      `Invalid calibration UUID: ${calibrationId}`
    );
  }

  const roundedUtc = Math.floor(estimatedUtcMs);
  const roundedRawWall = Math.floor(rawWallMs);
  if (!currentHlc) {
    return {
      physical_ms: roundedUtc,
      logical: 0,
      calibration_id: calibrationId,
      raw_wall_ms: roundedRawWall,
      quality,
    };
  }

  const currentPhysical = currentHlc.physical_ms;
  let physical_ms: number;
  let logical: number;

  if (roundedUtc > currentPhysical) {
    physical_ms = roundedUtc;
    logical = 0;
  } else {
    physical_ms = currentPhysical;
    if (currentHlc.logical >= UINT32_MAX) {
      throw new StorageError(
        "invalid_data",
        "HLC logical counter overflow: maximum uint32 exceeded"
      );
    }
    logical = currentHlc.logical + 1;
  }

  return {
    physical_ms,
    logical,
    calibration_id: calibrationId,
    raw_wall_ms: roundedRawWall,
    quality,
  };
}
