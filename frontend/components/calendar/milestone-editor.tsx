"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { semanticRootHash, type ColorId, type MilestoneData, type Period, type PlanRoot } from "../../lib/sync/reducer";
import type { UUID } from "../../lib/sync/protocol";
import { useAccount } from "../account/account-provider";
import { CALENDAR_COLORS, PlanManager } from "./plan-manager";

type MilestoneFields = {
  title: string;
  date: string;
  period: Period | "";
  note: string;
  planId: string;
  standaloneColor: ColorId;
  showInWorkCalendar: boolean;
};
type ValidationField = "title" | "date" | "note" | "plan";
type ValidationError = { field: ValidationField; message: string };

export type MilestoneEditorTarget = {
  id: UUID;
  data: MilestoneData;
  expectedRootHash: string;
};

export type MilestoneEditorProps = {
  open: boolean;
  date: string;
  editing?: MilestoneEditorTarget | null;
  onClose(): void;
};

function fieldsForMilestone(data: MilestoneData): MilestoneFields {
  return {
    title: data.title,
    date: data.date,
    period: data.period ?? "",
    note: data.note,
    planId: data.plan_id ?? "",
    standaloneColor: data.standalone_color_id,
    showInWorkCalendar: data.show_in_work_calendar,
  };
}

function newMilestoneFields(date: string): MilestoneFields {
  return { title: "", date, period: "", note: "", planId: "", standaloneColor: "neutral", showInWorkCalendar: true };
}

function sameFields(left: MilestoneFields, right: MilestoneFields): boolean {
  return left.title === right.title && left.date === right.date && left.period === right.period && left.note === right.note &&
    left.planId === right.planId && left.standaloneColor === right.standaloneColor && left.showInWorkCalendar === right.showInWorkCalendar;
}

function dateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01" || value > "9999-12-31") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function planEntries(state: ReturnType<typeof useAccount>["calendarProjection"]): Array<{ id: UUID; root: PlanRoot }> {
  const roots = state?.roots ?? {};
  return Object.entries(roots)
    .filter((entry): entry is [string, PlanRoot] => entry[0].startsWith("plan:") && "data" in entry[1] &&
      "color_id" in entry[1].data && !entry[1].deleted)
    .map(([key, root]) => ({ id: key.slice("plan:".length) as UUID, root }))
    .sort((left, right) => left.root.data.name.localeCompare(right.root.data.name, "vi") || left.id.localeCompare(right.id));
}

