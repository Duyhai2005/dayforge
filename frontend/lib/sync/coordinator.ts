import {
  assertVersionInfo,
  orderOperationsByDependencies,
  type Operation,
  type SyncPage,
  type UUID,
} from "./protocol";
import {
  bootstrap as fetchBootstrapPage,
  getVersion,
  pull as fetchPullPage,
  push as pushOperations,
  SyncHttpError,
} from "../../services/sync";
import {
  readBuildGate,
  readOwnerSnapshot,
  type BuildGate,
  type OwnerSnapshot,
} from "../storage/vault";
import { acknowledgePushResponse, preparePushUpdates, readActiveOutbox, updateOutboxEntries } from "./outbox";
import { discardBootstrapStage, findBootstrapStage, stageBootstrapPage, publishBootstrapStage } from "./bootstrap";
import { ingestPullPage } from "./ingestion";
import { readRecordedShadow } from "./projection";
import { startOwnerLeadership, type LeaderLease, type LeadershipHandle } from "./leadership";
import { classifySyncFailure, nextRetryDecision, retryDelay } from "./retry";
import { commitClockReauthorBatch, prepareClockReauthorBatch } from "./clock-recovery";
import { persistEpochRecoveryJournal, publishEpochRecoveryStage } from "./recovery";
import { calibrateOwnerClock, ownerNeedsClockCalibration, sampleOwnerClock } from "./calibration";
import { countPendingOperations } from "./status-view";

export type CoordinatorStatus =
  | { state: "stopped" }
  | { state: "waiting_for_leader" }
  | { state: "syncing"; pending: number }
  | { state: "synced" }
  | { state: "offline"; pending: number; retry_at_ms: number }
  | { state: "auth_paused"; pending: number }
  | { state: "blocked"; pending: number; code: string }
  | { state: "integrity_error"; pending: number; code: string }
  | { state: "error"; pending: number; message: string };

export interface SessionAssertion {
  owner_id: UUID;
  csrf_token: string;
}

export interface SyncCoordinatorHandle {
  wake(): void;
  repairClockIssues(): Promise<void>;
  stop(): Promise<void>;
  status(): CoordinatorStatus;
}

interface Runtime {
  stopped: boolean;
  lease: LeaderLease;
  abort: AbortController;
  paused: boolean;
  pauseEpoch: UUID | null;
  loopRunning: boolean;
  wakeRequested: boolean;
  retryTimer: number | null;
  retryAtMs: number | null;
  pauseDrainWaiters: Array<() => void>;
  resumeAfterDrainEpoch: UUID | null;
}

const POLL_INTERVAL_MS = 30_000;
const MAX_TOKEN_RESTARTS = 3;

class EpochRecoveryRequired extends Error {
  constructor() { super("The server sync epoch changed; local recovery is required"); this.name = "EpochRecoveryRequired"; }
}

function pendingCount(entries: Awaited<ReturnType<typeof readActiveOutbox>>): number {
  return countPendingOperations(entries);
}

async function readPendingCount(input: { database: IDBDatabase; ownerId: UUID; buildId: string }): Promise<number> {
  try {
    const snapshot = await freshSnapshot(input);
    if (!snapshot.auth.locked && snapshot.auth.crypto_key) {
      return pendingCount(await readActiveOutbox(snapshot));
    }
    return snapshot.outbox.filter((row) => !row.superseded_by && row.state !== "ack_waiting_pull").length;
  } catch {
    return 0;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof SyncHttpError) return error.problem?.code ?? `sync_http_${error.status}`;
  return error instanceof Error ? error.name : "sync_error";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function freshSnapshot(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
}): Promise<OwnerSnapshot> {
  return readOwnerSnapshot(input.database, input.ownerId, input.buildId);
}

async function freshGate(database: IDBDatabase): Promise<BuildGate> {
  const gate = await readBuildGate(database);
  if (!gate) throw new Error("Build update gate is unavailable");
  return gate;
}

function isPageTokenExpired(error: unknown): boolean {
  return error instanceof SyncHttpError && error.status === 409 && error.problem?.code === "page_token_expired";
}

