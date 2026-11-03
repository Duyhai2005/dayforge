"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  clearLogoutTicket,
  inspectOwnerChanges,
  initializeOwnerMetadata,
  listOwnerMetadata,
  lockOwner,
  openVaultDatabase,
  readBuildGate,
  readOwnerAuthState,
  readOwnerSnapshot,
  unlockOwner,
} from "../../lib/storage/vault";
import { startSyncCoordinator, type CoordinatorStatus, type SyncCoordinatorHandle } from "../../lib/sync/coordinator";
import type { SyncCommand, UUID } from "../../lib/sync/protocol";
import { commitLocalMutation, LocalMutationNoOp, type LocalMutationResult } from "../../lib/sync/mutation";
import { rebuildOwnerProjection } from "../../lib/sync/projection";
import { bucketOrderHash, semanticRootHash, workItemsForDates, type MilestoneData, type Period, type PlanData, type ProjectionState, type RecurrenceRule, type TaskData, type TaskTemplate, type WorkItemCard, type WorkItemTarget } from "../../lib/sync/reducer";
import { useBuildGate } from "../offline/offline-bootstrap";

interface OwnerView {
  id: UUID;
  email: string;
  email_verified_at: string;
}

interface SessionView {
  authenticated: boolean;
  owner: OwnerView | null;
  session: {
    id: UUID;
    remember_me: boolean;
    idle_expires_at: string;
    absolute_expires_at: string;
    password_authenticated_at: string;
  } | null;
  csrf_token: string;
  server_time: string;
  logout_ticket: string | null;
}

interface LocalOwner {
  id: UUID;
  email: string | null;
}

export type AccountState = "loading" | "anonymous" | "locked" | "unlocked" | "offline";

export type TaskUndoAction = {
  operationId: UUID;
  taskId: UUID;
  expectedRootHash: string;
  expectedStates: Array<{ root: { kind: "work_item"; id: UUID }; hash: string }>;
  message: string;
  createdAt: number;
};

type UndoableTaskCommand =
  | { action: "single.replace"; payload: { data: TaskData } }
  | { action: "single.delete"; payload: Record<string, never> }
  | { action: "occurrence.replace"; payload: { source_segment_id: UUID; original_date: string; data: TaskData } }
  | { action: "occurrence.delete"; payload: { source_segment_id: UUID; original_date: string } }
  | { action: "detached.replace"; payload: { task_id: UUID; data: TaskData } }
  | { action: "detached.delete"; payload: { task_id: UUID } }
  | { action: "series.edit_future"; payload: { source_segment_id: UUID; cutoff_original_date: string; rule: RecurrenceRule; template: TaskTemplate } }
  | { action: "series.stop_future"; payload: { source_segment_id: UUID; cutoff_original_date: string } };

type StoredTaskUndoAction = { ownerId: UUID; action: TaskUndoAction };

function taskContentMatches(left: TaskData, right: TaskData): boolean {
  return left.title === right.title && left.date === right.date && left.period === right.period &&
    left.duration_minutes === right.duration_minutes && left.plan_id === right.plan_id &&
    left.standalone_color_id === right.standalone_color_id && left.status === right.status;
}

function taskMoveMessage(previous: TaskData, next: TaskData): string {
  if (previous.date === next.date && previous.period === next.period) return `Đã đổi thứ tự của “${next.title}”.`;
  const period = next.period === "morning" ? "sáng" : next.period === "afternoon" ? "chiều" : "tối";
  const weekday = new Intl.DateTimeFormat("vi-VN", { weekday: "long", timeZone: "UTC" })
    .format(new Date(`${next.date}T00:00:00.000Z`)).toLocaleLowerCase("vi");
  return `Đã chuyển “${next.title}” sang ${period} ${weekday}.`;
}

interface AccountContextValue {
  state: AccountState;
  session: SessionView | null;
  owner: LocalOwner | null;
  syncStatus: CoordinatorStatus;
  error: string | null;
  info: string | null;
  calendarProjection: ProjectionState | null;
  calendarReady: boolean;
  calendarError: string | null;
  taskUndo: TaskUndoAction | null;
  login(email: string, password: string, rememberMe: boolean): Promise<void>;
  register(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  confirmEmail(token: string, password: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  logout(): Promise<void>;
  repairClockIssues(): Promise<void>;
  inspectPendingChanges(): Promise<{ pendingOperations: number; drafts: number }>;
  wakeSync(): boolean;
  stopSync(): Promise<void>;
  coordinatorStatus(): CoordinatorStatus;
  refreshSession(): Promise<SessionView>;
  clearNotice(): void;
  refreshCalendar(): Promise<void>;
  createPlan(id: UUID, data: PlanData): Promise<LocalMutationResult>;
  replacePlan(id: UUID, data: PlanData): Promise<LocalMutationResult>;
  createMilestone(id: UUID, data: MilestoneData): Promise<LocalMutationResult>;
  replaceMilestone(id: UUID, data: MilestoneData, expectedRootHash: string): Promise<LocalMutationResult>;
  deleteMilestone(id: UUID, expectedRootHash: string): Promise<LocalMutationResult>;
  createTask(id: UUID, data: TaskData): Promise<LocalMutationResult>;
  replaceTask(id: UUID, data: TaskData, expectedRootHash: string): Promise<LocalMutationResult>;
  changeTaskStatus(id: UUID, data: TaskData, expectedRootHash: string): Promise<LocalMutationResult>;
  changeWorkItemStatus(id: UUID, target: WorkItemTarget, data: TaskData, expectedRootHash: string): Promise<LocalMutationResult>;
  deleteTask(id: UUID, title: string, expectedRootHash: string): Promise<LocalMutationResult>;
  replaceWorkItemTarget(id: UUID, target: WorkItemTarget, data: TaskData, expectedRootHash: string): Promise<LocalMutationResult>;
  deleteWorkItemTarget(id: UUID, target: WorkItemTarget, title: string, expectedRootHash: string): Promise<LocalMutationResult>;
  editSeriesFuture(id: UUID, sourceSegmentId: UUID, cutoffOriginalDate: string, rule: RecurrenceRule, template: TaskTemplate, expectedRootHash: string): Promise<LocalMutationResult>;
  stopSeriesFuture(id: UUID, sourceSegmentId: UUID, cutoffOriginalDate: string, title: string, expectedRootHash: string): Promise<LocalMutationResult>;
  createRecurringTask(id: UUID, startDate: string, rule: RecurrenceRule, template: TaskTemplate): Promise<LocalMutationResult>;
  enableTaskRecurrence(id: UUID, data: TaskData, rule: RecurrenceRule, expectedRootHash: string): Promise<LocalMutationResult>;
  repositionTask(id: UUID, sourceData: TaskData, destination: TaskData, expectedRootHash: string, beforeTaskId: UUID | null, target: WorkItemTarget): Promise<LocalMutationResult>;
  undoTask(action: TaskUndoAction): Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);
const API_PREFIX = "/api/v1/auth";

export function formatAccountError(value: unknown): string {
  if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
    const messages: Record<string, string> = {
      invalid_credentials: "Email hoặc mật khẩu chưa đúng.",
      password_policy_violation: "Mật khẩu chưa đáp ứng yêu cầu.",
      password_blocklisted: "Hãy chọn mật khẩu khác khó đoán hơn.",
      email_token_invalid: "Liên kết email không hợp lệ.",
      email_token_used: "Liên kết này đã được sử dụng.",
      email_token_expired: "Liên kết đã hết hạn. Hãy yêu cầu gửi liên kết mới.",
      reauthentication_required: "Hãy đăng nhập lại để mở dữ liệu local.",
      csrf_failed: "Phiên biểu mẫu đã cũ. Tải lại trang rồi thử lại.",
      rate_limited: "Bạn đã thử quá nhiều lần. Hãy chờ rồi thử lại.",
      service_unavailable: "Dịch vụ tạm thời chưa sẵn sàng. Dữ liệu local vẫn được giữ.",
    };
    return messages[value.code] ?? "Không thể hoàn tất yêu cầu tài khoản.";
  }
  return value instanceof Error ? value.message : "Không thể kết nối dịch vụ tài khoản.";
}

function isCsrfFailure(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "code" in value && value.code === "csrf_failed");
}

