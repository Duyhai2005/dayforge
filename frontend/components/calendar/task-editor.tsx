"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { firstOccurrenceDate, nextOrderKeyForBucket, type ColorId, type Period, type PlanRoot, type RecurrenceRule, type RuleSegment, type TaskData, type TaskTemplate, type WorkItemTarget, type WorkRoot } from "../../lib/sync/reducer";
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
  recurrence: "none" | "daily" | "weekly";
  weekdays: number[];
};
type TaskValidationField = "title" | "date" | "period" | "duration" | "plan" | "recurrence";
type TaskValidationError = { field: TaskValidationField; message: string };

export type TaskEditorTarget = {
  id: UUID;
  data: TaskData;
  expectedRootHash: string;
  target?: WorkItemTarget;
  root: WorkRoot;
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
    recurrence: "none",
    weekdays: [isoWeekday(data.date)],
  };
}

function fieldsForSeriesSegment(segment: RuleSegment, cutoff: string): TaskFields {
  return {
    title: segment.template.title,
    date: cutoff,
    period: segment.template.period,
    duration: segment.template.duration_minutes === null ? "" : String(segment.template.duration_minutes),
    planId: segment.template.plan_id ?? "",
    standaloneColor: segment.template.standalone_color_id,
    recurrence: segment.rule.weekdays.length === 7 ? "daily" : "weekly",
    weekdays: [...segment.rule.weekdays],
  };
}

function editableSeriesSegment(editing: TaskEditorTarget | null): RuleSegment | null {
  const target = editing?.target;
  if (!editing || editing.root.kind !== "recurrence_family" || target?.kind !== "occurrence") return null;
  return editing.root.family.segments.find((segment) => segment.segment_id === target.source_segment_id) ?? null;
}

function newTaskFields(date: string, period: Period | null | undefined): TaskFields {
  return { title: "", date, period: period ?? "", duration: "", planId: "", standaloneColor: "neutral", recurrence: "none", weekdays: [isoWeekday(date)] };
}

function sameFields(left: TaskFields, right: TaskFields): boolean {
  return left.title === right.title && left.date === right.date && left.period === right.period &&
    left.duration === right.duration && left.planId === right.planId && left.standaloneColor === right.standaloneColor &&
    left.recurrence === right.recurrence && left.weekdays.length === right.weekdays.length &&
    left.weekdays.every((day, index) => day === right.weekdays[index]);
}

