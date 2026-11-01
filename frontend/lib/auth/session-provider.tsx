"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AuthApiError,
  authErrorText,
  getLocalKey,
  getSession,
  importLocalKey,
  postAuth,
  type AcceptedEmailRequest,
  type SessionView,
} from "../services/auth";
import {
  clearActiveOwnerContext,
  getActiveOwnerContext,
  listenForRemoteOwnerLock,
  publishOwnerLocked,
  setActiveOwnerContext,
  subscribeOwnerLock,
} from "./device-auth-state";
import {
  countOwnerChanges,
  listPendingLogoutTickets,
  removePendingLogoutTicket,
  storePendingLogoutTicket,
  type OwnerChangeSummary,
} from "../storage";
import { openDatabase } from "../storage/db";
import { isOwnerUnlocked, lockOwner, unlockOwner, type OwnerAccessContext } from "../storage/owner-gate";

export type EmailRequestAction = "register" | "verification/resend" | "password/forgot";

export type AuthSessionContextValue = Readonly<{
  loading: boolean;
  session: SessionView | null;
  ownerUnlocked: boolean;
  notice: string;
  error: string;
  login(email: string, password: string, rememberMe: boolean): Promise<void>;
  requestEmail(action: EmailRequestAction, email: string): Promise<AcceptedEmailRequest>;
  refreshSession(): Promise<void>;
  inspectPendingChanges(): Promise<OwnerChangeSummary>;
  logout(): Promise<void>;
  clearMessages(): void;
}>;

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

async function openOrThrow(): Promise<IDBDatabase> {
  const result = await openDatabase();
  if (!result.ok) throw result.error;
  return result.value;
}

async function retryQueuedLogouts(
  db: IDBDatabase,
  session: SessionView
): Promise<{ remaining: number; revoked: number }> {
  const tickets = await listPendingLogoutTickets(db);
  if (!tickets.ok) return { remaining: 1, revoked: 0 };
  let revoked = 0;
  let remaining = 0;
  for (const item of tickets.value) {
    try {
      await postAuth<void>("logout", { logout_ticket: item.ticket }, session.csrf_token);
      const removed = await removePendingLogoutTicket(db, item.key);
      if (removed.ok) revoked += 1;
      else remaining += 1;
    } catch {
      remaining += 1;
    }
  }
  return { remaining, revoked };
}

