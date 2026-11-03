"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { useAccount } from "../account/account-provider";
import { MAX_CALENDAR_DATE, MIN_CALENDAR_DATE, moveAnchor, parseViewState, todayInUtc7, type CalendarKind, type MilestoneScale, type ViewState } from "../../lib/calendar/view-state";
import type { Period } from "../../lib/sync/reducer";

export type CalendarWidgetProps = {
  calendar: CalendarKind;
  view: ViewState;
  onNavigate(next: ViewState): void;
  onSwitch(nextCalendar: CalendarKind): void;
  onOpenPlans(): void;
  onAddTask(date: string, period: Period | null): void;
  onAddMilestone(date: string): void;
};

export function currentPeriod(view: ViewState): string {
  const date = new Date(`${view.anchor}T00:00:00.000Z`);
  if (view.scale === "year") return `Năm ${date.getUTCFullYear()}`;
  if (view.scale === "month") return `Tháng ${date.getUTCMonth() + 1} · ${date.getUTCFullYear()}`;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const format = (value: Date) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(value);
  return `${format(start)} – ${format(end)}`;
}

export function CalendarWidget({ calendar, view, onNavigate, onSwitch, onOpenPlans, onAddTask, onAddMilestone }: CalendarWidgetProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [logoutChanges, setLogoutChanges] = useState<{ pendingOperations: number; drafts: number } | null>(null);
  const [logoutError, setLogoutError] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState("");
  const [undoToastVisible, setUndoToastVisible] = useState(false);
  const undoToastTimer = useRef<number | null>(null);
  const undoToastStarted = useRef(0);
  const undoToastRemaining = useRef(0);
  const undoToastHovered = useRef(false);
  const undoToastFocused = useRef(false);
  const account = useAccount();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const explanationId = useId();
  const previousView = moveAnchor(view, -1);
  const nextView = moveAnchor(view, 1);
  const close = () => {
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (undoToastTimer.current !== null) window.clearTimeout(undoToastTimer.current);
    undoToastTimer.current = null;
    undoToastHovered.current = false;
    undoToastFocused.current = false;
    if (!account.taskUndo) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Undo toast follows the latest in-memory task action.
      setUndoToastVisible(false);
      return;
    }
    const remaining = Math.max(0, account.taskUndo.createdAt + 8000 - Date.now());
    if (remaining === 0) {
      setUndoToastVisible(false);
      return;
    }
    undoToastRemaining.current = remaining;
    undoToastStarted.current = Date.now();
    setUndoToastVisible(true);
    undoToastTimer.current = window.setTimeout(() => {
      undoToastTimer.current = null;
      setUndoToastVisible(false);
    }, remaining);
    return () => {
      if (undoToastTimer.current !== null) window.clearTimeout(undoToastTimer.current);
      undoToastTimer.current = null;
    };
  }, [account.taskUndo]);

  const pauseUndoToast = () => {
    if (undoToastTimer.current === null) return;
    window.clearTimeout(undoToastTimer.current);
    undoToastTimer.current = null;
    undoToastRemaining.current = Math.max(0, undoToastRemaining.current - (Date.now() - undoToastStarted.current));
  };

  const resumeUndoToast = () => {
    if (!account.taskUndo || !undoToastVisible || undoToastHovered.current || undoToastFocused.current || undoToastTimer.current !== null || undoToastRemaining.current <= 0) return;
    undoToastStarted.current = Date.now();
    undoToastTimer.current = window.setTimeout(() => {
      undoToastTimer.current = null;
      setUndoToastVisible(false);
    }, undoToastRemaining.current);
  };

  const performUndo = async () => {
    if (!account.taskUndo || undoBusy) return;
    setUndoError("");
    setUndoBusy(true);
    try {
      await account.undoTask(account.taskUndo);
    } catch (cause) {
      setUndoError(cause instanceof Error ? cause.message : "Không thể hoàn tác lần này.");
    } finally {
      setUndoBusy(false);
    }
  };

  const requestLogout = async () => {
    setLogoutError("");
    try {
      const changes = await account.inspectPendingChanges();
      if (changes.pendingOperations > 0 || changes.drafts > 0) {
        setLogoutChanges(changes);
        return;
      }
      await finishLogout();
    } catch {
      setLogoutError("Không thể kiểm tra thay đổi cục bộ. Hãy thử lại.");
    }
  };

  const finishLogout = async () => {
    setLogoutBusy(true);
    setLogoutError("");
    try {
      await account.logout();
      setLogoutChanges(null);
    } catch {
      setLogoutError("Không thể khóa dữ liệu cục bộ. Hãy thử lại trước khi đăng xuất.");
    } finally {
      setLogoutBusy(false);
    }
  };

  const logoutDialog = logoutChanges && typeof document !== "undefined"
    ? createPortal(
      <div className="logout-backdrop">
        <section className="logout-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-title" aria-describedby="logout-description">
          <h2 id="logout-title">Đăng xuất và khóa dữ liệu?</h2>
          <p id="logout-description">
            {logoutChanges.pendingOperations > 0 && `${logoutChanges.pendingOperations} thay đổi đang chờ đồng bộ`}
            {logoutChanges.pendingOperations > 0 && logoutChanges.drafts > 0 && " và "}
            {logoutChanges.drafts > 0 && `${logoutChanges.drafts} bản nháp chưa lưu`}. Dữ liệu sẽ được giữ trên thiết bị nhưng bị khóa cho đến lần đăng nhập tiếp theo.
          </p>
          <div className="logout-dialog-actions">
            <button type="button" autoFocus disabled={logoutBusy} onClick={() => setLogoutChanges(null)}>Hủy</button>
            <button type="button" disabled={logoutBusy} onClick={() => void finishLogout()}>{logoutBusy ? "Đang khóa…" : "Vẫn đăng xuất"}</button>
          </div>
        </section>
      </div>,
      document.body
    )
    : null;

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        toggle.current?.focus({ preventScroll: true });
      }
    };
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".plan-manager-backdrop, .task-editor-backdrop, .milestone-editor-backdrop")) return;
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
        toggle.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("click", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("click", outside);
    };
  }, [open]);

  return (
    <div className="calendar-widget" ref={root}>
      <section id={panelId} className="widget-panel" data-open={open} aria-label="Điều khiển lịch" aria-hidden={!open} inert={!open}>
        <div className="widget-add-actions">
          <button type="button" disabled={account.state !== "unlocked"} aria-describedby={explanationId} onClick={() => {
            setOpen(false);
            onAddTask(view.anchor, null);
          }}>Thêm công việc</button>
          <button type="button" disabled={account.state !== "unlocked" || !account.calendarReady} aria-describedby={explanationId} onClick={() => {
            setOpen(false);
            onAddMilestone(view.anchor);
          }}>Thêm dấu mốc</button>
          <button type="button" disabled={account.state !== "unlocked"} aria-describedby={explanationId} onClick={() => {
            setOpen(false);
            onOpenPlans();
          }}>Quản lý kế hoạch</button>
        </div>
        {account.taskUndo && <section className="widget-task-undo" aria-label="Hoàn tác thao tác công việc gần nhất">
          <p>{account.taskUndo.message}</p>
          <button type="button" disabled={undoBusy || account.state !== "unlocked"} aria-label="Hoàn tác thao tác công việc gần nhất" onClick={() => void performUndo()}>{undoBusy ? "Đang hoàn tác…" : "Hoàn tác"}</button>
          {undoError && <p className="account-error" role="alert">{undoError}</p>}
        </section>}
        <nav aria-label="Chuyển lịch" className="widget-calendars">
          {(["work", "milestones"] as const).map(kind => <Link key={kind} href={`/${kind}`} aria-current={calendar === kind ? "page" : undefined} scroll={false} onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (calendar === kind) { close(); return; }
            setOpen(false);
            onSwitch(kind);
          }}>{kind === "work" ? "Lịch công việc" : "Lịch dấu mốc"}</Link>)}
        </nav>
        {calendar === "milestones" && <label className="widget-field">Quy mô<select value={view.scale} onChange={event => onNavigate({ ...view, scale: event.target.value as MilestoneScale })}>
          <option value="week">Tuần</option><option value="month">Tháng</option><option value="year">Năm</option>
        </select></label>}
        <div className="widget-range-actions">
          <button type="button" disabled={previousView.anchor === view.anchor} onClick={() => onNavigate(previousView)}>Lùi</button>
          <button type="button" onClick={() => onNavigate({ ...view, anchor: todayInUtc7(new Date()) })}>Hôm nay</button>
          <button type="button" disabled={nextView.anchor === view.anchor} onClick={() => onNavigate(nextView)}>Tiến</button>
        </div>
        <p className="widget-period" aria-label="Khoảng đang xem">{currentPeriod(view)}</p>
        <label className="widget-field">Ngày đang xem<input type="date" min={MIN_CALENDAR_DATE} max={MAX_CALENDAR_DATE} value={view.anchor} onChange={event => {
          if (!event.target.value) return;
          onNavigate(parseViewState(`/${calendar}`, new URLSearchParams({ date: event.target.value, scale: view.scale }), new Date(), null));
        }} /></label>
        <div className="widget-account"><span>Dữ liệu · UTC+07:00</span><Link href="/account">Tài khoản</Link></div>
      </section>
      {undoToastVisible && account.taskUndo && <div className="calendar-undo-toast" role="status" onMouseEnter={() => { undoToastHovered.current = true; pauseUndoToast(); }} onMouseLeave={() => { undoToastHovered.current = false; resumeUndoToast(); }}
        onFocusCapture={() => { undoToastFocused.current = true; pauseUndoToast(); }} onBlurCapture={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          undoToastFocused.current = false;
          resumeUndoToast();
        }}>
        <span>{account.taskUndo.message}</span>
        <button type="button" disabled={undoBusy || account.state !== "unlocked"} onClick={() => void performUndo()}>{undoBusy ? "Đang hoàn tác…" : "Hoàn tác"}</button>
      </div>}
      {undoError && <p className="widget-undo-error" role="alert">{undoError}</p>}
      <div className="widget-bar">
        <button className="widget-quick-add" type="button" disabled={account.state !== "unlocked"} aria-describedby={explanationId} aria-label="Thêm nhanh" onClick={() => onAddTask(view.anchor, null)}>+</button>
        <div className="widget-summary"><strong>{calendar === "work" ? "Lịch công việc" : "Lịch dấu mốc"}</strong><span role="status">{account.error || account.info || (account.state === "unlocked" ? "Dữ liệu cục bộ đã mở khóa." : "Chưa kết nối dữ liệu")}</span></div>
        {(account.session?.authenticated && account.session.owner) || account.state === "unlocked" ? <div className="widget-auth-control">
          {account.session?.authenticated && account.session.owner && <span className="widget-auth-email">{account.session.owner.email}</span>}
          <button type="button" onClick={() => void requestLogout()}>{account.session?.authenticated ? "Đăng xuất" : "Khóa dữ liệu"}</button>
        </div> : null}
        <button ref={toggle} className="widget-toggle" type="button" aria-label="Mở hoặc đóng điều hướng lịch" aria-expanded={open} aria-controls={panelId} onClick={() => { if (open) close(); else setOpen(true); }}><span aria-hidden="true">{open ? "⌄" : "⌃"}</span></button>
      </div>
      <p id={explanationId} className="widget-save-explanation">{account.state === "unlocked"
        ? "Công việc, dấu mốc và kế hoạch được lưu trên thiết bị."
        : "Mở khóa kho local để thêm công việc, dấu mốc hoặc quản lý kế hoạch."}</p>
      {logoutError && <p className="account-error" role="alert">{logoutError}</p>}
      {logoutDialog}
    </div>
  );
}