async function bootstrapOwner(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
  fencingToken: number;
  signal: AbortSignal;
  recoveryJournalId?: UUID;
}): Promise<void> {
  let latest = await freshSnapshot(input);
  let existing = await findBootstrapStage({ database: input.database, snapshot: latest });
  let pageToken: string | null = existing?.next_page_token ?? null;
  let sessionId: UUID | undefined = existing?.session_id;
  let complete = existing?.complete ?? false;
  let tokenRestarts = 0;
  while (!complete) {
    let page: SyncPage;
    try {
      page = await fetchBootstrapPage({
        verifiedOwnerId: input.ownerId,
        pageToken: pageToken ?? undefined,
        signal: input.signal,
      });
    } catch (error) {
      if (!pageToken || !isPageTokenExpired(error)) throw error;
      if (sessionId) {
        let discarded = false;
        for (let attempt = 0; attempt < 3 && !discarded; attempt += 1) {
          latest = await freshSnapshot(input);
          const result = await discardBootstrapStage({
            database: input.database,
            snapshot: latest,
            gate: await freshGate(input.database),
            expectedBuild: input.buildId,
            expectedFencingToken: input.fencingToken,
            sessionId,
          });
          discarded = result.committed;
        }
        if (!discarded) throw new Error("Expired bootstrap stage changed before it could be discarded");
      }
      if (tokenRestarts >= MAX_TOKEN_RESTARTS) throw error;
      tokenRestarts += 1;
      latest = await freshSnapshot(input);
      existing = null;
      pageToken = null;
      sessionId = undefined;
      complete = false;
      continue;
    }
    latest = await freshSnapshot(input);
    const gate = await freshGate(input.database);
    const staged = await stageBootstrapPage({
      database: input.database,
      snapshot: latest,
      gate,
      expectedBuild: input.buildId,
      expectedFencingToken: input.fencingToken,
      page,
      usedPageToken: pageToken,
      sessionId,
    });
    if (!staged.result.committed) throw new Error(`Bootstrap page lost its owner guard: ${staged.result.reason}`);
    sessionId = staged.sessionId;
    pageToken = staged.stage.next_page_token;
    complete = staged.stage.complete;
  }
  if (!sessionId) throw new Error("Bootstrap did not create a staging session");
  latest = await freshSnapshot(input);
  const gate = await freshGate(input.database);
  const published = input.recoveryJournalId
    ? (await publishEpochRecoveryStage({
        database: input.database,
        snapshot: latest,
        gate,
        expectedBuild: input.buildId,
        expectedFencingToken: input.fencingToken,
        sessionId,
        journalId: input.recoveryJournalId,
      })).result
    : await publishBootstrapStage({
        database: input.database,
        snapshot: latest,
        gate,
        expectedBuild: input.buildId,
        expectedFencingToken: input.fencingToken,
        sessionId,
      });
  if (!published.committed) throw new Error(`Bootstrap publish lost its owner guard: ${published.reason}`);
}

async function recoverOwnerEpoch(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
  fencingToken: number;
  signal: AbortSignal;
}): Promise<void> {
  let journalId: UUID | null = null;
  for (let attempt = 0; attempt < 3 && !journalId; attempt += 1) {
    const snapshot = await freshSnapshot(input);
    const gate = await freshGate(input.database);
    const journal = await persistEpochRecoveryJournal({
      database: input.database,
      snapshot,
      gate,
      expectedBuild: input.buildId,
      expectedFencingToken: input.fencingToken,
    });
    if (journal) journalId = journal.journalId;
  }
  if (!journalId) throw new Error("Unable to preserve the current owner state before epoch recovery");
  await bootstrapOwner({ ...input, recoveryJournalId: journalId });
}

