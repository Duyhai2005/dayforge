export type RetryDisposition = "retry" | "auth_paused" | "blocked" | "integrity_error";

export interface RetryDecision {
  disposition: RetryDisposition;
  delay_ms: number | null;
}

const BASE_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

function clampRetryAfter(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

/** Exponential backoff with bounded jitter; Retry-After always takes precedence. */
export function retryDelay(attempt: number, retryAfterMs?: number | null, random = Math.random): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("Retry attempt must be a non-negative integer");
  const exponent = Math.min(attempt, 20);
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** exponent);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error("Random source must return a value from 0 to 1");
  const jittered = Math.round(ceiling * (0.5 + sample));
  return Math.max(jittered, clampRetryAfter(retryAfterMs) ?? 0);
}

/** Map HTTP outcomes to queue behavior without parsing localized detail text. */
export function classifySyncFailure(input: {
  status?: number;
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number | null;
}): RetryDecision {
  if (input.code === "operation_id_reused") return { disposition: "integrity_error", delay_ms: null };
  if (input.status === 401 || input.status === 403) return { disposition: "auth_paused", delay_ms: null };
  if (input.code === "dependency_missing") return { disposition: "retry", delay_ms: retryDelay(0, input.retryAfterMs) };
  if (input.code === "validation_failed" || input.code === "invalid_causality" || input.code === "time_invalid" ||
      input.code === "payload_too_large" || input.code === "client_update_required" || input.code === "cursor_epoch_mismatch") {
    return { disposition: "blocked", delay_ms: null };
  }
  const retryable = input.retryable === true || input.status === 429 || input.status === 503 || input.status === undefined;
  if (!retryable) return { disposition: "blocked", delay_ms: null };
  return { disposition: "retry", delay_ms: retryDelay(0, input.retryAfterMs) };
}

export function nextRetryDecision(input: {
  attempt: number;
  status?: number;
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number | null;
}): RetryDecision {
  const classified = classifySyncFailure(input);
  if (classified.disposition !== "retry") return classified;
  return { ...classified, delay_ms: retryDelay(input.attempt, input.retryAfterMs) };
}