function isoWeekday(value: string): number {
  const day = new Date(`${value}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

const WEEKDAYS = [
  { value: 1, label: "Thứ hai", short: "T2" },
  { value: 2, label: "Thứ ba", short: "T3" },
  { value: 3, label: "Thứ tư", short: "T4" },
  { value: 4, label: "Thứ năm", short: "T5" },
  { value: 5, label: "Thứ sáu", short: "T6" },
  { value: 6, label: "Thứ bảy", short: "T7" },
  { value: 7, label: "Chủ nhật", short: "CN" },
] as const;

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
  const seriesSegment = editableSeriesSegment(editing);
  const target = editing?.target ?? { kind: "single" as const };
  const [fields, setFields] = useState<TaskFields>(firstFields);
  const [initial, setInitial] = useState<TaskFields>(firstFields);
  const [editScope, setEditScope] = useState<"occurrence" | "future">("occurrence");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmStopSeries, setConfirmStopSeries] = useState(false);
  const [planManagerOpen, setPlanManagerOpen] = useState(false);
  const [validationError, setValidationError] = useState<TaskValidationError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const futureSeriesScope = target.kind === "occurrence" && seriesSegment !== null && editScope === "future";
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

  function selectEditScope(next: "occurrence" | "future"): void {
    if (!editing || !seriesSegment || target.kind !== "occurrence") return;
    if (dirty) {
      setSaveError("Hãy lưu hoặc bỏ thay đổi hiện tại trước khi đổi phạm vi.");
      return;
    }
    const nextFields = next === "future"
      ? fieldsForSeriesSegment(seriesSegment, target.original_date)
      : fieldsForTask(editing.data);
    setFields(nextFields);
    setInitial(nextFields);
    setEditScope(next);
    setValidationError(null);
    setSaveError(null);
  }

  useEffect(() => {
    if (!open) return;
    const trap = (event: KeyboardEvent) => {
      if (planManagerOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (confirmDelete) setConfirmDelete(false);
        else if (confirmStopSeries) setConfirmStopSeries(false);
        else if (confirmDiscard) setConfirmDiscard(false);
        else requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const activeDialog = confirmDelete
        ? dialog.current.querySelector<HTMLElement>(".task-delete-dialog")
        : confirmStopSeries
        ? dialog.current.querySelector<HTMLElement>(".task-stop-dialog")
        : confirmDiscard
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
  }, [confirmDelete, confirmDiscard, confirmStopSeries, open, planManagerOpen, requestClose]);

  if (!open || typeof document === "undefined") return null;

  async function saveTask(): Promise<void> {
    if (editing && !dirty) { onClose(); return; }
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
    if ((fields.recurrence === "weekly" || futureSeriesScope && fields.recurrence !== "none") && fields.weekdays.length === 0) {
      setValidationError({ field: "recurrence", message: "Hãy chọn ít nhất một thứ trong tuần để lặp." });
      return;
    }
    if (editing && target.kind === "single" && fields.recurrence !== "none" && !fields.weekdays.includes(isoWeekday(fields.date))) {
      setValidationError({ field: "date", message: "Ngày của lần đầu phải nằm trong các thứ đã chọn." });
      return;
    }
    if (futureSeriesScope && seriesSegment && fields.date < seriesSegment.from_date) {
      setValidationError({ field: "date", message: "Mốc áp dụng phải nằm trong hoặc sau khoảng của quy tắc đang sửa." });
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
      const ruleWeekdays = fields.recurrence === "daily"
        ? WEEKDAYS.map((day) => day.value)
        : [...fields.weekdays].sort((left, right) => left - right);
      const firstDate = fields.recurrence === "none" ? fields.date : firstOccurrenceDate(fields.date, ruleWeekdays);
      if (!firstDate && !futureSeriesScope) {
        setValidationError({ field: "date", message: "Không còn ngày phù hợp trong phạm vi năm được hỗ trợ." });
        return;
      }
      const id = editing?.id ?? crypto.randomUUID() as UUID;
      if (futureSeriesScope && editing && target.kind === "occurrence" && seriesSegment && fields.period) {
        const rule: RecurrenceRule = { weekdays: ruleWeekdays };
        const template: TaskTemplate = {
          title,
          period: fields.period,
          duration_minutes: duration,
          plan_id: (fields.planId || null) as UUID | null,
          standalone_color_id: fields.standaloneColor,
          order_key: seriesSegment.template.order_key,
        };
        await account.editSeriesFuture(id, seriesSegment.segment_id, fields.date, rule, template, editing.expectedRootHash);
      } else {
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
        if (!editing && fields.recurrence !== "none") {
          const firstOrderKey = await nextOrderKeyForBucket(account.calendarProjection, firstDate!, data.period);
          const template: TaskTemplate = {
            title: data.title,
            period: data.period,
            duration_minutes: data.duration_minutes,
            plan_id: data.plan_id,
            standalone_color_id: data.standalone_color_id,
            order_key: firstOrderKey,
          };
          const rule: RecurrenceRule = { weekdays: ruleWeekdays };
          await account.createRecurringTask(id, fields.date, rule, template);
        } else if (editing && target.kind === "single" && fields.recurrence !== "none") {
        const rule: RecurrenceRule = { weekdays: ruleWeekdays };
        await account.enableTaskRecurrence(id, data, rule, editing.expectedRootHash);
        } else if (editing && (editing.data.date !== data.date || editing.data.period !== data.period)) {
          await account.repositionTask(id, editing.data, data, editing.expectedRootHash, null, target);
        } else if (editing) await account.replaceWorkItemTarget(id, target, data, editing.expectedRootHash);
        else await account.createTask(id, data);
      }
      onSaved?.(id);
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Không thể lưu công việc trên thiết bị.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(): Promise<void> {
    if (!editing) return;
    setBusy(true);
    setSaveError(null);
    try {
      await account.deleteWorkItemTarget(editing.id, target, editing.data.title, editing.expectedRootHash);
      setConfirmDelete(false);
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Không thể xóa công việc khỏi lịch.");
    } finally {
      setBusy(false);
    }
  }

  async function stopSeries(): Promise<void> {
    if (!editing || target.kind !== "occurrence" || !seriesSegment) return;
    setBusy(true);
    setSaveError(null);
    try {
      await account.stopSeriesFuture(editing.id, seriesSegment.segment_id, target.original_date, editing.data.title, editing.expectedRootHash);
      setConfirmStopSeries(false);
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Không thể dừng chuỗi lặp.");
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
            {seriesSegment && target.kind === "occurrence" && <fieldset className="task-recurrence-scope">
              <legend>Phạm vi chỉnh sửa</legend>
              <label><input type="radio" name="recurrence-scope" checked={editScope === "occurrence"} onChange={() => selectEditScope("occurrence")} />Chỉ lần này</label>
              <label><input type="radio" name="recurrence-scope" checked={editScope === "future"} onChange={() => selectEditScope("future")} />Quy tắc và mẫu từ ngày gốc</label>
              {editScope === "future" && <p className="task-recurrence-hint">Các lần đã chỉnh riêng từ mốc này sẽ thành việc một lần, giữ nội dung, kế hoạch và màu riêng.</p>}
              <button type="button" className="task-series-stop-button" disabled={busy || !account.calendarReady}
                onClick={() => setConfirmStopSeries(true)}>Dừng chuỗi từ lần này trở đi</button>
            </fieldset>}
            <div className="task-date-period">
              <div className="task-field">
                <label className="account-field" htmlFor="task-date">{futureSeriesScope ? "Áp dụng từ ngày gốc" : "Ngày"}
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
            {(!editing || target.kind === "single" || futureSeriesScope) && <fieldset className="task-recurrence">
              <legend>{futureSeriesScope ? "Quy tắc áp dụng từ mốc" : "Lặp lại"}</legend>
              <label className="account-field" htmlFor="task-recurrence">
                Lịch lặp
                <select id="task-recurrence" name="recurrence" value={fields.recurrence} data-dayforge-dirty={dirty ? "true" : "false"}
                  onChange={(event) => {
                    setFields((current) => ({ ...current, recurrence: event.target.value as TaskFields["recurrence"] }));
                    setValidationError(null);
                  }}>
                  {!futureSeriesScope && <option value="none">Không lặp</option>}
                  <option value="daily">Hằng ngày</option>
                  <option value="weekly">Chọn các thứ trong tuần</option>
                </select>
              </label>
              {fields.recurrence === "weekly" && <div className="task-weekday-picks" role="group" aria-label="Các thứ lặp lại">
                {WEEKDAYS.map((day) => <label key={day.value}>
                  <input type="checkbox" name="recurrence-weekday" value={day.value} checked={fields.weekdays.includes(day.value)}
                    onChange={(event) => setFields((current) => ({
                      ...current,
                      weekdays: event.target.checked
                        ? [...current.weekdays, day.value].sort((left, right) => left - right)
                        : current.weekdays.filter((value) => value !== day.value),
                    }))} />
                  <span aria-label={day.label}>{day.short}</span>
                </label>)}
              </div>}
              {fields.recurrence !== "none" && <p className="task-recurrence-hint">Lặp từ ngày đã chọn đến khi bạn dừng.</p>}
              {fieldError("recurrence")}
              {fields.recurrence !== "none" && !editing && fields.date && !ruleWeekdayMatches(fields.date, fields.recurrence, fields.weekdays) && firstOccurrenceDate(
                fields.date,
                fields.recurrence === "daily" ? WEEKDAYS.map((day) => day.value) : fields.weekdays,
              ) && <p className="task-recurrence-hint">Lần đầu sẽ là ngày {new Intl.DateTimeFormat("vi-VN", { dateStyle: "long", timeZone: "UTC" }).format(
                new Date(`${firstOccurrenceDate(fields.date, fields.recurrence === "daily" ? WEEKDAYS.map((day) => day.value) : fields.weekdays)}T00:00:00.000Z`),
              )}.</p>}
            </fieldset>}
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
              {editing && <button type="button" className="task-delete-button" disabled={busy || account.state !== "unlocked" || !account.calendarReady} onClick={() => setConfirmDelete(true)}>
                {target.kind === "occurrence" ? "Xóa lần lặp" : target.kind === "detached" ? "Xóa việc một lần" : "Xóa công việc"}
              </button>}
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
          {confirmStopSeries && editing && target.kind === "occurrence" && <div className="task-delete-backdrop">
            <section className="task-delete-dialog task-stop-dialog" role="alertdialog" aria-modal="true" aria-labelledby="task-stop-title">
              <h3 id="task-stop-title">Dừng chuỗi lặp từ ngày gốc này?</h3>
              <p>Các lần có ngày gốc từ {target.original_date} trở đi sẽ bị gỡ khỏi lịch. Lịch sử trước mốc và những việc đã tách thành việc một lần vẫn được giữ. Bạn có thể hoàn tác ngay sau đó.</p>
              <div className="plan-form-actions">
                <button type="button" autoFocus disabled={busy} onClick={() => setConfirmStopSeries(false)}>Tiếp tục chuỗi</button>
                <button type="button" className="task-delete-button" disabled={busy || account.state !== "unlocked" || !account.calendarReady} onClick={() => void stopSeries()}>
                  {busy ? "Đang dừng…" : "Dừng từ ngày này"}
                </button>
              </div>
            </section>
          </div>}
          {confirmDelete && editing && <div className="task-delete-backdrop">
            <section className="task-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="task-delete-title">
              <h3 id="task-delete-title">{target.kind === "occurrence" ? "Xóa lần lặp khỏi lịch?" : target.kind === "detached" ? "Xóa việc một lần đã tách?" : "Xóa công việc khỏi lịch?"}</h3>
              <p>{target.kind === "occurrence"
                ? `Lần có ngày gốc ${target.original_date} sẽ bị ẩn; các lần khác vẫn giữ nguyên.`
                : `“${editing.data.title}” sẽ biến mất khỏi lịch.`} Bạn có thể hoàn tác ngay sau đó.{dirty ? " Các chỉnh sửa chưa lưu sẽ bị bỏ." : ""}</p>
              {saveError && <p className="account-error" role="alert">{saveError}</p>}
              <div className="plan-form-actions">
                <button type="button" autoFocus disabled={busy} onClick={() => setConfirmDelete(false)}>Giữ lại</button>
                <button type="button" className="task-delete-button" disabled={busy || account.state !== "unlocked" || !account.calendarReady} onClick={() => void deleteTask()}>
                  {busy ? "Đang xóa…" : target.kind === "occurrence" ? "Xóa lần này" : target.kind === "detached" ? "Xóa việc một lần" : "Xóa công việc"}
                </button>
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

function ruleWeekdayMatches(date: string, recurrence: TaskFields["recurrence"], weekdays: readonly number[]): boolean {
  return recurrence === "daily" || weekdays.includes(isoWeekday(date));
}
