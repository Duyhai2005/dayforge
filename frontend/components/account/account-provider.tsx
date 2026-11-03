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
import type { UUID } from "../../lib/sync/protocol";
import { commitLocalMutation, type LocalMutationResult } from "../../lib/sync/mutation";
import { rebuildOwnerProjection } from "../../lib/sync/projection";
import type { PlanData, ProjectionState } from "../../lib/sync/reducer";
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
      coordinatorRef.current?.wake();
      setError(null);
      setInfo("Đã lưu kế hoạch trên thiết bị. Trạng thái đồng bộ được hiển thị riêng.");
      return result;
    }
    throw new Error("Dữ liệu lịch liên tục thay đổi ở tab khác. Hãy thử lưu lại.");
  }, [build.buildId, owner?.id, state]);

  const createPlan = useCallback((id: UUID, data: PlanData) => writePlan(id, "plan.create", data), [writePlan]);
  const replacePlan = useCallback((id: UUID, data: PlanData) => writePlan(id, "plan.replace", data), [writePlan]);

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
  const value = useMemo<AccountContextValue>(() => ({
    state, session, owner, syncStatus, error, info, login, register, requestPasswordReset,
    calendarProjection, calendarReady, calendarError, refreshCalendar, createPlan, replacePlan,
    confirmEmail, resetPassword, logout, repairClockIssues, inspectPendingChanges, wakeSync, stopSync, coordinatorStatus, refreshSession, clearNotice,
  }), [calendarError, calendarProjection, calendarReady, clearNotice, confirmEmail, coordinatorStatus, createPlan, error, info, inspectPendingChanges, login, logout, owner, refreshCalendar, refreshSession, register, repairClockIssues, replacePlan, requestPasswordReset, resetPassword, session, state, stopSync, syncStatus, wakeSync]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
