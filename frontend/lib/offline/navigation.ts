import type { BuildGate } from "../storage/vault";

/** Prefer a full document request when the approved App Router Flight is not reachable. */
export async function shouldUseDocumentNavigation(gate: BuildGate | null): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return false;
  if (!gate || gate.phase !== "running" || !navigator.onLine) return true;
  try {
    const response = await fetch("/dayforge-build.json", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return true;
    const value = await response.json() as { build_id?: unknown; schema_version?: unknown };
    return response.headers.get("X-Dayforge-Build") !== gate.approved_build ||
      value.build_id !== gate.approved_build || value.schema_version !== gate.schema_version;
  } catch {
    return true;
  }
}