async function pullUntilCurrent(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
  fencingToken: number;
  signal: AbortSignal;
  initial: OwnerSnapshot;
}): Promise<OwnerSnapshot> {
  let snapshot = input.initial;
  let pageToken: string | undefined;
  let after = snapshot.metadata.pull_cursor;
  let tokenRestarts = 0;
  do {
    let page: SyncPage;
    try {
      page = await fetchPullPage({
        epoch: snapshot.metadata.server_epoch!,
        verifiedOwnerId: input.ownerId,
        after: pageToken ? undefined : after,
        pageToken,
      }, input.signal);
    } catch (error) {
      if (!pageToken || !isPageTokenExpired(error) || tokenRestarts >= MAX_TOKEN_RESTARTS) throw error;
      tokenRestarts += 1;
      snapshot = await freshSnapshot(input);
      if (snapshot.metadata.server_epoch !== input.initial.metadata.server_epoch) {
        throw new Error("Pull epoch changed while restarting an expired page token");
      }
      after = snapshot.metadata.pull_cursor;
      pageToken = undefined;
      continue;
    }
    const gate = await freshGate(input.database);
    const ingested = await ingestPullPage({
      database: input.database,
      snapshot,
      gate,
      expectedBuild: input.buildId,
      expectedFencingToken: input.fencingToken,
      after,
      page,
    });
    if (!ingested.result.committed) {
      snapshot = await freshSnapshot(input);
      if (snapshot.metadata.server_epoch !== page.epoch) throw new Error("Pull response became stale across a server epoch change");
      after = snapshot.metadata.pull_cursor;
      pageToken = undefined;
      continue;
    }
    pageToken = page.next_page_token ?? undefined;
    after = page.next_cursor;
    if (pageToken === undefined) break;
    snapshot = await freshSnapshot(input);
  } while (true);
  return freshSnapshot(input);
}

async function quarantineClockDescendants(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
  fencingToken: number;
  rootIds: readonly UUID[];
  rootProblemCode?: string;
}): Promise<void> {
  if (input.rootIds.length === 0) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await freshSnapshot(input);
    const entries = await readActiveOutbox(snapshot);
    const quarantinedIds = new Set(input.rootIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries) {
        const id = entry.operation.operation_id;
        if (quarantinedIds.has(id) || entry.ever_recorded || entry.commit_uncertain ||
            entry.state === "sending" || entry.state === "ack_waiting_pull") continue;
        if (entry.operation.dependencies.some((dependency) => quarantinedIds.has(dependency))) {
          quarantinedIds.add(id);
          changed = true;
        }
      }
    }
    const updates = entries
      .filter((entry) => quarantinedIds.has(entry.operation.operation_id) && entry.state !== "quarantined")
      .map((entry) => ({ operationId: entry.operation.operation_id, patch: {
        state: "quarantined" as const,
        next_attempt_at_ms: null,
        problem_code: input.rootIds.includes(entry.operation.operation_id)
          ? input.rootProblemCode ?? "time_invalid"
          : "clock_dependency_quarantined",
      } }));
    if (!updates.length) return;
    const result = await updateOutboxEntries({
      database: input.database,
      snapshot,
      gate: await freshGate(input.database),
      expectedBuild: input.buildId,
      expectedFencingToken: input.fencingToken,
      updates,
    });
    if (result.committed) return;
  }
  throw new Error("Clock quarantine lost repeated owner revision guards");
}

