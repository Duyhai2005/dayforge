export interface HlcEditTime {
  physical_ms: number;
  logical: number;
  calibration_id: string; // UUID
  raw_wall_ms: number;
  quality: "calibrated" | "offline_estimate" | "untrusted";
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateHlc(hlc: unknown): hlc is HlcEditTime {
  if (!hlc || typeof hlc !== "object") {
    return false;
  }
  const candidate = hlc as Partial<HlcEditTime>;
  if (
    typeof candidate.physical_ms !== "number" ||
    !Number.isInteger(candidate.physical_ms) ||
    candidate.physical_ms < 0
  ) {
    return false;
  }
  if (
    typeof candidate.logical !== "number" ||
    !Number.isInteger(candidate.logical) ||
    candidate.logical < 0 ||
    candidate.logical > 0xffffffff
  ) {
    return false;
  }
  if (
    typeof candidate.raw_wall_ms !== "number" ||
    !Number.isFinite(candidate.raw_wall_ms)
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
  wallMs: number,
  calibrationId: string,
  quality: "calibrated" | "offline_estimate" = "calibrated"
): HlcEditTime {
  const roundedWall = Math.floor(wallMs);
  if (!currentHlc) {
    return {
      physical_ms: roundedWall,
      logical: 0,
      calibration_id: calibrationId,
      raw_wall_ms: roundedWall,
      quality,
    };
  }

  const currentPhysical = currentHlc.physical_ms;
  let physical_ms: number;
  let logical: number;

  if (roundedWall > currentPhysical) {
    physical_ms = roundedWall;
    logical = 0;
  } else {
    physical_ms = currentPhysical;
    logical = currentHlc.logical + 1;
  }

  return {
    physical_ms,
    logical,
    calibration_id: calibrationId,
    raw_wall_ms: roundedWall,
    quality,
  };
}