export function MilestoneEditor({ open, date, editing = null, onClose }: MilestoneEditorProps): React.JSX.Element | null {
  const account = useAccount();
  const firstFields = editing ? fieldsForMilestone(editing.data) : newMilestoneFields(date);
  const [fields, setFields] = useState<MilestoneFields>(firstFields);
  const [initial] = useState<MilestoneFields>(firstFields);
  const [validationError, setValidationError] = useState<ValidationError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logoutChanges, setLogoutChanges] = useState<{ pendingOperations: number; drafts: number } | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [planManagerOpen, setPlanManagerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const confirmReturnFocus = useRef<HTMLElement | null>(null);
  const dirty = !sameFields(fields, initial);
  const plans = useMemo(() => planEntries(account.calendarProjection), [account.calendarProjection]);
  const selectedPlan = plans.find((entry) => entry.id === fields.planId);
  const effectiveColorId = selectedPlan?.root.data.color_id ?? fields.standaloneColor;
  const effectiveColor = CALENDAR_COLORS.find((color) => color.id === effectiveColorId) ?? CALENDAR_COLORS[0];

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => titleInput.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const main = document.getElementById("calendar-main");
    const widget = document.querySelector<HTMLElement>(".calendar-widget");
    const priorMainInert = main?.inert ?? false;
    const priorWidgetInert = widget?.inert ?? false;
    if (main) main.inert = true;
    if (widget) widget.inert = true;
    return () => {
      if (main) main.inert = priorMainInert;
      if (widget) widget.inert = priorWidgetInert;
      const target = returnFocus.current;
      const hiddenPanel = target?.closest<HTMLElement>(".widget-panel");
      const widgetFallback = hiddenPanel?.inert ? document.querySelector<HTMLElement>(".widget-toggle") : null;
      const date = target?.dataset.workDate;
      const dateFallback = date
        ? document.querySelector<HTMLElement>(`.work-week-all-day-bucket[data-work-date="${date}"] .work-milestone-add`)
        : null;
      (widgetFallback ?? (target?.isConnected ? target : null) ?? dateFallback ?? document.getElementById("calendar-main"))?.focus({ preventScroll: true });
    };
  }, [open]);

  const captureConfirmTrigger = useCallback(() => {
    confirmReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const restoreConfirmTrigger = useCallback(() => {
    requestAnimationFrame(() => {
      const target = confirmReturnFocus.current;
      const canRestore = target?.isConnected && !target.closest("[inert]") && target.getClientRects().length > 0;
      (canRestore ? target : titleInput.current)?.focus({ preventScroll: true });
    });
  }, []);

  const openDiscardConfirmation = useCallback(() => {
    captureConfirmTrigger();
    setConfirmDiscard(true);
  }, [captureConfirmTrigger]);

  const closeDiscardConfirmation = useCallback(() => {
    setConfirmDiscard(false);
    restoreConfirmTrigger();
  }, [restoreConfirmTrigger]);

  const closeDeleteConfirmation = useCallback(() => {
    setConfirmDelete(false);
    restoreConfirmTrigger();
  }, [restoreConfirmTrigger]);

  const closeLogoutConfirmation = useCallback(() => {
    setLogoutChanges(null);
    setLogoutError(null);
    restoreConfirmTrigger();
  }, [restoreConfirmTrigger]);

  const requestClose = useCallback(() => {
    if (busy || planManagerOpen || confirmDelete || logoutChanges) return;
    if (dirty) {
      openDiscardConfirmation();
      return;
    }
    setConfirmDiscard(false);
    onClose();
  }, [busy, confirmDelete, dirty, logoutChanges, onClose, openDiscardConfirmation, planManagerOpen]);

  async function requestLogout(): Promise<void> {
    if (logoutBusy) return;
    captureConfirmTrigger();
    setLogoutError(null);
    try {
      setLogoutChanges(await account.inspectPendingChanges());
    } catch {
      setLogoutError("Không thể kiểm tra thay đổi cục bộ. Hãy thử lại.");
    }
  }

  async function discardAndLogout(): Promise<void> {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError(null);
    try {
      await account.logout();
      setLogoutChanges(null);
      onClose();
    } catch {
      setLogoutError("Không thể khóa dữ liệu cục bộ. Hãy thử lại trước khi đăng xuất.");
    } finally {
      setLogoutBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const trap = (event: KeyboardEvent) => {
      if (planManagerOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (logoutChanges) closeLogoutConfirmation();
        else if (confirmDelete) closeDeleteConfirmation();
        else if (confirmDiscard) closeDiscardConfirmation();
        else requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const activeDialog = logoutChanges
        ? dialog.current.querySelector<HTMLElement>(".milestone-logout-dialog")
        : confirmDiscard || confirmDelete
        ? dialog.current.querySelector<HTMLElement>(confirmDelete ? ".milestone-delete-dialog" : ".task-discard-dialog")
        : dialog.current;
      if (!activeDialog) return;
      const focusable = [...activeDialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => document.removeEventListener("keydown", trap, true);
  }, [closeDeleteConfirmation, closeDiscardConfirmation, closeLogoutConfirmation, confirmDelete, confirmDiscard, logoutChanges, open, planManagerOpen, requestClose]);

  if (!open || typeof document === "undefined") return null;

  async function saveMilestone(): Promise<void> {
    const title = fields.title.normalize("NFC").trim();
    if (Array.from(title).length < 1 || Array.from(title).length > 120 || /[\u0000-\u001f\u007f]/.test(title)) {
      setValidationError({ field: "title", message: "Tên dấu mốc cần có từ 1 đến 120 ký tự trên một dòng." });
      return;
    }
    if (!dateIsValid(fields.date)) {
      setValidationError({ field: "date", message: "Ngày dấu mốc không hợp lệ." });
      return;
    }
    const note = fields.note.normalize("NFC").replace(/\r\n?/g, "\n");
    if (Array.from(note).length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
      setValidationError({ field: "note", message: "Ghi chú tối đa 4.000 ký tự; không dùng ký tự điều khiển." });
      return;
    }
    if (!account.calendarReady || !account.calendarProjection) {
      setSaveError("Dữ liệu lịch chưa sẵn sàng. Hãy chờ rồi thử lưu lại.");
      return;
    }
    if (fields.planId && !selectedPlan) {
      setValidationError({ field: "plan", message: "Kế hoạch đã chọn không còn khả dụng. Hãy chọn lại." });
      return;
    }

    setBusy(true);
    setSaveError(null);
    setValidationError(null);
    try {
      const data: MilestoneData = {
        title,
        date: fields.date,
        period: fields.period || null,
        note,
        plan_id: (fields.planId || null) as UUID | null,
        standalone_color_id: fields.standaloneColor,
        show_in_work_calendar: fields.showInWorkCalendar,
      };
      if (editing) await account.replaceMilestone(editing.id, data, editing.expectedRootHash);
      else await account.createMilestone(crypto.randomUUID() as UUID, data);
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Không thể lưu dấu mốc trên thiết bị.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMilestone(): Promise<void> {
    if (!editing || !account.calendarReady) return;
    setBusy(true);
    setSaveError(null);
    try {
      const actualRootHash = await semanticRootHash({ kind: "milestone", id: editing.id },
        account.calendarProjection?.roots[`milestone:${editing.id}`] ?? null);
      if (actualRootHash !== editing.expectedRootHash) throw new Error("Dấu mốc đã thay đổi ở nơi khác. Hãy mở lại rồi thử lại.");
      await account.deleteMilestone(editing.id, editing.expectedRootHash);
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Không thể gỡ dấu mốc khỏi lịch.");
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (field: ValidationField, id: string) => validationError?.field === field
    ? <p id={id} className="account-error" role="alert">{validationError.message}</p>
    : null;

  return <>
    {createPortal(
      <div className="milestone-editor-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !planManagerOpen) requestClose();
      }}>
        <section ref={dialog} className="milestone-editor" role="dialog" aria-modal={!planManagerOpen && !confirmDiscard && !confirmDelete && !logoutChanges} aria-hidden={planManagerOpen}
          inert={planManagerOpen} aria-labelledby="milestone-editor-title" data-dayforge-dirty={dirty ? "true" : "false"}>
          <header className="plan-manager-header">
            <div>
              <p className="calendar-kicker">DAYFORGE · DẤU MỐC</p>
              <h2 id="milestone-editor-title">{editing ? "Sửa dấu mốc" : "Thêm dấu mốc"}</h2>
            </div>
            <button type="button" className="plan-manager-close" aria-label="Đóng dấu mốc" disabled={busy} onClick={requestClose}>×</button>
          </header>
          <form className="task-form milestone-form" noValidate onSubmit={(event) => { event.preventDefault(); void saveMilestone(); }}>
            <label className="account-field" htmlFor="milestone-title">Tên dấu mốc
              <input ref={titleInput} id="milestone-title" name="title" autoComplete="off" maxLength={120}
                aria-invalid={validationError?.field === "title" || undefined} aria-describedby={validationError?.field === "title" ? "milestone-title-error" : undefined}
                data-dayforge-dirty={dirty ? "true" : "false"} value={fields.title} onChange={(event) => {
                  setFields((current) => ({ ...current, title: event.target.value })); setValidationError(null); setSaveError(null);
                }} />
            </label>
            {fieldError("title", "milestone-title-error")}
            <div className="task-date-period">
              <label className="account-field" htmlFor="milestone-date">Ngày
                <input id="milestone-date" name="date" type="date" min="0001-01-01" max="9999-12-31" required
                  aria-invalid={validationError?.field === "date" || undefined} aria-describedby={validationError?.field === "date" ? "milestone-date-error" : undefined}
                  data-dayforge-dirty={dirty ? "true" : "false"} value={fields.date} onChange={(event) => {
                    setFields((current) => ({ ...current, date: event.target.value })); setValidationError(null);
                  }} />
              </label>
              <label className="account-field" htmlFor="milestone-period">Buổi
                <select id="milestone-period" name="period" data-dayforge-dirty={dirty ? "true" : "false"} value={fields.period} onChange={(event) => {
                  setFields((current) => ({ ...current, period: event.target.value as Period | "" }));
                }}>
                  <option value="">Cả ngày</option>
                  <option value="morning">Sáng</option>
                  <option value="afternoon">Chiều</option>
                  <option value="evening">Tối</option>
                </select>
              </label>
            </div>
            {fieldError("date", "milestone-date-error")}
            <label className="account-field" htmlFor="milestone-note">Ghi chú liên quan (không bắt buộc)
              <textarea id="milestone-note" name="note" rows={5} maxLength={4000} aria-invalid={validationError?.field === "note" || undefined}
                aria-describedby={validationError?.field === "note" ? "milestone-note-error" : undefined} data-dayforge-dirty={dirty ? "true" : "false"}
                value={fields.note} onChange={(event) => {
                  setFields((current) => ({ ...current, note: event.target.value })); setValidationError(null); setSaveError(null);
                }} />
            </label>
            {fieldError("note", "milestone-note-error")}
            <label className="account-field" htmlFor="milestone-plan">Kế hoạch
              <select id="milestone-plan" name="plan_id" aria-invalid={validationError?.field === "plan" || undefined}
                aria-describedby={validationError?.field === "plan" ? "milestone-plan-error" : undefined}
                data-dayforge-dirty={dirty ? "true" : "false"} value={fields.planId} onChange={(event) => {
                  setFields((current) => ({ ...current, planId: event.target.value })); setValidationError(null);
                }}>
                <option value="">Không dùng kế hoạch</option>
                {plans.map((entry) => <option key={entry.id} value={entry.id}>{entry.root.data.name}</option>)}
              </select>
            </label>
            {fieldError("plan", "milestone-plan-error")}
            {selectedPlan ? <p className="task-plan-color">Dùng màu của <strong>{selectedPlan.root.data.name}</strong>.</p> : <fieldset className="plan-palette">
              <legend>Màu dấu mốc</legend>
              {CALENDAR_COLORS.map((color) => <label key={color.id} className="plan-color-option">
                <input type="radio" name="standalone_color_id" value={color.id} checked={fields.standaloneColor === color.id} onChange={() => {
                  setFields((current) => ({ ...current, standaloneColor: color.id }));
                }} />
                <span className="plan-color-swatch" style={{ backgroundColor: color.background, color: color.foreground }} aria-hidden="true">✓</span>
                <span>{color.name}</span>
              </label>)}
            </fieldset>}
            <label className="account-remember milestone-visibility">
              <input type="checkbox" name="show_in_work_calendar" checked={fields.showInWorkCalendar} data-dayforge-dirty={dirty ? "true" : "false"}
                onChange={(event) => setFields((current) => ({ ...current, showInWorkCalendar: event.target.checked }))} />
              <span>Hiện dấu mốc trên lịch công việc</span>
            </label>
            <div className="plan-preview task-preview" style={{ backgroundColor: effectiveColor.background, color: effectiveColor.foreground }}>
              {fields.title.trim() || "Tên dấu mốc"} · {fields.period === "" ? "Cả ngày" : fields.period === "morning" ? "Sáng" : fields.period === "afternoon" ? "Chiều" : "Tối"}
              {fields.note && <span aria-label="Có ghi chú"> · ▤</span>}
            </div>
            {saveError && <p className="account-error" role="alert">{saveError}</p>}
            {logoutError && !logoutChanges && <p className="account-error" role="alert">{logoutError}</p>}
            <div className="plan-form-actions">
              {editing && <button type="button" className="milestone-delete-button" disabled={busy || !account.calendarReady} onClick={() => { captureConfirmTrigger(); setConfirmDelete(true); }}>Gỡ dấu mốc</button>}
              {dirty && account.session?.authenticated && <button type="button" disabled={busy || logoutBusy} onClick={() => void requestLogout()}>Đăng xuất</button>}
              <button type="button" disabled={busy} onClick={requestClose}>Hủy</button>
              {account.state === "unlocked" && <button type="button" className="task-create-plan" disabled={busy || !account.calendarReady} onClick={() => setPlanManagerOpen(true)}>Tạo kế hoạch</button>}
              <button type="submit" className="account-submit" disabled={busy || account.state !== "unlocked" || !account.calendarReady}>
                {busy ? "Đang lưu…" : editing ? "Lưu thay đổi" : "Thêm dấu mốc"}
              </button>
            </div>
          </form>
          {confirmDiscard && <div className="task-discard-backdrop">
            <section className="task-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="milestone-discard-title">
              <h3 id="milestone-discard-title">Bỏ thay đổi chưa lưu?</h3>
              <p>Thông tin dấu mốc sẽ không được lưu.</p>
              <div className="plan-form-actions">
                <button type="button" autoFocus onClick={closeDiscardConfirmation}>Tiếp tục sửa</button>
                <button type="button" onClick={onClose}>Bỏ thay đổi</button>
              </div>
            </section>
          </div>}
          {logoutChanges && <div className="task-discard-backdrop">
            <section className="task-discard-dialog milestone-logout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="milestone-logout-title">
              <h3 id="milestone-logout-title">Bỏ thay đổi và đăng xuất?</h3>
              <p>
                Biểu mẫu dấu mốc đang sửa sẽ bị bỏ.
                {logoutChanges.pendingOperations > 0 && ` ${logoutChanges.pendingOperations} thay đổi đã lưu đang chờ đồng bộ`}
                {logoutChanges.pendingOperations > 0 && logoutChanges.drafts > 0 && " và"}
                {logoutChanges.drafts > 0 && ` ${logoutChanges.drafts} bản nháp đã lưu`}
                {logoutChanges.pendingOperations > 0 || logoutChanges.drafts > 0
                  ? ". Dữ liệu đã lưu vẫn được giữ mã hóa trên thiết bị và bị khóa cho đến lần đăng nhập tiếp theo."
                  : ". Dữ liệu đã lưu trên thiết bị vẫn được giữ và bị khóa cho đến lần đăng nhập tiếp theo."}
              </p>
              {logoutError && <p className="account-error" role="alert">{logoutError}</p>}
              <div className="plan-form-actions">
                <button type="button" autoFocus disabled={logoutBusy} onClick={closeLogoutConfirmation}>Tiếp tục sửa</button>
                <button type="button" disabled={logoutBusy} onClick={() => void discardAndLogout()}>{logoutBusy ? "Đang khóa…" : "Bỏ thay đổi và đăng xuất"}</button>
              </div>
            </section>
          </div>}
          {confirmDelete && <div className="task-discard-backdrop">
            <section className="task-discard-dialog milestone-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="milestone-delete-title">
              <h3 id="milestone-delete-title">Gỡ dấu mốc khỏi lịch?</h3>
              <p>Dấu mốc này sẽ được gỡ khỏi các lịch đã chọn. Các thay đổi sẽ lưu trên thiết bị và đồng bộ sau.</p>
              <div className="plan-form-actions">
                <button type="button" disabled={busy} autoFocus onClick={closeDeleteConfirmation}>Giữ dấu mốc</button>
                <button type="button" disabled={busy} onClick={() => void deleteMilestone()}>{busy ? "Đang gỡ…" : "Gỡ dấu mốc"}</button>
              </div>
            </section>
          </div>}
        </section>
      </div>,
      document.body,
    )}
    <PlanManager open={planManagerOpen} nested onClose={() => setPlanManagerOpen(false)} onCreated={(id) => {
      setFields((current) => ({ ...current, planId: id }));
    }} />
  </>;
}
