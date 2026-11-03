"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nextOrderKeyForBucket, type ColorId, type Period, type PlanRoot, type TaskData } from "../../lib/sync/reducer";
import type { UUID } from "../../lib/sync/protocol";
import { useAccount } from "../account/account-provider";
import { CALENDAR_COLORS, PlanManager } from "./plan-manager";

type TaskFields = {
  title: string;
  date: string;
  period: Period | "";
  duration: string;
  planId: string;
  standaloneColor: ColorId;
};
type TaskValidationField = "title" | "date" | "period" | "duration" | "plan";
type TaskValidationError = { field: TaskValidationField; message: string };

export type TaskEditorTarget = {
  id: UUID;
  data: TaskData;
  expectedRootHash: string;
};

export type TaskEditorProps = {
  open: boolean;
  date: string;
  period?: Period | null;
  editing?: TaskEditorTarget | null;
  onClose(): void;
  onSaved?(id: UUID): void;
};

function fieldsForTask(data: TaskData): TaskFields {
  return {
    title: data.title,
    date: data.date,
    period: data.period,
    duration: data.duration_minutes === null ? "" : String(data.duration_minutes),
    planId: data.plan_id ?? "",
    standaloneColor: data.standalone_color_id,
  };
}

function newTaskFields(date: string, period: Period | null | undefined): TaskFields {
  return { title: "", date, period: period ?? "", duration: "", planId: "", standaloneColor: "neutral" };
}

function sameFields(left: TaskFields, right: TaskFields): boolean {
  return left.title === right.title && left.date === right.date && left.period === right.period &&
    left.duration === right.duration && left.planId === right.planId && left.standaloneColor === right.standaloneColor;
}

function dateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01" || value > "9999-12-31") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function planEntries(state: ReturnType<typeof useAccount>["calendarProjection"]): Array<{ id: UUID; root: PlanRoot }> {
  const roots = state?.roots ?? {};
  return Object.entries(roots)
    .filter((entry): entry is [string, PlanRoot] => entry[0].startsWith("plan:") &&
      "data" in entry[1] && "color_id" in entry[1].data && !entry[1].deleted)
    .map(([key, root]) => ({ id: key.slice("plan:".length) as UUID, root }))
    .sort((left, right) => left.root.data.name.localeCompare(right.root.data.name, "vi") || left.id.localeCompare(right.id));
}