async function request<T>(path: string, input: { method?: "GET" | "POST"; body?: unknown; csrf?: string } = {}): Promise<T> {
  const method = input.method ?? "GET";
  const headers = new Headers({ Accept: "application/json, application/problem+json" });
  if (method === "POST") {
    if (!input.csrf || !/^[A-Za-z0-9_-]{43}$/.test(input.csrf)) throw new Error("Hãy tải lại phiên tài khoản rồi thử lại.");
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", input.csrf);
  }
  const response = await fetch(path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  if (!cacheControl.split(",").some((directive) => directive.trim().toLowerCase() === "no-store")) {
    throw new Error("Phản hồi tài khoản thiếu chính sách no-store.");
  }
  if (response.status === 204) return undefined as T;
  const value = await response.json() as unknown;
  if (!response.ok) throw value;
  return value as T;
}

function importKeyBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Khóa local từ máy chủ có định dạng không hợp lệ.");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
  if (binary.length !== 32) throw new Error("Khóa local không đúng độ dài AES-256.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider is missing");
  return value;
}

export function AccountProvider({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const build = useBuildGate();
  const [database, setDatabase] = useState<IDBDatabase | null>(null);
  const [state, setState] = useState<AccountState>("loading");
  const [session, setSession] = useState<SessionView | null>(null);
  const [owner, setOwner] = useState<LocalOwner | null>(null);
  const [syncStatus, setSyncStatus] = useState<CoordinatorStatus>({ state: "stopped" });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [calendarProjection, setCalendarProjection] = useState<ProjectionState | null>(null);
  const [calendarReady, setCalendarReady] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [storedTaskUndo, setStoredTaskUndo] = useState<StoredTaskUndoAction | null>(null);
  const sessionRef = useRef<SessionView | null>(null);
  const databaseRef = useRef<IDBDatabase | null>(null);
  const coordinatorRef = useRef<SyncCoordinatorHandle | null>(null);
  const calendarRefreshIdRef = useRef(0);

  const setSessionValue = useCallback((next: SessionView | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const refreshSession = useCallback(async (): Promise<SessionView> => {
    const next = await request<SessionView>(`${API_PREFIX}/session`);
    setSessionValue(next);
    return next;
  }, [setSessionValue]);

  const refreshCalendar = useCallback(async (): Promise<void> => {
    const ownerId = owner?.id;
    const db = databaseRef.current;
    const refreshId = ++calendarRefreshIdRef.current;
    if (state !== "unlocked" || !ownerId || !db) {
      setCalendarProjection(null);
      setCalendarReady(state !== "loading");
      setCalendarError(null);
      return;
    }
    setCalendarReady(false);
    try {
      const snapshot = await readOwnerSnapshot(db, ownerId, build.buildId);
      const { replay } = await rebuildOwnerProjection({ snapshot });
      if (refreshId !== calendarRefreshIdRef.current || owner?.id !== ownerId || state !== "unlocked") return;
      setCalendarProjection(replay.state);
      setCalendarReady(true);
      setCalendarError(null);
    } catch (cause) {
      if (refreshId !== calendarRefreshIdRef.current || owner?.id !== ownerId) return;
      setCalendarProjection(null);
      setCalendarReady(false);
      setCalendarError(cause instanceof Error ? cause.message : "Không thể đọc lịch trên thiết bị này.");
    }
  }, [build.buildId, owner, state]);

  useEffect(() => {
    void refreshCalendar();
  }, [refreshCalendar]);

  useEffect(() => {
    const onOwnerStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerId?: UUID }>).detail;
      if (detail?.ownerId === owner?.id) void refreshCalendar();
    };
    window.addEventListener("dayforge:owner-state-changed", onOwnerStateChanged);
    return () => window.removeEventListener("dayforge:owner-state-changed", onOwnerStateChanged);
  }, [owner?.id, refreshCalendar]);

  useEffect(() => {
    if (!build.ready || !build.gate) return;
    let cancelled = false;
    let opened: IDBDatabase | null = null;
    void (async () => {
      try {
        opened = await openVaultDatabase(build.buildId);
        if (cancelled) { opened.close(); return; }
        databaseRef.current = opened;
        setDatabase(opened);
        let current: SessionView | null = null;
        try { current = await refreshSession(); } catch { /* A persisted local vault remains usable without a session response. */ }
        if (cancelled) return;
        const cached = await listOwnerMetadata(opened);
        const serverOwner = current?.authenticated ? current.owner : null;
        const selected = serverOwner ? cached.find((entry) => entry.owner_id === serverOwner.id) : cached.at(-1);
        if (selected) {
          const snapshot = await readOwnerSnapshot(opened, selected.owner_id, build.buildId);
          if (cancelled) return;
          setOwner({ id: selected.owner_id, email: serverOwner?.email ?? null });
          if (!snapshot.auth.locked && snapshot.auth.crypto_key) setState("unlocked");
          else setState(current?.authenticated ? "locked" : "anonymous");
        } else {
          setOwner(serverOwner ? { id: serverOwner.id, email: serverOwner.email } : null);
          setState(current?.authenticated ? "locked" : "anonymous");
        }
      } catch {
        if (!cancelled) setState("offline");
      }
    })();
    return () => {
      cancelled = true;
      opened?.close();
      if (databaseRef.current === opened) databaseRef.current = null;
      setDatabase((current) => current === opened ? null : current);
    };
  }, [build.buildId, build.gate, build.ready, refreshSession]);

  useEffect(() => {
    if (!owner) return;
    const onLock = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerId?: UUID }>).detail;
      if (detail?.ownerId === owner.id) {
        const coordinator = coordinatorRef.current;
        coordinatorRef.current = null;
        if (coordinator) void coordinator.stop();
        setState("locked");
        setSyncStatus({ state: "stopped" });
      }
    };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`dayforge-sync:${owner.id}`);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "DAYFORGE_OWNER_LOCKED" && event.data.ownerId === owner.id) onLock(new CustomEvent("lock", { detail: { ownerId: owner.id } }));
    };
    window.addEventListener("dayforge:owner-locked", onLock);
    channel?.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("dayforge:owner-locked", onLock);
      channel?.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, [owner]);

  useEffect(() => {
    if (state !== "unlocked" || !session?.authenticated || !session.owner || !database || !build.ready) return;
    let cancelled = false;
    let stop: (() => Promise<void>) | null = null;
    void readOwnerSnapshot(database, session.owner.id, build.buildId).then((snapshot) => {
      if (cancelled || snapshot.auth.locked) return;
      const coordinator = startSyncCoordinator({
        database,
        ownerId: session.owner!.id,
        buildId: build.buildId,
        lockEpoch: snapshot.metadata.lock_epoch,
        getSession: async () => {
          const current = sessionRef.current;
          if (!current?.authenticated || current.owner?.id !== session.owner!.id) return null;
          return { owner_id: current.owner.id, csrf_token: current.csrf_token };
        },
        onStatus: (next) => { if (!cancelled) setSyncStatus(next); },
      });
      coordinatorRef.current = coordinator;
      stop = async () => {
        await coordinator.stop();
        if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      };
    }).catch((cause: unknown) => {
      if (!cancelled) setSyncStatus({ state: "error", pending: 0, message: cause instanceof Error ? cause.message : "Không thể mở trạng thái sync." });
    });
    return () => {
      cancelled = true;
      if (stop) void stop();
    };
  }, [build.buildId, build.ready, database, session, state]);

  const csrf = useCallback(async () => {
    const current = sessionRef.current;
    return current?.csrf_token ?? (await refreshSession()).csrf_token;
  }, [refreshSession]);

  const post = useCallback(async <T,>(path: string, body: unknown, csrfToken: string): Promise<T> => {
    try {
      return await request<T>(path, { method: "POST", body, csrf: csrfToken });
    } catch (error) {
      if (!isCsrfFailure(error)) throw error;
      const refreshed = await refreshSession();
      return request<T>(path, { method: "POST", body, csrf: refreshed.csrf_token });
    }
  }, [refreshSession]);

  const register = useCallback(async (email: string) => {
    setError(null); setInfo(null);
    const result = await post<{ status: string; resend_after_seconds: number }>(`${API_PREFIX}/register`, { email }, await csrf());
    setInfo(`Nếu địa chỉ email đủ điều kiện, liên kết xác minh sẽ được gửi. Bạn có thể yêu cầu gửi lại sau ${result.resend_after_seconds} giây.`);
  }, [csrf, post]);

  const requestPasswordReset = useCallback(async (email: string) => {
    setError(null); setInfo(null);
    const result = await post<{ status: string; resend_after_seconds: number }>(`${API_PREFIX}/password/forgot`, { email }, await csrf());
    setInfo(`Nếu tài khoản tồn tại, hướng dẫn đặt lại mật khẩu sẽ được gửi. Có thể yêu cầu lại sau ${result.resend_after_seconds} giây.`);
  }, [csrf, post]);

  const confirmEmail = useCallback(async (token: string, password: string) => {
    setError(null); setInfo(null);
    await post(`${API_PREFIX}/verification/confirm`, { token, password }, await csrf());
    setInfo("Email đã được xác minh. Hãy đăng nhập để mở kho dữ liệu local.");
  }, [csrf, post]);

  const resetPassword = useCallback(async (token: string, password: string) => {
    setError(null); setInfo(null);
    await post(`${API_PREFIX}/password/reset`, { token, password }, await csrf());
    const current = await refreshSession();
    setOwner(current.owner ? { id: current.owner.id, email: current.owner.email } : null);
    setState(current.authenticated ? "locked" : "anonymous");
    setInfo("Mật khẩu đã được cập nhật. Đăng nhập lại để mở kho dữ liệu local.");
  }, [csrf, post, refreshSession]);

  const login = useCallback(async (email: string, password: string, rememberMe: boolean) => {
    setError(null); setInfo(null);
    const db = databaseRef.current;
    if (!db) throw new Error("Kho local chưa sẵn sàng. Hãy chờ một chút rồi thử lại.");
    const csrfToken = await csrf();
    for (const metadata of await listOwnerMetadata(db)) {
      const auth = await readOwnerAuthState(db, metadata.owner_id);
      if (!auth?.logout_ticket) continue;
      await post(`${API_PREFIX}/logout`, { logout_ticket: auth.logout_ticket }, csrfToken);
      await clearLogoutTicket(db, metadata.owner_id, auth.logout_ticket);
    }
    const next = await post<SessionView>(`${API_PREFIX}/login`, { email, password, remember_me: rememberMe }, csrfToken);
    if (!next.authenticated || !next.owner) throw new Error("Máy chủ không trả về phiên đã xác minh.");
    setSessionValue(next);
    const existing = (await listOwnerMetadata(db)).find((entry) => entry.owner_id === next.owner!.id);
    const localKey = await request<{ owner_id: UUID; key_id: UUID; algorithm: "A256GCM"; key_base64url: string }>(`${API_PREFIX}/local-key`);
    if (localKey.owner_id !== next.owner.id || localKey.algorithm !== "A256GCM") throw new Error("Khóa local không thuộc owner vừa đăng nhập.");
    if (databaseRef.current !== db) throw new Error("Kho local đã đóng trong lúc đăng nhập.");
    let expectedLockEpoch: number;
    if (!existing) {
      const initialized = await initializeOwnerMetadata(db, {
        owner_id: next.owner.id,
        device_id: crypto.randomUUID(),
        key_id: localKey.key_id,
        build_id: build.buildId,
      });
      expectedLockEpoch = initialized.lock_epoch;
    } else if (existing.key_id !== localKey.key_id) {
      throw new Error("Kho local đang gắn với một khóa khác. Dữ liệu được giữ nguyên để kiểm tra an toàn.");
    } else {
      expectedLockEpoch = existing.lock_epoch;
    }
    await unlockOwner(db, {
      owner_id: next.owner.id,
      key_id: localKey.key_id,
      rawKey: importKeyBytes(localKey.key_base64url),
      buildId: build.buildId,
      expectedLockEpoch,
    });
    setStoredTaskUndo(null);
    setOwner({ id: next.owner.id, email: next.owner.email });
    setState("unlocked");
    setInfo("Đã mở kho local. Đồng bộ sẽ chạy khi kết nối được máy chủ.");
  }, [build.buildId, csrf, post, setSessionValue]);

  const logout = useCallback(async () => {
    const db = databaseRef.current;
    const current = sessionRef.current;
    const ownerId = current?.owner?.id ?? owner?.id;
    if (!ownerId) { setState("anonymous"); return; }
    setError(null); setInfo(null);
    setStoredTaskUndo(null);
    if (db) await lockOwner(db, ownerId, current?.logout_ticket ?? null);
    setState("locked");
    if (current?.logout_ticket) {
      try {
        await post(`${API_PREFIX}/logout`, { logout_ticket: current.logout_ticket }, current.csrf_token);
        if (db) await clearLogoutTicket(db, ownerId, current.logout_ticket);
        const anonymous = await refreshSession();
        setSessionValue(anonymous);
        setInfo("Đã đăng xuất và khóa kho local trên thiết bị này.");
      } catch {
        setInfo("Kho local đã khóa. Yêu cầu đăng xuất phía máy chủ sẽ được gửi trước lần đăng nhập/đồng bộ kế tiếp.");
      }
    } else {
      setSessionValue(null);
      setInfo("Kho local đã khóa trên thiết bị này.");
    }
  }, [owner, post, refreshSession, setSessionValue]);

  const repairClockIssues = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) throw new Error("Đồng bộ chưa sẵn sàng. Hãy chờ rồi thử lại.");
    await coordinator.repairClockIssues();
    setInfo("Đã lưu lại nhánh chưa ghi nhận bằng giờ thiết bị đã hiệu chỉnh. Đồng bộ đang tiếp tục.");
    setError(null);
  }, []);

  const inspectPendingChanges = useCallback(async () => {
    const ownerId = sessionRef.current?.owner?.id ?? owner?.id;
    const db = databaseRef.current;
    if (!ownerId || !db) return { pendingOperations: 0, drafts: 0 };
    return inspectOwnerChanges(db, ownerId, build.buildId);
  }, [build.buildId, owner]);

  const writePlan = useCallback(async (
    id: UUID,
    action: "plan.create" | "plan.replace",
    data: PlanData,
  ): Promise<LocalMutationResult> => {
    const db = databaseRef.current;
    const ownerId = owner?.id;
    if (!db || !ownerId || state !== "unlocked") throw new Error("Hãy mở khóa kho local trước khi lưu kế hoạch.");
    const operationId = crypto.randomUUID() as UUID;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gate = await readBuildGate(db);
      if (!gate) throw new Error("Trạng thái cập nhật offline chưa sẵn sàng.");
      const snapshot = await readOwnerSnapshot(db, ownerId, build.buildId);
      const result = await commitLocalMutation({
        database: db,
        snapshot,
        gate,
        expectedBuild: build.buildId,
        requireApplied: true,
        draft: {
          operationId,
          commands: [{
            root: { kind: "plan", id },
            action,
            payload: { data },
            precondition: null,
          }],
        },
      });
      if (!result.result.committed) {
        if (result.result.reason === "stale_snapshot") continue;
        throw new Error("Không thể lưu kế hoạch khi kho local hoặc bản cập nhật đang đổi.");
      }
      if (owner?.id !== ownerId || databaseRef.current !== db) throw new Error("Kho local đã khóa trong lúc lưu kế hoạch.");
      setCalendarProjection(result.projection);
      setCalendarReady(true);
      setCalendarError(null);
      setStoredTaskUndo(null);
      coordinatorRef.current?.wake();
      setError(null);
      setInfo("Đã lưu kế hoạch trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
      return result;
    }
    throw new Error("Dữ liệu lịch liên tục thay đổi ở tab khác. Hãy thử lưu lại.");
  }, [build.buildId, owner?.id, state]);

  const createPlan = useCallback((id: UUID, data: PlanData) => writePlan(id, "plan.create", data), [writePlan]);
  const replacePlan = useCallback((id: UUID, data: PlanData) => writePlan(id, "plan.replace", data), [writePlan]);

  const writeMilestone = useCallback(async (
    id: UUID,
    action: "milestone.create" | "milestone.replace" | "milestone.delete",
    data?: MilestoneData,
    expectedRootHash?: string,
  ): Promise<LocalMutationResult> => {
    const db = databaseRef.current;
    const ownerId = owner?.id;
    if (!db || !ownerId || state !== "unlocked") throw new Error("Hãy mở khóa kho local trước khi lưu dấu mốc.");
    if (action !== "milestone.delete" && !data) throw new Error("Dữ liệu dấu mốc chưa đầy đủ.");
    const operationId = crypto.randomUUID() as UUID;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gate = await readBuildGate(db);
      if (!gate) throw new Error("Trạng thái cập nhật offline chưa sẵn sàng.");
      const snapshot = await readOwnerSnapshot(db, ownerId, build.buildId);
      const precondition = action !== "milestone.create" && expectedRootHash
        ? { expected_root_hash: expectedRootHash }
        : null;
      let result: LocalMutationResult;
      try {
        result = await commitLocalMutation({
          database: db,
          snapshot,
          gate,
          expectedBuild: build.buildId,
          requireApplied: true,
          draft: {
            operationId,
            commands: [{
              root: { kind: "milestone", id },
              action,
              payload: action === "milestone.delete" ? {} : { data },
              precondition,
            }],
          },
        });
      } catch (cause) {
        if (cause instanceof LocalMutationNoOp) {
          if (cause.reason === "precondition_failed") throw new Error("Dấu mốc đã thay đổi ở nơi khác. Hãy mở lại rồi thử lại.");
          if (cause.reason === "reference_unavailable") throw new Error("Kế hoạch đã chọn không còn khả dụng. Hãy chọn lại rồi lưu.");
          if (cause.reason === "target_retired") throw new Error("Dấu mốc không còn khả dụng. Hãy tải lại lịch rồi thử tiếp.");
        }
        throw cause;
      }
      if (!result.result.committed) {
        if (result.result.reason === "stale_snapshot") continue;
        throw new Error("Không thể lưu dấu mốc khi kho local hoặc bản cập nhật đang đổi.");
      }
      if (owner?.id !== ownerId || databaseRef.current !== db) throw new Error("Kho local đã khóa trong lúc lưu dấu mốc.");
      setCalendarProjection(result.projection);
      setCalendarReady(true);
      setCalendarError(null);
      setStoredTaskUndo(null);
      coordinatorRef.current?.wake();
      setError(null);
      setInfo(action === "milestone.delete" ? "Đã gỡ dấu mốc khỏi lịch." : "Đã lưu dấu mốc trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
      return result;
    }
    throw new Error("Dữ liệu lịch liên tục thay đổi ở tab khác. Hãy thử lại.");
  }, [build.buildId, owner?.id, state]);

  const createMilestone = useCallback((id: UUID, data: MilestoneData) => writeMilestone(id, "milestone.create", data), [writeMilestone]);
  const replaceMilestone = useCallback(async (id: UUID, data: MilestoneData, expectedRootHash: string) => {
    const current = calendarProjection?.roots[`milestone:${id}`] ?? null;
    const actualRootHash = await semanticRootHash({ kind: "milestone", id }, current);
    if (actualRootHash !== expectedRootHash) {
      throw new Error("Dấu mốc đã thay đổi ở nơi khác. Hãy mở lại rồi thử lại.");
    }
    return writeMilestone(id, "milestone.replace", data, expectedRootHash);
  }, [calendarProjection, writeMilestone]);
  const deleteMilestone = useCallback(async (id: UUID, expectedRootHash: string) => {
    const current = calendarProjection?.roots[`milestone:${id}`] ?? null;
    const actualRootHash = await semanticRootHash({ kind: "milestone", id }, current);
    if (actualRootHash !== expectedRootHash) {
      throw new Error("Dấu mốc đã thay đổi ở nơi khác. Hãy mở lại rồi thử lại.");
    }
    return writeMilestone(id, "milestone.delete", undefined, expectedRootHash);
  }, [calendarProjection, writeMilestone]);

  const writeTask = useCallback(async (
    id: UUID,
    action: "work_item.create_single" | "single.replace" | "work_item.create_recurrence" | "work_item.enable_recurrence",
    payload: { data: TaskData } | { data: TaskData; rule: RecurrenceRule } | { start_date: string; rule: RecurrenceRule; template: TaskTemplate },
    expectedRootHash?: string,
  ): Promise<LocalMutationResult> => {
    const db = databaseRef.current;
    const ownerId = owner?.id;
    if (!db || !ownerId || state !== "unlocked") throw new Error("Hãy mở khóa kho local trước khi lưu công việc.");
    const operationId = crypto.randomUUID() as UUID;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gate = await readBuildGate(db);
      if (!gate) throw new Error("Trạng thái cập nhật offline chưa sẵn sàng.");
      const snapshot = await readOwnerSnapshot(db, ownerId, build.buildId);
      const root = { kind: "work_item" as const, id };
      if (expectedRootHash) {
        const projection = (await rebuildOwnerProjection({ snapshot })).replay.state;
        const actualRootHash = await semanticRootHash(root, projection.roots[`work_item:${id}`] ?? null);
        if (actualRootHash !== expectedRootHash) throw new Error("Công việc đã thay đổi ở nơi khác. Hãy tải lại lịch rồi thử lại.");
      }
      const precondition = action === "single.replace" && expectedRootHash
        ? { expected_root_hash: expectedRootHash }
        : null;
      let result: LocalMutationResult;
      try {
        result = await commitLocalMutation({
          database: db,
          snapshot,
          gate,
          expectedBuild: build.buildId,
          requireApplied: true,
          draft: {
            operationId,
            commands: [{
              root,
              action,
              payload,
              precondition,
            }],
          },
        });
      } catch (cause) {
        if (cause instanceof LocalMutationNoOp) {
          if (cause.reason === "precondition_failed") throw new Error("Công việc đã thay đổi ở nơi khác. Hãy mở lại rồi thử sửa lần nữa.");
          if (cause.reason === "reference_unavailable") throw new Error("Kế hoạch đã chọn không còn khả dụng. Hãy chọn lại rồi lưu.");
          if (cause.reason === "target_retired") throw new Error("Công việc không còn khả dụng. Hãy tải lại lịch rồi thử tiếp.");
        }
        throw cause;
      }
      if (!result.result.committed) {
        if (result.result.reason === "stale_snapshot") continue;
        throw new Error("Không thể lưu công việc khi kho local hoặc bản cập nhật đang đổi.");
      }
      if (owner?.id !== ownerId || databaseRef.current !== db) throw new Error("Kho local đã khóa trong lúc lưu công việc.");
      setCalendarProjection(result.projection);
      setCalendarReady(true);
      setCalendarError(null);
      setStoredTaskUndo(null);
      coordinatorRef.current?.wake();
      setError(null);
      setInfo("Đã lưu công việc trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
      return result;
    }
    throw new Error("Dữ liệu lịch liên tục thay đổi ở tab khác. Hãy thử lưu lại.");
  }, [build.buildId, owner?.id, state]);

  const createTask = useCallback((id: UUID, data: TaskData) => writeTask(id, "work_item.create_single", { data }), [writeTask]);
  const replaceTask = useCallback(async (id: UUID, data: TaskData, expectedRootHash: string) => {
    const current = calendarProjection?.roots[`work_item:${id}`] ?? null;
    const actualRootHash = await semanticRootHash({ kind: "work_item", id }, current);
    if (actualRootHash !== expectedRootHash) {
      throw new Error("Công việc đã thay đổi ở nơi khác. Hãy mở lại rồi thử sửa lần nữa.");
    }
    return writeTask(id, "single.replace", { data }, expectedRootHash);
  }, [calendarProjection, writeTask]);

  const createRecurringTask = useCallback((id: UUID, startDate: string, rule: RecurrenceRule, template: TaskTemplate) =>
    writeTask(id, "work_item.create_recurrence", { start_date: startDate, rule, template }), [writeTask]);

  const enableTaskRecurrence = useCallback(async (id: UUID, data: TaskData, rule: RecurrenceRule, expectedRootHash: string) => {
    const current = calendarProjection?.roots[`work_item:${id}`] ?? null;
    const actualRootHash = await semanticRootHash({ kind: "work_item", id }, current);
    if (actualRootHash !== expectedRootHash) throw new Error("Công việc đã thay đổi ở nơi khác. Hãy mở lại rồi thử lần nữa.");
    return writeTask(id, "work_item.enable_recurrence", { data, rule }, expectedRootHash);
  }, [calendarProjection, writeTask]);

  const mutateUndoableTask = useCallback(async (
    id: UUID,
    expectedRootHash: string,
    command: UndoableTaskCommand,
    message: string,
    notice: string,
  ): Promise<LocalMutationResult> => {
    const db = databaseRef.current;
    const ownerId = owner?.id;
    if (!db || !ownerId || state !== "unlocked") throw new Error("Hãy mở khóa kho local trước khi thay đổi công việc.");
    const operationId = crypto.randomUUID() as UUID;
    const root = { kind: "work_item" as const, id };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gate = await readBuildGate(db);
      if (!gate) throw new Error("Trạng thái cập nhật offline chưa sẵn sàng.");
      const snapshot = await readOwnerSnapshot(db, ownerId, build.buildId);
      const projection = (await rebuildOwnerProjection({ snapshot })).replay.state;
      const current = projection.roots["work_item:" + id];
      const actualRootHash = await semanticRootHash(root, current ?? null);
      if (actualRootHash !== expectedRootHash) {
        throw new Error("Công việc đã thay đổi ở nơi khác. Hãy tải lại lịch rồi thử lại.");
      }
      if (!current || !("kind" in current) || current.deleted) {
        throw new Error("Công việc không còn trong lịch. Hãy tải lại rồi thử tiếp.");
      }
      if ((command.action === "single.replace" || command.action === "single.delete") && current.kind !== "single") {
        throw new Error("Thao tác này chỉ áp dụng cho công việc một lần.");
      }
      if (command.action !== "single.replace" && command.action !== "single.delete" && current.kind !== "recurrence_family") {
        throw new Error("Không tìm thấy chuỗi lặp của công việc này.");
      }
      let result: LocalMutationResult;
      try {
        result = await commitLocalMutation({
          database: db,
          snapshot,
          gate,
          expectedBuild: build.buildId,
          requireApplied: true,
          draft: {
            operationId,
            commands: [{
              root,
              action: command.action,
              payload: command.payload,
              precondition: { expected_root_hash: expectedRootHash },
            }],
          },
        });
      } catch (cause) {
        if (cause instanceof LocalMutationNoOp) {
          if (cause.reason === "precondition_failed") {
            throw new Error("Công việc đã thay đổi ở nơi khác. Hãy tải lại lịch rồi thử lại.");
          }
          if (cause.reason === "target_retired" || cause.reason === "reference_unavailable") {
            throw new Error("Công việc không còn khả dụng. Hãy tải lại lịch rồi thử tiếp.");
          }
        }
        throw cause;
      }
      if (!result.result.committed) {
        if (result.result.reason === "stale_snapshot") continue;
        throw new Error("Không thể thay đổi công việc khi kho local hoặc bản cập nhật đang đổi.");
      }
      if (owner?.id !== ownerId || databaseRef.current !== db) {
        throw new Error("Kho local đã khóa trong lúc thay đổi công việc.");
      }

      const afterHash = await semanticRootHash(root, result.projection.roots["work_item:" + id] ?? null);
      if (afterHash === expectedRootHash) throw new Error("Thay đổi công việc không tạo ra trạng thái mới.");
      setCalendarProjection(result.projection);
      setCalendarReady(true);
      setCalendarError(null);
      setStoredTaskUndo({
        ownerId,
        action: {
          operationId: result.operation.operation_id,
          taskId: id,
          expectedRootHash: afterHash,
          expectedStates: [{ root, hash: afterHash }],
          message,
          createdAt: Date.now(),
        },
      });
      coordinatorRef.current?.wake();
      setError(null);
      setInfo(notice);
      return result;
    }
    throw new Error("Dữ liệu lịch liên tục thay đổi ở tab khác. Hãy thử lại.");
  }, [build.buildId, owner?.id, state]);

  const changeTaskStatus = useCallback((id: UUID, data: TaskData, expectedRootHash: string) => {
    const message = data.status === "completed"
      ? "Đã hoàn thành “" + data.title + "”."
      : "Đã đánh dấu “" + data.title + "” chưa hoàn thành.";
    return mutateUndoableTask(
      id,
      expectedRootHash,
      { action: "single.replace", payload: { data } },
      message,
      "Đã lưu trạng thái công việc trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.",
    );
  }, [mutateUndoableTask]);

  const replaceWorkItemTarget = useCallback((id: UUID, target: WorkItemTarget, data: TaskData, expectedRootHash: string) => {
    const command: UndoableTaskCommand = target.kind === "single"
      ? { action: "single.replace", payload: { data } }
      : target.kind === "occurrence"
        ? { action: "occurrence.replace", payload: { source_segment_id: target.source_segment_id, original_date: target.original_date, data } }
        : { action: "detached.replace", payload: { task_id: target.task_id, data } };
    const message = `Đã cập nhật “${data.title}”.`;
    return mutateUndoableTask(id, expectedRootHash, command, message,
      "Đã lưu thay đổi trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
  }, [mutateUndoableTask]);

  const changeWorkItemStatus = useCallback((id: UUID, target: WorkItemTarget, data: TaskData, expectedRootHash: string) => {
    const command: UndoableTaskCommand = target.kind === "single"
      ? { action: "single.replace", payload: { data } }
      : target.kind === "occurrence"
        ? { action: "occurrence.replace", payload: { source_segment_id: target.source_segment_id, original_date: target.original_date, data } }
        : { action: "detached.replace", payload: { task_id: target.task_id, data } };
    const message = data.status === "completed"
      ? `Đã hoàn thành “${data.title}”.`
      : `Đã đánh dấu “${data.title}” chưa hoàn thành.`;
    return mutateUndoableTask(id, expectedRootHash, command, message,
      "Đã lưu trạng thái công việc trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
  }, [mutateUndoableTask]);

  const deleteTask = useCallback((id: UUID, title: string, expectedRootHash: string) => mutateUndoableTask(
    id,
    expectedRootHash,
    { action: "single.delete", payload: {} },
    "Đã xóa “" + title + "” khỏi lịch.",
    "Đã gỡ công việc khỏi lịch trên thiết bị. Có thể hoàn tác thao tác này.",
  ), [mutateUndoableTask]);

  const deleteWorkItemTarget = useCallback((id: UUID, target: WorkItemTarget, title: string, expectedRootHash: string) => {
    const command: UndoableTaskCommand = target.kind === "single"
      ? { action: "single.delete", payload: {} }
      : target.kind === "occurrence"
        ? { action: "occurrence.delete", payload: { source_segment_id: target.source_segment_id, original_date: target.original_date } }
        : { action: "detached.delete", payload: { task_id: target.task_id } };
    const actionName = target.kind === "occurrence" ? "lần lặp" : target.kind === "detached" ? "việc một lần" : "công việc";
    return mutateUndoableTask(id, expectedRootHash, command,
      `Đã gỡ ${actionName} “${title}” khỏi lịch.`,
      "Đã gỡ công việc khỏi lịch trên thiết bị. Có thể hoàn tác thao tác này.");
  }, [mutateUndoableTask]);

  const editSeriesFuture = useCallback((id: UUID, sourceSegmentId: UUID, cutoffOriginalDate: string, rule: RecurrenceRule, template: TaskTemplate, expectedRootHash: string) =>
    mutateUndoableTask(id, expectedRootHash, {
      action: "series.edit_future",
      payload: { source_segment_id: sourceSegmentId, cutoff_original_date: cutoffOriginalDate, rule, template },
    }, `Đã đổi lịch lặp từ ${cutoffOriginalDate}.`,
    "Đã lưu lịch lặp mới trên thiết bị. Trạng thái đồng bộ được hiển thị riêng."), [mutateUndoableTask]);

  const stopSeriesFuture = useCallback((id: UUID, sourceSegmentId: UUID, cutoffOriginalDate: string, title: string, expectedRootHash: string) =>
    mutateUndoableTask(id, expectedRootHash, {
      action: "series.stop_future",
      payload: { source_segment_id: sourceSegmentId, cutoff_original_date: cutoffOriginalDate },
    }, `Đã dừng “${title}” từ ${cutoffOriginalDate}.`,
    "Đã dừng các lần lặp tương lai trên thiết bị. Lịch sử trước mốc vẫn được giữ."), [mutateUndoableTask]);

  const repositionTask = useCallback(async (
    id: UUID,
    sourceData: TaskData,
    destination: TaskData,
    expectedRootHash: string,
    beforeTaskId: UUID | null,
    target: WorkItemTarget,
  ): Promise<LocalMutationResult> => {
    const db = databaseRef.current;
    const ownerId = owner?.id;
    if (!db || !ownerId || state !== "unlocked") throw new Error("Hãy mở khóa kho local trước khi đổi lịch công việc.");
    const operationId = crypto.randomUUID() as UUID;
    const rootRef = { kind: "work_item" as const, id };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gate = await readBuildGate(db);
      if (!gate) throw new Error("Trạng thái cập nhật offline chưa sẵn sàng.");
      const snapshot = await readOwnerSnapshot(db, ownerId, build.buildId);
      const projection = (await rebuildOwnerProjection({ snapshot })).replay.state;
      const root = projection.roots[`work_item:${id}`];
      const actualRootHash = await semanticRootHash(rootRef, root ?? null);
      if (actualRootHash !== expectedRootHash) throw new Error("Công việc đã thay đổi ở nơi khác. Hãy mở lại rồi thử lần nữa.");
      if (!root || !("kind" in root) || root.deleted) throw new Error("Công việc không còn trong lịch. Hãy tải lại rồi thử tiếp.");
      const visibleCards = await workItemsForDates(projection, [sourceData.date, destination.date]);
      const matchesTarget = (card: WorkItemCard) => card.root_id === id && card.target.kind === target.kind &&
        (target.kind === "single" || (target.kind === "occurrence" && card.target.kind === "occurrence" &&
          target.source_segment_id === card.target.source_segment_id && target.original_date === card.target.original_date) ||
          (target.kind === "detached" && card.target.kind === "detached" && target.task_id === card.target.task_id));
      const sourceCard = visibleCards.find(matchesTarget);
      if (!sourceCard) throw new Error("Công việc đã chuyển khỏi tuần đang xem. Hãy tải lại lịch rồi thử tiếp.");
      const source = sourceCard.data;
      const data = destination;
      const sourceBucket = { date: source.date, period: source.period };
      const destinationBucket = { date: data.date, period: data.period };
      const sameBucket = source.date === data.date && source.period === data.period;
      if (beforeTaskId === sourceCard.id) {
        if (sameBucket) throw new Error("Công việc đã ở đúng vị trí này.");
        throw new Error("Không thể chèn công việc trước chính nó.");
      }
      const peers = visibleCards.filter((entry) => entry.data.date === data.date && entry.data.period === data.period && entry.id !== sourceCard.id);
      const insertionIndex = beforeTaskId === null ? peers.length : peers.findIndex((entry) => entry.id === beforeTaskId);
      if (insertionIndex < 0) throw new Error("Vị trí nhận đã thay đổi. Hãy thử thao tác lại.");
      const orderedIds = peers.map((entry) => entry.id);
      orderedIds.splice(insertionIndex, 0, sourceCard.id);
      const previousIds = sameBucket
        ? visibleCards.filter((entry) => entry.data.date === source.date && entry.data.period === source.period).map((entry) => entry.id)
        : [];
      const contentChanged = !taskContentMatches(source, data);
      const orderChanged = !sameBucket || previousIds.length !== orderedIds.length || previousIds.some((entry, index) => entry !== orderedIds[index]);
      if (!contentChanged && !orderChanged) throw new Error("Công việc đã ở đúng vị trí này.");

      const sourceHash = await bucketOrderHash(projection, sourceBucket.date, sourceBucket.period);
      const destinationHash = sameBucket ? sourceHash : await bucketOrderHash(projection, destinationBucket.date, destinationBucket.period);
      const sourcePrecondition = { date: sourceBucket.date, period: sourceBucket.period, order_hash: sourceHash };
      const destinationPrecondition = { date: destinationBucket.date, period: destinationBucket.period, order_hash: destinationHash };
      const commands: SyncCommand[] = [];
      if (contentChanged) {
        const payload = { data: { ...data, order_key: source.order_key } };
        const replacement = target.kind === "single"
          ? { action: "single.replace", payload }
          : target.kind === "occurrence"
            ? { action: "occurrence.replace", payload: { source_segment_id: target.source_segment_id, original_date: target.original_date, ...payload } }
            : { action: "detached.replace", payload: { task_id: target.task_id, ...payload } };
        commands.push({
          root: rootRef,
          action: replacement.action,
          payload: replacement.payload,
          precondition: { expected_root_hash: expectedRootHash, expected_bucket: destinationPrecondition },
        });
      }
      const int64Min = -(1n << 63n);
      const int64Max = (1n << 63n) - 1n;
      const rankById = new Map(peers.map((entry) => [entry.id, BigInt(entry.data.order_key)]));
      const movedIndex = orderedIds.indexOf(sourceCard.id);
      let movedRank: bigint | null = null;
      if (orderedIds.length === 1) movedRank = 0n;
      else if (movedIndex === 0) {
        const nextRank = rankById.get(orderedIds[1]);
        if (nextRank !== undefined && nextRank > int64Min) movedRank = nextRank - 1n;
      } else if (movedIndex === orderedIds.length - 1) {
        const previousRank = rankById.get(orderedIds[movedIndex - 1]);
        if (previousRank !== undefined && previousRank < int64Max) movedRank = previousRank + 1n;
      } else {
        const previousRank = rankById.get(orderedIds[movedIndex - 1]);
        const nextRank = rankById.get(orderedIds[movedIndex + 1]);
        if (previousRank !== undefined && nextRank !== undefined && nextRank - previousRank > 1n) {
          movedRank = previousRank + (nextRank - previousRank) / 2n;
        }
      }
      const rankAssignments = new Map<UUID, bigint>();
      if (movedRank !== null) rankAssignments.set(sourceCard.id, movedRank);
      else {
        let start = Math.max(0, movedIndex - 1);
        let end = Math.min(orderedIds.length - 1, movedIndex + 1);
        while (true) {
          const lowerRank = start === 0 ? int64Min : rankById.get(orderedIds[start - 1]);
          const upperRank = end === orderedIds.length - 1 ? int64Max : rankById.get(orderedIds[end + 1]);
          if (lowerRank === undefined || upperRank === undefined) throw new Error("Không thể xác định khoảng thứ tự an toàn.");
          const count = BigInt(end - start + 1);
          const available = upperRank - lowerRank;
          if (available > count) {
            const step = available / (count + 1n);
            for (let index = start; index <= end; index += 1) {
              rankAssignments.set(orderedIds[index], lowerRank + step * BigInt(index - start + 1));
            }
            break;
          }
          if (start === 0 && end === orderedIds.length - 1) throw new Error("Không còn khoảng thứ tự an toàn cho công việc này.");
          if (start > 0) start -= 1;
          if (end < orderedIds.length - 1) end += 1;
        }
      }
      for (const [taskId, rank] of rankAssignments) {
        const isMovedTask = taskId === sourceCard.id;
        const peer = isMovedTask ? sourceCard : peers.find((entry) => entry.id === taskId);
        if (!isMovedTask && !peer) throw new Error("Không tìm thấy công việc gần vị trí nhận.");
        const targetRoot = { kind: "work_item" as const, id: peer!.root_id };
        const targetHash = peer!.root_id === id ? expectedRootHash : await semanticRootHash(targetRoot, peer!.root);
        commands.push({
          root: targetRoot,
          action: "set_order",
          payload: { target: peer!.target, order_key: rank.toString(), intent: isMovedTask ? "user_reorder" : "rank_maintenance" },
          precondition: { expected_root_hash: targetHash, expected_bucket: isMovedTask ? sourcePrecondition : destinationPrecondition },
        });
      }

      let result: LocalMutationResult;
      try {
        result = await commitLocalMutation({
          database: db,
          snapshot,
          gate,
          expectedBuild: build.buildId,
          requireApplied: true,
          draft: { operationId, commands },
        });
      } catch (cause) {
        if (cause instanceof LocalMutationNoOp) {
          if (cause.reason === "precondition_failed") throw new Error("Danh sách công việc đã đổi ở tab khác. Hãy thử kéo lại.");
          if (cause.reason === "target_retired") throw new Error("Công việc không còn khả dụng. Hãy tải lại lịch rồi thử tiếp.");
        }
        throw cause;
      }
      if (!result.result.committed) {
        if (result.result.reason === "stale_snapshot") continue;
        throw new Error("Không thể đổi lịch khi kho local hoặc bản cập nhật đang đổi.");
      }
      if (owner?.id !== ownerId || databaseRef.current !== db) throw new Error("Kho local đã khóa trong lúc đổi lịch công việc.");
      setStoredTaskUndo(null);
      setCalendarProjection(result.projection);
      setCalendarReady(true);
      setCalendarError(null);
      const expectedAfterHash = await semanticRootHash(rootRef, result.projection.roots[`work_item:${id}`] ?? null);
      const expectedStates: TaskUndoAction["expectedStates"] = [];
      const seenRoots = new Set<UUID>();
      for (const command of commands) {
        const commandId = command.root.id;
        if (seenRoots.has(commandId)) continue;
        seenRoots.add(commandId);
        const commandRoot = { kind: "work_item" as const, id: commandId };
        const beforeHash = await semanticRootHash(commandRoot, projection.roots[`work_item:${commandId}`] ?? null);
        const afterHash = await semanticRootHash(commandRoot, result.projection.roots[`work_item:${commandId}`] ?? null);
        if (beforeHash !== afterHash) expectedStates.push({ root: commandRoot, hash: afterHash });
      }
      setStoredTaskUndo({ ownerId, action: {
        operationId: result.operation.operation_id,
        taskId: id,
        expectedRootHash: expectedAfterHash,
        expectedStates,
        message: taskMoveMessage(source, data),
        createdAt: Date.now(),
      } });
      coordinatorRef.current?.wake();
      setError(null);
      setInfo("Đã lưu vị trí công việc trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
      return result;
    }
    throw new Error("Dữ liệu lịch liên tục thay đổi ở tab khác. Hãy thử lại.");
  }, [build.buildId, owner?.id, state]);

  const undoTask = useCallback(async (action: TaskUndoAction): Promise<void> => {
    const db = databaseRef.current;
    const ownerId = owner?.id;
    if (!db || !ownerId || state !== "unlocked") throw new Error("Hãy mở khóa kho local trước khi hoàn tác.");
    const root = { kind: "work_item" as const, id: action.taskId };
    const operationId = crypto.randomUUID() as UUID;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const gate = await readBuildGate(db);
      if (!gate) throw new Error("Trạng thái cập nhật offline chưa sẵn sàng.");
      const snapshot = await readOwnerSnapshot(db, ownerId, build.buildId);
      const projection = (await rebuildOwnerProjection({ snapshot })).replay.state;
      const currentHash = await semanticRootHash(root, projection.roots[`work_item:${action.taskId}`] ?? null);
      if (currentHash !== action.expectedRootHash) {
        setStoredTaskUndo((current) => current?.action.operationId === action.operationId ? null : current);
        throw new Error("Công việc đã thay đổi nên thao tác này không còn an toàn để hoàn tác.");
      }
      let result: LocalMutationResult;
      try {
        result = await commitLocalMutation({
          database: db,
          snapshot,
          gate,
          expectedBuild: build.buildId,
          requireApplied: true,
          draft: {
            operationId,
            dependencies: [action.operationId],
            commands: [{
              root,
              action: "undo",
              payload: {
                original_operation_id: action.operationId,
                expected_states: action.expectedStates,
              },
              precondition: null,
            }],
          },
        });
      } catch (cause) {
        if (cause instanceof LocalMutationNoOp && cause.reason === "undo_not_applicable") {
          setStoredTaskUndo((current) => current?.action.operationId === action.operationId ? null : current);
          throw new Error("Công việc đã đổi ở nơi khác nên không thể hoàn tác lần này.");
        }
        throw cause;
      }
      if (!result.result.committed) {
        if (result.result.reason === "stale_snapshot") continue;
        throw new Error("Không thể hoàn tác khi kho local hoặc bản cập nhật đang đổi.");
      }
      if (owner?.id !== ownerId || databaseRef.current !== db) throw new Error("Kho local đã khóa trong lúc hoàn tác.");
      setCalendarProjection(result.projection);
      setCalendarReady(true);
      setCalendarError(null);
      setStoredTaskUndo((current) => current?.action.operationId === action.operationId ? null : current);
      coordinatorRef.current?.wake();
      setError(null);
      setInfo("Đã hoàn tác thay đổi trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
      return;
    }
    throw new Error("Dữ liệu lịch liên tục thay đổi ở tab khác. Hãy thử hoàn tác lại.");
  }, [build.buildId, owner?.id, state]);

  const clearNotice = useCallback(() => { setError(null); setInfo(null); }, []);
  const wakeSync = useCallback(() => {
    if (!coordinatorRef.current) return false;
    coordinatorRef.current.wake();
    return true;
  }, []);
  const stopSync = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    coordinatorRef.current = null;
    await coordinator.stop();
  }, []);
  const coordinatorStatus = useCallback(
    () => coordinatorRef.current?.status() ?? syncStatus,
    [syncStatus],
  );
  const taskUndo = storedTaskUndo && storedTaskUndo.ownerId === owner?.id ? storedTaskUndo.action : null;
  const value = useMemo<AccountContextValue>(() => ({
    state, session, owner, syncStatus, error, info, login, register, requestPasswordReset,
    calendarProjection, calendarReady, calendarError, taskUndo, refreshCalendar, createPlan, replacePlan, createMilestone, replaceMilestone, deleteMilestone, createTask, replaceTask, changeTaskStatus, changeWorkItemStatus, deleteTask, replaceWorkItemTarget, deleteWorkItemTarget, editSeriesFuture, stopSeriesFuture, createRecurringTask, enableTaskRecurrence, repositionTask, undoTask,
    confirmEmail, resetPassword, logout, repairClockIssues, inspectPendingChanges, wakeSync, stopSync, coordinatorStatus, refreshSession, clearNotice,
  }), [calendarError, calendarProjection, calendarReady, changeTaskStatus, changeWorkItemStatus, clearNotice, confirmEmail, coordinatorStatus, createMilestone, createPlan, createTask, createRecurringTask, deleteMilestone, deleteTask, deleteWorkItemTarget, editSeriesFuture, enableTaskRecurrence, error, info, inspectPendingChanges, login, logout, owner, refreshCalendar, refreshSession, register, repairClockIssues, replaceMilestone, replacePlan, replaceTask, replaceWorkItemTarget, repositionTask, requestPasswordReset, resetPassword, session, state, stopSeriesFuture, stopSync, syncStatus, taskUndo, undoTask, wakeSync]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