async function pushReady(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
  fencingToken: number;
  signal: AbortSignal;
  session: SessionAssertion;
  initial: OwnerSnapshot;
  onRetry(delayMs: number): void;
  onAuthPause(): void;
  onBlocked(code: string, integrity: boolean): void;
}): Promise<void> {
  let snapshot = input.initial;
  for (let batchIndex = 0; batchIndex < 100; batchIndex += 1) {
    if (input.signal.aborted) return;
    const entries = await readActiveOutbox(snapshot);
    const recorded = await readRecordedShadow(snapshot);
    const known = new Map(recorded.map(({ group }) => [group.operation.operation_id, group.operation]));
    const nowMs = Date.now();
    const candidates = entries.filter((entry) => entry.state !== "blocked" && entry.state !== "quarantined" &&
      entry.state !== "ack_waiting_pull" && (entry.next_attempt_at_ms === null || entry.next_attempt_at_ms <= nowMs));
    const ordered = orderOperationsByDependencies(candidates.map((entry) => entry.operation), known);
    if (ordered.ready.length === 0) {
      const nextDue = entries.filter((entry) => entry.state !== "blocked" && entry.state !== "quarantined" &&
        entry.state !== "ack_waiting_pull" && entry.next_attempt_at_ms !== null)
        .reduce<number | null>((minimum, entry) => minimum === null ? entry.next_attempt_at_ms : Math.min(minimum, entry.next_attempt_at_ms!), null);
      if (nextDue !== null) input.onRetry(Math.max(250, nextDue - Date.now()));
      return;
    }
    const selected = ordered.ready.slice(0, 100);
    const mark = preparePushUpdates(entries, selected.map((operation) => operation.operation_id));
    const gate = await freshGate(input.database);
    const sendingResult = await updateOutboxEntries({
      database: input.database,
      snapshot,
      gate,
      expectedBuild: input.buildId,
      expectedFencingToken: input.fencingToken,
      updates: mark,
    });
    if (!sendingResult.committed) {
      snapshot = await freshSnapshot(input);
      continue;
    }
    snapshot = await freshSnapshot(input);
    try {
      const response = await pushOperations({
        operations: selected,
        verifiedOwnerId: input.ownerId,
        csrfToken: input.session.csrf_token,
        signal: input.signal,
      });
      if (response.epoch !== snapshot.metadata.server_epoch) throw new EpochRecoveryRequired();
      const ack = await acknowledgePushResponse({
        database: input.database,
        snapshot,
        gate: await freshGate(input.database),
        expectedBuild: input.buildId,
        expectedFencingToken: input.fencingToken,
        sentOperations: selected,
        response,
      });
      if (!ack.committed) {
        snapshot = await freshSnapshot(input);
        // The response is immutable and idempotent. Retry the same operation ids.
        batchIndex -= 1;
        continue;
      }
      const clockInvalidIds = response.results
        .filter((result) => result.status === "rejected" && result.problem.code === "time_invalid")
        .map((result) => result.status === "rejected" ? result.operation_id : null)
        .filter((id): id is UUID => id !== null);
      if (clockInvalidIds.length) {
        await quarantineClockDescendants({
          database: input.database,
          ownerId: input.ownerId,
          buildId: input.buildId,
          fencingToken: input.fencingToken,
          rootIds: clockInvalidIds,
          rootProblemCode: "time_invalid",
        });
        input.onBlocked("time_invalid", false);
        return;
      }
      const rejected = response.results.find((result) => result.status === "rejected" ||
        (result.status === "deferred" && !result.problem.retryable));
      if (rejected && (rejected.status === "rejected" || rejected.status === "deferred")) {
        input.onBlocked(rejected.problem.code, rejected.problem.code === "operation_id_reused");
      }
    } catch (error) {
      if (isAbort(error) || input.signal.aborted) return;
      if (error instanceof EpochRecoveryRequired || (error instanceof SyncHttpError && error.problem?.code === "cursor_epoch_mismatch")) {
        throw new EpochRecoveryRequired();
      }
      const decision = error instanceof SyncHttpError
        ? nextRetryDecision({
            attempt: Math.max(...selected.map((operation) => entries.find((entry) => entry.operation.operation_id === operation.operation_id)?.attempts ?? 0)),
            status: error.status,
            code: error.problem?.code,
            retryable: error.problem?.retryable,
            retryAfterMs: error.retryAfterMs,
          })
        : classifySyncFailure({});
      if (decision.disposition === "auth_paused") {
        input.onAuthPause();
        return;
      }
      if (decision.disposition === "integrity_error" || decision.disposition === "blocked") {
        const latestEntries = await readActiveOutbox(snapshot);
        const updates = selected.map((operation) => ({
          operationId: operation.operation_id,
          patch: {
            state: decision.disposition === "integrity_error" ? "quarantined" as const : "blocked" as const,
            next_attempt_at_ms: null,
            commit_uncertain: decision.disposition === "integrity_error",
            problem_code: errorCode(error),
          },
        }));
        const changed = await updateOutboxEntries({
          database: input.database,
          snapshot,
          gate: await freshGate(input.database),
          expectedBuild: input.buildId,
          expectedFencingToken: input.fencingToken,
          updates: updates.filter((update) => latestEntries.some((entry) => entry.operation.operation_id === update.operationId)),
        });
        if (!changed.committed) return;
        if (error instanceof SyncHttpError && error.problem?.code === "time_invalid") {
          await quarantineClockDescendants({
            database: input.database,
            ownerId: input.ownerId,
            buildId: input.buildId,
            fencingToken: input.fencingToken,
            rootIds: selected.map((operation) => operation.operation_id),
            rootProblemCode: "time_invalid",
          });
        }
        input.onBlocked(errorCode(error), decision.disposition === "integrity_error");
        return;
      }
      const delayMs = decision.delay_ms ?? retryDelay(0);
      const commitUncertain = !(error instanceof SyncHttpError && error.status >= 400 && error.status < 500 && error.status !== 429);
      const latestEntries = await readActiveOutbox(snapshot);
      const now = Date.now();
      const updates = selected
        .filter((operation) => latestEntries.some((entry) => entry.operation.operation_id === operation.operation_id))
        .map((operation) => ({ operationId: operation.operation_id, patch: {
          state: "queued" as const,
          next_attempt_at_ms: Math.min(Number.MAX_SAFE_INTEGER, now + delayMs),
          commit_uncertain: commitUncertain,
          problem_code: errorCode(error),
        } }));
      if (updates.length) {
        const queued = await updateOutboxEntries({
          database: input.database,
          snapshot,
          gate: await freshGate(input.database),
          expectedBuild: input.buildId,
          expectedFencingToken: input.fencingToken,
          updates,
        });
        if (!queued.committed) return;
      }
      input.onRetry(delayMs);
      return;
    }
    snapshot = await freshSnapshot(input);
  }
  input.onRetry(retryDelay(0));
}