export function TaskEditor({ open, date, period = null, editing = null, onClose, onSaved }: TaskEditorProps): React.JSX.Element | null {
  const account = useAccount();
  const firstFields = editing ? fieldsForTask(editing.data) : newTaskFields(date, period);
  const [fields, setFields] = useState<TaskFields>(firstFields);
  const [initial] = useState<TaskFields>(firstFields);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [planManagerOpen, setPlanManagerOpen] = useState(false);
  const [validationError, setValidationError] = useState<TaskValidationError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dirty = !sameFields(fields, initial);
  const plans = useMemo(() => planEntries(account.calendarProjection), [account.calendarProjection]);
  const selectedPlan = plans.find((entry) => entry.id === fields.planId);
  const effectiveColorId = selectedPlan?.root.data.color_id ?? fields.standaloneColor;
  const effectiveColor = CALENDAR_COLORS.find((color) => color.id === effectiveColorId) ?? CALENDAR_COLORS[0];
  const fieldError = (field: TaskValidationField) => validationError?.field === field
    ? <p id={`task-${field}-error`} className="account-error" role="alert">{validationError.message}</p>
    : null;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => titleInput.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorMainInert = document.getElementById("calendar-main")?.inert ?? false;
    const priorWidgetInert = document.querySelector<HTMLElement>(".calendar-widget")?.inert ?? false;
    const main = document.getElementById("calendar-main");
    const widget = document.querySelector<HTMLElement>(".calendar-widget");
    if (main) main.inert = true;
    if (widget) widget.inert = true;
    return () => {
      if (main) main.inert = priorMainInert;
      if (widget) widget.inert = priorWidgetInert;
      const target = returnFocus.current;
      const hiddenPanel = target?.closest<HTMLElement>(".widget-panel");
      const fallback = hiddenPanel?.inert ? document.querySelector<HTMLElement>(".widget-toggle") : null;
      (fallback ?? target)?.focus({ preventScroll: true });
    };
  }, [open]);

  const requestClose = useCallback(() => {
    if (busy || planManagerOpen) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    onClose();
  }, [busy, dirty, onClose, planManagerOpen]);

  useEffect(() => {
    if (!open) return;
    const trap = (event: KeyboardEvent) => {
      if (planManagerOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (confirmDiscard) setConfirmDiscard(false);
        else requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const activeDialog = confirmDiscard
        ? dialog.current.querySelector<HTMLElement>(".task-discard-dialog")
        : dialog.current;
      if (!activeDialog) return;
      const focusable = [...activeDialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
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
  }, [confirmDiscard, open, planManagerOpen, requestClose]);

  if (!open || typeof document === "undefined") return null;

  async function saveTask(): Promise<void> {
    const title = fields.title.normalize("NFC").trim();
    const titleLength = Array.from(title).length;
    if (titleLength < 1 || titleLength > 120 || /[\u0000-\u001f\u007f]/.test(title)) {
      setValidationError({ field: "title", message: "Tên công việc cần có từ 1 đến 120 ký tự trên một dòng." });
      return;
    }
    if (!dateIsValid(fields.date)) {
      setValidationError({ field: "date", message: "Ngày công việc không hợp lệ." });
      return;
    }
    if (!fields.period) {
      setValidationError({ field: "period", message: "Hãy chọn buổi cho công việc." });
      return;
    }
    let duration: number | null = null;
    if (fields.duration !== "") {
      if (!/^\d+$/.test(fields.duration)) {
        setValidationError({ field: "duration", message: "Thời lượng phải là số nguyên từ 1 đến 1.440 phút." });
        return;
      }
      duration = Number(fields.duration);
      if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1440) {
        setValidationError({ field: "duration", message: "Thời lượng phải là số nguyên từ 1 đến 1.440 phút." });
        return;
      }
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
      const data: TaskData = {
        title,
        date: fields.date,
        period: fields.period,
        duration_minutes: duration,
        plan_id: (fields.planId || null) as UUID | null,
        standalone_color_id: fields.standaloneColor,
        status: editing?.data.status ?? "pending",
        order_key: editing && editing.data.date === fields.date && editing.data.period === fields.period
          ? editing.data.order_key
          : await nextOrderKeyForBucket(account.calendarProjection, fields.date, fields.period),
      };
      const id = editing?.id ?? crypto.randomUUID() as UUID;
      if (editing) await account.replaceTask(id, data, editing.expectedRootHash);
      else await account.createTask(id, data);
      onSaved?.(id);
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Không thể lưu công việc trên thiết bị.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    {createPortal(
      <div className="task-editor-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !planManagerOpen) requestClose();
      }}>
        <section ref={dialog} className="task-editor" role="dialog" aria-modal={!planManagerOpen} aria-hidden={planManagerOpen} inert={planManagerOpen} aria-labelledby="task-editor-title" data-dayforge-dirty={dirty ? "true" : "false"}>
          <header className="plan-manager-header">
            <div>
              <p className="calendar-kicker">DAYFORGE · CÔNG VIỆC</p>
              <h2 id="task-editor-title">{editing ? "Sửa công việc" : "Thêm công việc"}</h2>
            </div>
            <button type="button" className="plan-manager-close" aria-label="Đóng công việc" disabled={busy} onClick={requestClose}>×</button>
          </header>
          <form className="task-form" noValidate onSubmit={(event) => { event.preventDefault(); void saveTask(); }}>
            <label className="account-field" htmlFor="task-title">Tên công việc
              <input ref={titleInput} id="task-title" name="title" autoComplete="off" aria-invalid={validationError?.field === "title" || undefined} aria-describedby={validationError?.field === "title" ? "task-title-error" : undefined} data-dayforge-dirty={dirty ? "true" : "false"} value={fields.title} onChange={(event) => {
                setFields((current) => ({ ...current, title: event.target.value }));
                setValidationError(null);
                setSaveError(null);
              }} />
            </label>
            {validationError?.field === "title" && <p id="task-title-error" className="account-error" role="alert">{validationError.message}</p>}
            <div className="task-date-period">
              <div className="task-field">
                <label className="account-field" htmlFor="task-date">Ngày
                  <input id="task-date" name="date" type="date" min="0001-01-01" max="9999-12-31" required aria-invalid={validationError?.field === "date" || undefined} aria-describedby={validationError?.field === "date" ? "task-date-error" : undefined} data-dayforge-dirty={dirty ? "true" : "false"} value={fields.date} onChange={(event) => {
                    setFields((current) => ({ ...current, date: event.target.value }));
                    setValidationError(null);
                  }} />
                </label>
                {validationError?.field === "date" && <p id="task-date-error" className="account-error" role="alert">{validationError.message}</p>}
              </div>
              <div className="task-field">
                <label className="account-field" htmlFor="task-period">Buổi
                  <select id="task-period" name="period" required aria-invalid={validationError?.field === "period" || undefined} aria-describedby={validationError?.field === "period" ? "task-period-error" : undefined} data-dayforge-dirty={dirty ? "true" : "false"} value={fields.period} onChange={(event) => {
                    setFields((current) => ({ ...current, period: event.target.value as Period | "" }));
                    setValidationError(null);
                  }}>
                    <option value="">Chọn buổi</option>
                    <option value="morning">Sáng</option>
                    <option value="afternoon">Chiều</option>
                    <option value="evening">Tối</option>
                  </select>
                </label>
                {fieldError("period")}
              </div>
            </div>
            <label className="account-field" htmlFor="task-duration">Thời lượng ước tính (phút, không bắt buộc)
              <input id="task-duration" name="duration" inputMode="numeric" autoComplete="off" aria-invalid={validationError?.field === "duration" || undefined} aria-describedby={validationError?.field === "duration" ? "task-duration-error" : undefined} data-dayforge-dirty={dirty ? "true" : "false"} value={fields.duration} onChange={(event) => {
                setFields((current) => ({ ...current, duration: event.target.value }));
                setValidationError(null);
              }} />
            </label>
            {validationError?.field === "duration" && <p id="task-duration-error" className="account-error" role="alert">{validationError.message}</p>}
            <label className="account-field" htmlFor="task-plan">Kế hoạch
              <select id="task-plan" name="plan_id" aria-invalid={validationError?.field === "plan" || undefined} aria-describedby={validationError?.field === "plan" ? "task-plan-error" : undefined} data-dayforge-dirty={dirty ? "true" : "false"} value={fields.planId} onChange={(event) => {
                setFields((current) => ({ ...current, planId: event.target.value }));
                setValidationError(null);
              }}>
                <option value="">Không dùng kế hoạch</option>
                {plans.map((entry) => <option key={entry.id} value={entry.id}>{entry.root.data.name}</option>)}
              </select>
            </label>
            {validationError?.field === "plan" && <p id="task-plan-error" className="account-error" role="alert">{validationError.message}</p>}
            {selectedPlan ? <p className="task-plan-color">Dùng màu của <strong>{selectedPlan.root.data.name}</strong>.</p> : <fieldset className="plan-palette">
              <legend>Màu công việc</legend>
              {CALENDAR_COLORS.map((color) => <label key={color.id} className="plan-color-option">
                <input type="radio" name="standalone_color_id" value={color.id} checked={fields.standaloneColor === color.id} onChange={() => setFields((current) => ({ ...current, standaloneColor: color.id }))} />
                <span className="plan-color-swatch" style={{ backgroundColor: color.background, color: color.foreground }} aria-hidden="true">✓</span>
                <span>{color.name}</span>
              </label>)}
            </fieldset>}
            {fields.period && <div className="plan-preview task-preview" style={{ backgroundColor: effectiveColor.background, color: effectiveColor.foreground }}>
              {fields.title.trim() || "Tên công việc"} · {fields.period === "morning" ? "Sáng" : fields.period === "afternoon" ? "Chiều" : "Tối"}
              {fields.duration && ` · ${fields.duration} phút`}
            </div>}
            {saveError && <p className="account-error" role="alert">{saveError}</p>}
            <div className="plan-form-actions">
              <button type="button" disabled={busy} onClick={() => {
                if (dirty) setConfirmDiscard(true);
                else onClose();
              }}>Hủy</button>
              {account.state === "unlocked" && <button type="button" className="task-create-plan" disabled={busy || !account.calendarReady} onClick={() => setPlanManagerOpen(true)}>Tạo kế hoạch</button>}
              <button type="submit" className="account-submit" disabled={busy || account.state !== "unlocked" || !account.calendarReady}>
                {busy ? "Đang lưu…" : "Lưu công việc"}
              </button>
            </div>
          </form>
          {confirmDiscard && <div className="task-discard-backdrop">
            <section className="task-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="task-discard-title">
              <h3 id="task-discard-title">Bỏ thay đổi chưa lưu?</h3>
              <p>Thông tin công việc sẽ không được lưu.</p>
              <div className="plan-form-actions">
                <button type="button" autoFocus onClick={() => setConfirmDiscard(false)}>Tiếp tục sửa</button>
                <button type="button" onClick={onClose}>Bỏ thay đổi</button>
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