export function AuthSessionProvider({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionView | null>(null);
  const [ownerAccess, setOwnerAccess] = useState<OwnerAccessContext | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const dbRef = useRef<IDBDatabase | null>(null);
  const sessionRef = useRef<SessionView | null>(null);
  const ownerAccessRef = useRef<OwnerAccessContext | null>(null);

  const updateSession = useCallback((value: SessionView | null) => {
    sessionRef.current = value;
    setSession(value);
  }, []);

  const updateOwnerAccess = useCallback((value: OwnerAccessContext | null) => {
    ownerAccessRef.current = value;
    setOwnerAccess(value);
    setActiveOwnerContext(value);
  }, []);

  const ensureDatabase = useCallback(async (): Promise<IDBDatabase> => {
    if (dbRef.current) return dbRef.current;
    const db = await openOrThrow();
    dbRef.current = db;
    return db;
  }, []);

  const refreshSession = useCallback(async (): Promise<void> => {
    const previous = sessionRef.current;
    try {
      let next = await getSession();
      const db = dbRef.current;
      if (db) {
        const retried = await retryQueuedLogouts(db, next);
        if (retried.revoked > 0) next = await getSession();
        if (retried.remaining > 0) {
          setNotice("Có yêu cầu đăng xuất đang chờ kết nối để thu hồi phiên.");
        } else if (retried.revoked > 0) {
          setNotice("Phiên đăng xuất đang chờ đã được thu hồi trên máy chủ.");
        }
      }
      updateSession(next);
      if (previous?.authenticated && !next.authenticated) {
        setNotice("Phiên đã hết hạn. Dữ liệu cục bộ vẫn mở khóa.");
      }
      setError("");
    } catch (caught) {
      setError(authErrorText(caught));
    }
  }, [updateSession]);

  useEffect(() => {
    let active = true;
    const handleLocalLock = (noticeValue: { ownerId: string }) => {
      if (ownerAccessRef.current?.ownerId === noticeValue.ownerId) {
        updateOwnerAccess(null);
      }
    };
    const handleRemoteLock = (noticeValue: { ownerId: string }) => {
      void (async () => {
        let db = dbRef.current;
        if (!db) {
          try {
            db = await ensureDatabase();
          } catch {
            clearActiveOwnerContext(noticeValue.ownerId);
            if (ownerAccessRef.current?.ownerId === noticeValue.ownerId) updateOwnerAccess(null);
            return;
          }
        }
        await lockOwner(db, noticeValue.ownerId);
        clearActiveOwnerContext(noticeValue.ownerId);
        if (ownerAccessRef.current?.ownerId === noticeValue.ownerId) updateOwnerAccess(null);
      })();
    };
    const removeLocalLock = subscribeOwnerLock(handleLocalLock);
    const removeRemoteLock = listenForRemoteOwnerLock(handleRemoteLock);
    const initialize = async () => {
      let db: IDBDatabase | null = null;
      try {
        db = await ensureDatabase();
      } catch {
        // Local storage may be unavailable while the account API still works.
      }
      let initial: SessionView;
      try {
        initial = await getSession();
        if (db) {
          const retried = await retryQueuedLogouts(db, initial);
          if (retried.revoked > 0) initial = await getSession();
          if (retried.remaining > 0) {
            setNotice("Có yêu cầu đăng xuất đang chờ kết nối để thu hồi phiên.");
          }
        }
        if (!active) return;
        updateSession(initial);
        const rememberedContext = getActiveOwnerContext();
        if (db && rememberedContext) {
          const unlocked = await isOwnerUnlocked(db, rememberedContext.ownerId);
          if (unlocked.ok && unlocked.value) updateOwnerAccess(rememberedContext);
          else {
            clearActiveOwnerContext(rememberedContext.ownerId);
            updateOwnerAccess(null);
          }
        }
        setError("");
      } catch (caught) {
        if (!active) return;
        setError(authErrorText(caught));
      } finally {
        if (active) setLoading(false);
      }
    };
    void initialize();
    const onFocus = () => void refreshSession();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshSession();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      removeLocalLock();
      removeRemoteLock();
      if (dbRef.current) {
        dbRef.current.close();
        dbRef.current = null;
      }
    };
  }, [ensureDatabase, refreshSession, updateOwnerAccess, updateSession]);

  const clearMessages = useCallback(() => {
    setNotice("");
    setError("");
  }, []);

  const requestEmail = useCallback(async (
    action: EmailRequestAction,
    email: string
  ): Promise<AcceptedEmailRequest> => {
    setError("");
    const current = sessionRef.current;
    const response = await postAuth<AcceptedEmailRequest>(
      action,
      { email },
      current?.csrf_token
    );
    setNotice("Nếu email phù hợp, hệ thống sẽ gửi hướng dẫn.");
    return response;
  }, []);

  const login = useCallback(async (
    email: string,
    password: string,
    rememberMe: boolean
  ): Promise<void> => {
    setError("");
    setNotice("");
    let current = sessionRef.current ?? await getSession();
    const db = await ensureDatabase();
    const retry = await retryQueuedLogouts(db, current);
    if (retry.remaining > 0) {
      throw new AuthApiError(503, "service_unavailable");
    }
    if (retry.revoked > 0) current = await getSession();
    const authenticated = await postAuth<SessionView>(
      "login",
      { email, password, remember_me: rememberMe },
      current.csrf_token
    );
    updateSession(authenticated);
    if (!authenticated.owner) throw new AuthApiError(503, "service_unavailable");
    const localKey = await getLocalKey();
    if (localKey.owner_id !== authenticated.owner.id) {
      throw new AuthApiError(503, "service_unavailable");
    }
    const imported = await importLocalKey(localKey.key_base64url);
    if (!imported.ok) throw imported.error;
    const unlocked = await unlockOwner(
      db,
      localKey.owner_id,
      localKey.key_id,
      imported.value
    );
    if (!unlocked.ok) throw unlocked.error;
    updateOwnerAccess(unlocked.value);
    setNotice("Dữ liệu cục bộ đã mở khóa.");
  }, [ensureDatabase, updateOwnerAccess, updateSession]);

  const inspectPendingChanges = useCallback(async (): Promise<OwnerChangeSummary> => {
    const current = sessionRef.current;
    if (!current?.owner) return { pendingOperations: 0, drafts: 0 };
    const db = await ensureDatabase();
    const result = await countOwnerChanges(
      db,
      ownerAccessRef.current?.ownerId === current.owner.id ? ownerAccessRef.current : null,
      current.owner.id
    );
    if (!result.ok) throw result.error;
    return result.value;
  }, [ensureDatabase]);

  const logout = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (!current?.authenticated || !current.owner) return;
    setError("");
    const db = await ensureDatabase();
    let ticketStored = false;
    if (current.logout_ticket && current.session) {
      const stored = await storePendingLogoutTicket(
        db,
        current.session.id,
        current.logout_ticket
      );
      ticketStored = stored.ok;
    }
    const locked = await lockOwner(db, current.owner.id);
    if (!locked.ok) throw locked.error;
    clearActiveOwnerContext(current.owner.id);
    updateOwnerAccess(null);
    publishOwnerLocked(current.owner.id);
    try {
      await postAuth<void>(
        "logout",
        current.logout_ticket ? { logout_ticket: current.logout_ticket } : {},
        current.csrf_token
      );
      if (ticketStored && current.session) {
        await removePendingLogoutTicket(db, `logout:${current.session.id}`);
      }
      const fresh = await getSession();
      updateSession(fresh);
      setNotice("Đã đăng xuất và khóa dữ liệu cục bộ.");
    } catch {
      setNotice(ticketStored
        ? "Dữ liệu cục bộ đã khóa; phiên chưa thu hồi trên máy chủ. Yêu cầu đã được lưu để thử lại."
        : "Dữ liệu cục bộ đã khóa; không thể thu hồi phiên và không lưu được yêu cầu thử lại.");
    }
  }, [ensureDatabase, updateOwnerAccess, updateSession]);

  const value = useMemo<AuthSessionContextValue>(() => ({
    loading,
    session,
    ownerUnlocked: ownerAccess !== null,
    notice,
    error,
    login,
    requestEmail,
    refreshSession,
    inspectPendingChanges,
    logout,
    clearMessages,
  }), [loading, session, ownerAccess, notice, error, login, requestEmail, refreshSession, inspectPendingChanges, logout, clearMessages]);

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionContextValue {
  const value = useContext(AuthSessionContext);
  if (!value) throw new Error("useAuthSession must be used inside AuthSessionProvider");
  return value;
}