/** One leader per owner drives immutable outbox, then pulls committed pages. */
export function startSyncCoordinator(input: {
  database: IDBDatabase;
  ownerId: UUID;
  buildId: string;
  lockEpoch: number;
  getSession(): Promise<SessionAssertion | null>;
  onStatus(status: CoordinatorStatus): void;
}): SyncCoordinatorHandle {
  let currentStatus: CoordinatorStatus = { state: "waiting_for_leader" };
  let runtime: Runtime | null = null;
  let stopped = false;
  const stateChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`dayforge-sync:${input.ownerId}`);

  const setStatus = (status: CoordinatorStatus) => {
    currentStatus = status;
    input.onStatus(status);
  };

  const requestWake = () => {
    if (!runtime || runtime.stopped || runtime.paused) return;
    if (runtime.retryAtMs !== null && Date.now() < runtime.retryAtMs) return;
    if (runtime.retryAtMs !== null) {
      runtime.retryAtMs = null;
      if (runtime.retryTimer !== null) window.clearTimeout(runtime.retryTimer);
      runtime.retryTimer = null;
    }
    runtime.wakeRequested = true;
    void run(runtime);
  };

  const scheduleRetry = (active: Runtime, delayMs: number) => {
    const deadline = Date.now() + Math.max(250, delayMs);
    active.retryAtMs = Math.max(active.retryAtMs ?? 0, deadline);
    if (active.retryTimer !== null) window.clearTimeout(active.retryTimer);
    active.retryTimer = window.setTimeout(() => {
      active.retryTimer = null;
      active.retryAtMs = null;
      requestWake();
    }, Math.max(250, active.retryAtMs - Date.now()));
  };

  const run = async (active: Runtime) => {
    if (active.stopped || active.loopRunning || active.abort.signal.aborted) return;
    active.loopRunning = true;
    active.wakeRequested = false;
    try {
      const session = await input.getSession();
      if (!session || session.owner_id !== input.ownerId) {
        setStatus({ state: "auth_paused", pending: await readPendingCount(input) });
        return;
      }
      active.retryAtMs = null;
      if (active.retryTimer !== null) window.clearTimeout(active.retryTimer);
      active.retryTimer = null;
      if (!/^[A-Za-z0-9_-]{43}$/.test(session.csrf_token)) throw new Error("Session CSRF token is invalid");
      assertVersionInfo(await getVersion(active.abort.signal));
      let snapshot = await freshSnapshot({ database: input.database, ownerId: input.ownerId, buildId: input.buildId });
      if (ownerNeedsClockCalibration(snapshot)) {
        const calibration = await calibrateOwnerClock({
          database: input.database,
          snapshot,
          gate: await freshGate(input.database),
          expectedBuild: input.buildId,
          expectedFencingToken: active.lease.fencing_token,
          signal: active.abort.signal,
        });
        snapshot = await freshSnapshot({ database: input.database, ownerId: input.ownerId, buildId: input.buildId });
        if (!calibration.committed) {
          setStatus({ state: "syncing", pending: 0 });
        } else if (calibration.reviewCalibrationId) {
          const oldCalibrationEntries = await readActiveOutbox(snapshot);
          const candidates = oldCalibrationEntries
            .filter((entry) => entry.operation.edit_time.calibration_id === calibration.reviewCalibrationId &&
              !entry.ever_recorded && !entry.commit_uncertain && entry.state === "queued")
            .map((entry) => entry.operation.operation_id);
          await quarantineClockDescendants({
            database: input.database,
            ownerId: input.ownerId,
            buildId: input.buildId,
            fencingToken: active.lease.fencing_token,
            rootIds: candidates,
            rootProblemCode: "clock_recalibration_review",
          });
          snapshot = await freshSnapshot({ database: input.database, ownerId: input.ownerId, buildId: input.buildId });
        }
      }
      const entries = await readActiveOutbox(snapshot);
      setStatus({ state: "syncing", pending: pendingCount(entries) });
      if (snapshot.metadata.server_epoch === null) {
        await bootstrapOwner({
          database: input.database,
          ownerId: input.ownerId,
          buildId: input.buildId,
          fencingToken: active.lease.fencing_token,
          signal: active.abort.signal,
        });
        snapshot = await freshSnapshot({ database: input.database, ownerId: input.ownerId, buildId: input.buildId });
      }
      await pushReady({
        database: input.database,
        ownerId: input.ownerId,
        buildId: input.buildId,
        fencingToken: active.lease.fencing_token,
        signal: active.abort.signal,
        session,
        initial: snapshot,
        onRetry: (delayMs) => {
          const retryAtMs = Date.now() + delayMs;
          scheduleRetry(active, delayMs);
          setStatus({ state: "offline", pending: pendingCount(entries), retry_at_ms: retryAtMs });
          void readPendingCount(input).then((pending) => {
            if (!active.stopped) setStatus({ state: "offline", pending, retry_at_ms: retryAtMs });
          });
        },
        onAuthPause: () => {
          setStatus({ state: "auth_paused", pending: pendingCount(entries) });
          void readPendingCount(input).then((pending) => setStatus({ state: "auth_paused", pending }));
        },
        onBlocked: (code, integrity) => {
          setStatus({
            state: integrity ? "integrity_error" : "blocked",
            pending: pendingCount(entries),
            code,
          });
          void readPendingCount(input).then((pending) => setStatus({
            state: integrity ? "integrity_error" : "blocked",
            pending,
            code,
          }));
        },
      });
      if (currentStatus.state === "auth_paused" || currentStatus.state === "offline" || currentStatus.state === "integrity_error") return;
      if (active.abort.signal.aborted) return;
      snapshot = await freshSnapshot({ database: input.database, ownerId: input.ownerId, buildId: input.buildId });
      if (snapshot.metadata.server_epoch === null) return;
      snapshot = await pullUntilCurrent({
        database: input.database,
        ownerId: input.ownerId,
        buildId: input.buildId,
        fencingToken: active.lease.fencing_token,
        signal: active.abort.signal,
        initial: snapshot,
      });
      const remaining = await readActiveOutbox(snapshot);
      const attention = remaining.find((entry) => entry.state === "blocked" || entry.state === "quarantined");
      if (attention) {
        setStatus({
          state: "blocked",
          pending: pendingCount(remaining),
          code: attention.problem_code ?? "operation_blocked",
        });
      } else {
        setStatus(remaining.length === 0
          ? { state: "synced" }
          : { state: "syncing", pending: pendingCount(remaining) });
      }
    } catch (error) {
      if (isAbort(error) || active.abort.signal.aborted) return;
      if (error instanceof EpochRecoveryRequired || (error instanceof SyncHttpError && error.problem?.code === "cursor_epoch_mismatch")) {
        try {
          const current = await freshSnapshot({ database: input.database, ownerId: input.ownerId, buildId: input.buildId });
          if (current.metadata.server_epoch === null) throw new Error("Epoch recovery requires a previously established server epoch");
          const currentEntries = await readActiveOutbox(current);
          setStatus({ state: "syncing", pending: pendingCount(currentEntries) });
          await recoverOwnerEpoch({
            database: input.database,
            ownerId: input.ownerId,
            buildId: input.buildId,
            fencingToken: active.lease.fencing_token,
            signal: active.abort.signal,
          });
          active.wakeRequested = true;
          return;
        } catch (recoveryError) {
          setStatus({ state: "error", pending: 0, message: recoveryError instanceof Error ? recoveryError.message : "Epoch recovery failed" });
          return;
        }
      }
      const code = error instanceof SyncHttpError ? error.problem?.code : undefined;
      if (error instanceof SyncHttpError && (error.status === 401 || error.status === 403)) {
        setStatus({ state: "auth_paused", pending: await readPendingCount(input) });
      } else if (error instanceof SyncHttpError && (error.status === 429 || error.status === 503 || error.status >= 500)) {
        const delay = nextRetryDecision({ attempt: 0, status: error.status, code, retryable: error.problem?.retryable, retryAfterMs: error.retryAfterMs }).delay_ms ?? retryDelay(0);
        const retryAtMs = Date.now() + delay;
        scheduleRetry(active, delay);
        const pending = await readPendingCount(input);
        setStatus({ state: "offline", pending, retry_at_ms: retryAtMs });
      } else {
        setStatus({ state: "error", pending: 0, message: error instanceof Error ? error.message : "Sync failed" });
      }
    } finally {
      active.loopRunning = false;
      for (const resolve of active.pauseDrainWaiters.splice(0)) resolve();
      if (active.resumeAfterDrainEpoch !== null && active.resumeAfterDrainEpoch === active.pauseEpoch && !active.stopped) {
        active.paused = false;
        active.pauseEpoch = null;
        active.resumeAfterDrainEpoch = null;
        active.abort = new AbortController();
        active.wakeRequested = true;
      }
      if (!active.stopped && active.wakeRequested) requestWake();
    }
  };

  const repairClockIssues = async (): Promise<void> => {
    let active = runtime;
    if (!active || active.stopped) throw new Error("Sync coordinator is not leading for this owner");
    if (active.paused) throw new Error("Sync is paused for a build update; finish that update before repairing device time");
    for (let attempt = 0; active.loopRunning && attempt < 40; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      active = runtime;
      if (!active || active.stopped) throw new Error("Sync leadership changed before clock recovery started");
    }
    if (active.loopRunning) throw new Error("Sync is still running; wait briefly and try the clock repair again");
    const session = await input.getSession();
    if (!session || session.owner_id !== input.ownerId) throw new Error("Sign in again before repairing device time");
    active.paused = true;
    try {
      const snapshot = await freshSnapshot({ database: input.database, ownerId: input.ownerId, buildId: input.buildId });
      const entries = await readActiveOutbox(snapshot);
      const clockRoots = entries.filter((entry) => entry.state === "quarantined" &&
        (entry.problem_code === "time_invalid" || entry.problem_code?.startsWith("clock_") === true));
      if (clockRoots.length === 0) throw new Error("No recoverable clock-related operations were found");
      const selectedIds = new Set<UUID>();
      for (const entry of clockRoots) {
        if (entry.ever_recorded || entry.commit_uncertain || entry.receipt ||
            entry.state === "sending" || entry.state === "ack_waiting_pull") {
          throw new Error("An operation has an uncertain server result. Retry its original envelope before reauthoring");
        }
        selectedIds.add(entry.operation.operation_id);
      }
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const entry of entries) {
          if (selectedIds.has(entry.operation.operation_id) ||
              !entry.operation.dependencies.some((dependency) => selectedIds.has(dependency))) continue;
          if (entry.ever_recorded || entry.commit_uncertain || entry.receipt ||
              entry.state === "sending" || entry.state === "ack_waiting_pull") {
            throw new Error("A dependent operation has an uncertain server result. Retry its original envelope before reauthoring");
          }
          selectedIds.add(entry.operation.operation_id);
          expanded = true;
        }
      }
      const sourceOperations = entries
        .filter((entry) => selectedIds.has(entry.operation.operation_id))
        .map((entry) => entry.operation);
      const newDeviceId = crypto.randomUUID();
      const sampledCalibration = await sampleOwnerClock({
        snapshot,
        deviceId: newDeviceId,
        signal: active.abort.signal,
      });
      const clockCalibration = { ...sampledCalibration, calibrated_at_wall_ms: Date.now() };
      const prepared = await prepareClockReauthorBatch({
        snapshot,
        sourceOperations,
        newDeviceId,
        clockCalibration,
      });
      const committed = await commitClockReauthorBatch({
        database: input.database,
        snapshot,
        gate: await freshGate(input.database),
        expectedBuild: input.buildId,
        expectedFencingToken: active.lease.fencing_token,
        newDeviceId: prepared.newDeviceId,
        sourceOperationIds: sourceOperations.map((operation) => operation.operation_id),
        replacements: prepared.replacements,
        clockCalibration,
      });
      if (!committed.result.committed) throw new Error(`Clock recovery lost its owner guard: ${committed.result.reason}`);
      stateChannel?.postMessage({ type: "state_changed" });
    } finally {
      if (active.pauseEpoch === null && !active.stopped) active.paused = false;
      if (!active.stopped && !active.paused) requestWake();
    }
  };

  const stopRuntime = async (lease: LeaderLease | null) => {
    const active = runtime;
    if (!active || (lease && active.lease.fencing_token !== lease.fencing_token)) return;
    active.stopped = true;
    active.abort.abort();
    if (active.retryTimer !== null) window.clearTimeout(active.retryTimer);
    runtime = null;
    setStatus(stopped ? { state: "stopped" } : { state: "waiting_for_leader" });
  };

  const leadership = startOwnerLeadership({
    database: input.database,
    ownerId: input.ownerId,
    buildId: input.buildId,
    lockEpoch: input.lockEpoch,
    onLeader: (lease) => {
      if (stopped) return;
      const active: Runtime = {
        stopped: false,
        lease,
        abort: new AbortController(),
        paused: false,
        pauseEpoch: null,
        loopRunning: false,
        wakeRequested: true,
        retryTimer: null,
        retryAtMs: null,
        pauseDrainWaiters: [],
        resumeAfterDrainEpoch: null,
      };
      runtime = active;
      void run(active);
    },
    onLost: (lease) => void stopRuntime(lease),
  });

  const onOnline = () => requestWake();
  const onVisible = () => { if (document.visibilityState === "visible") requestWake(); };
  const pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") requestWake();
  }, POLL_INTERVAL_MS);
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === "state_changed") requestWake();
    if (event.data?.type === "DAYFORGE_OWNER_LOCKED" && event.data?.ownerId === input.ownerId) {
      void stopRuntime(null);
    }
  };
  const onOwnerStateChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ ownerId?: UUID }>).detail;
    if (detail?.ownerId === input.ownerId) requestWake();
  };
  const onPauseWriters = (event: Event) => {
    const detail = (event as CustomEvent<{
      updateEpoch?: UUID;
      waitUntil?: (promise: Promise<unknown>) => void;
    }>).detail;
    if (!runtime || !detail?.updateEpoch) return;
    const active = runtime;
    active.paused = true;
    active.pauseEpoch = detail.updateEpoch;
    active.abort.abort();
    if (detail.waitUntil) {
      detail.waitUntil(new Promise<void>((resolve) => {
        if (!active.loopRunning) resolve();
        else active.pauseDrainWaiters.push(resolve);
      }));
    }
  };
  const onResumeWriters = (event: Event) => {
    const detail = (event as CustomEvent<{ updateEpoch?: UUID }>).detail;
    if (!runtime || !runtime.paused || detail?.updateEpoch !== runtime.pauseEpoch) return;
    if (runtime.loopRunning) {
      runtime.resumeAfterDrainEpoch = detail.updateEpoch;
      return;
    }
    runtime.paused = false;
    runtime.pauseEpoch = null;
    runtime.resumeAfterDrainEpoch = null;
    runtime.abort = new AbortController();
    runtime.wakeRequested = true;
    requestWake();
  };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("dayforge:pause-writers", onPauseWriters);
  window.addEventListener("dayforge:resume-writers", onResumeWriters);
  window.addEventListener("dayforge:owner-state-changed", onOwnerStateChanged);
  stateChannel?.addEventListener("message", onMessage);

  return {
    wake: requestWake,
    repairClockIssues,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(pollTimer);
      window.removeEventListener("dayforge:pause-writers", onPauseWriters);
      window.removeEventListener("dayforge:resume-writers", onResumeWriters);
      window.removeEventListener("dayforge:owner-state-changed", onOwnerStateChanged);
      stateChannel?.removeEventListener("message", onMessage);
      stateChannel?.close();
      await stopRuntime(null);
      await leadership.close();
      setStatus({ state: "stopped" });
    },
    status: () => currentStatus,
  };
}
