"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "../account/account-provider";
import type { ColorId, PlanData, PlanRoot } from "../../lib/sync/reducer";
import type { UUID } from "../../lib/sync/protocol";

export const CALENDAR_COLORS: ReadonlyArray<{ id: ColorId; name: string; foreground: string; background: string }> = [
  { id: "neutral", name: "Trung tính", foreground: "#CED7D8", background: "#334148" },
  { id: "earth", name: "Cam đất", foreground: "#E4BD98", background: "#493E32" },
  { id: "green", name: "Xanh lá", foreground: "#B0D5C0", background: "#2B4138" },
  { id: "teal", name: "Xanh ngọc", foreground: "#A7D6D1", background: "#294442" },
  { id: "blue", name: "Xanh lam", foreground: "#ABC9E8", background: "#2E4053" },
  { id: "purple", name: "Tím", foreground: "#CAB8E1", background: "#3D354D" },
  { id: "pink", name: "Hồng", foreground: "#E6B6C8", background: "#493641" },
  { id: "coral", name: "San hô", foreground: "#E5B2AB", background: "#4B3634" },
  { id: "sand", name: "Vàng cát", foreground: "#DFD096", background: "#48432E" },
];

type PlanEntry = { id: UUID; root: PlanRoot };
type PlanFields = { name: string; color_id: ColorId };

function fieldsFor(root: PlanRoot): PlanFields {
  return { name: root.data.name, color_id: root.data.color_id };
}

function sameFields(left: PlanFields, right: PlanFields): boolean {
  return left.name === right.name && left.color_id === right.color_id;
}

function fieldData(value: PlanFields): PlanData {
  return { name: value.name.normalize("NFC").trim(), color_id: value.color_id };
}

export type PlanManagerProps = {
  open: boolean;
  onClose(): void;
  onCreated?(id: UUID): void;
  nested?: boolean;
};

export function PlanManager({ open, onClose, onCreated, nested = false }: PlanManagerProps): React.JSX.Element | null {
  const account = useAccount();
  const [editingId, setEditingId] = useState<UUID | null>(null);
  const [fields, setFields] = useState<PlanFields>({ name: "", color_id: "neutral" });
  const [initial, setInitial] = useState<PlanFields>({ name: "", color_id: "neutral" });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const planNameInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dirty = !sameFields(fields, initial);

  const plans = useMemo<PlanEntry[]>(() => {
    const roots = account.calendarProjection?.roots ?? {};
    return Object.entries(roots)
      .filter((entry): entry is [string, PlanRoot] => entry[0].startsWith("plan:") &&
        "data" in entry[1] && "color_id" in entry[1].data && !entry[1].deleted)
      .map(([key, root]) => ({ id: key.slice("plan:".length), root }))
      .sort((left, right) => left.root.data.name.localeCompare(right.root.data.name, "vi") || left.id.localeCompare(right.id));
  }, [account.calendarProjection]);

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    setEditingId(null);
    setFields({ name: "", color_id: "neutral" });
    setInitial({ name: "", color_id: "neutral" });
    setValidationError(null);
    setSaveError(null);
    setConfirmDiscard(false);
    onClose();
  }, [busy, dirty, onClose]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => firstAction.current?.focus({ preventScroll: true }));
    const priorMainInert = document.getElementById("calendar-main")?.inert ?? false;
    const priorWidgetInert = document.querySelector<HTMLElement>(".calendar-widget")?.inert ?? false;
    const main = document.getElementById("calendar-main");
    const widget = document.querySelector<HTMLElement>(".calendar-widget");
    if (main) main.inert = true;
    if (widget) widget.inert = true;
    return () => {
      cancelAnimationFrame(frame);
      if (main) main.inert = priorMainInert;
      if (widget) widget.inert = priorWidgetInert;
      const target = returnFocus.current;
      const hiddenPanel = target?.closest<HTMLElement>(".widget-panel");
      const fallback = hiddenPanel?.inert ? document.querySelector<HTMLElement>(".widget-toggle") : null;
      (fallback ?? target)?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (confirmDiscard) setConfirmDiscard(false);
        else requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const activeDialog = confirmDiscard
        ? dialog.current.querySelector<HTMLElement>(".plan-discard-dialog")
        : dialog.current;
      if (!activeDialog) return;
      const focusable = [...activeDialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])",
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
  }, [confirmDiscard, open, requestClose]);

  if (!open || typeof document === "undefined") return null;

  function resetEditor(): void {
    setEditingId(null);
    setFields({ name: "", color_id: "neutral" });
    setInitial({ name: "", color_id: "neutral" });
    setValidationError(null);
    setSaveError(null);
    setConfirmDiscard(false);
  }

  function startCreate(): void {
    resetEditor();
    setEditingId("");
    requestAnimationFrame(() => planNameInput.current?.focus({ preventScroll: true }));
  }

  function startEdit(entry: PlanEntry): void {
    const next = fieldsFor(entry.root);
    setEditingId(entry.id);
    setFields(next);
    setInitial(next);
    setValidationError(null);
    setSaveError(null);
    requestAnimationFrame(() => planNameInput.current?.focus({ preventScroll: true }));
  }

  async function savePlan(): Promise<void> {
    const data = fieldData(fields);
    const codePoints = Array.from(data.name).length;
    if (codePoints < 1 || codePoints > 100) {
      setValidationError("Tên kế hoạch cần có từ 1 đến 100 ký tự.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    setValidationError(null);
    try {
      if (editingId) await account.replacePlan(editingId, data);
      else {
        const id = crypto.randomUUID() as UUID;
        await account.createPlan(id, data);
        onCreated?.(id);
      }
      resetEditor();
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Không thể lưu kế hoạch trên thiết bị.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="plan-manager-backdrop" data-nested={nested || undefined} onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section ref={dialog} className="plan-manager" role="dialog" aria-modal="true" aria-labelledby="plan-manager-title" data-dayforge-dirty={dirty ? "true" : "false"}>
        <header className="plan-manager-header">
          <div>
            <p className="calendar-kicker">DAYFORGE · KẾ HOẠCH</p>
            <h2 id="plan-manager-title">{editingId === null ? "Kế hoạch" : editingId ? "Sửa kế hoạch" : "Tạo kế hoạch"}</h2>
          </div>
          <button type="button" className="plan-manager-close" aria-label="Đóng kế hoạch" onClick={requestClose}>×</button>
        </header>

        {editingId === null ? <>
          <button ref={firstAction} type="button" className="account-submit plan-create-button" onClick={startCreate}>Tạo kế hoạch</button>
          {account.calendarError && <p className="account-error" role="alert">{account.calendarError}</p>}
          {!account.calendarReady && !account.calendarError && <p role="status" className="account-status">Đang mở dữ liệu kế hoạch…</p>}
          {account.calendarReady && plans.length === 0 && <p className="plan-empty">Chưa có kế hoạch. Bạn có thể tạo kế hoạch trong lúc nhập công việc hoặc dấu mốc.</p>}
          {plans.length > 0 && <ul className="plan-list" aria-label="Kế hoạch đã lưu">
            {plans.map((entry) => {
              const color = CALENDAR_COLORS.find((candidate) => candidate.id === entry.root.data.color_id) ?? CALENDAR_COLORS[0];
              return <li key={entry.id}>
                <span className="plan-list-swatch" style={{ backgroundColor: color.background, color: color.foreground }} aria-hidden="true" />
                <span className="plan-list-name">{entry.root.data.name}</span>
                <button type="button" aria-label={`Sửa ${entry.root.data.name}`} onClick={() => startEdit(entry)}>Sửa</button>
              </li>;
            })}
          </ul>}
        </> : <form className="plan-form" onSubmit={(event) => { event.preventDefault(); void savePlan(); }}>
          <label className="account-field" htmlFor="plan-name">Tên kế hoạch
            <input ref={planNameInput} id="plan-name" name="name" autoComplete="off" maxLength={400} data-dayforge-dirty={dirty ? "true" : "false"} value={fields.name} onChange={(event) => {
              setFields((current) => ({ ...current, name: event.target.value }));
              setValidationError(null);
              setSaveError(null);
            }} />
          </label>
          <fieldset className="plan-palette">
            <legend>Màu kế hoạch</legend>
            {CALENDAR_COLORS.map((color) => <label key={color.id} className="plan-color-option">
              <input type="radio" name="color_id" value={color.id} checked={fields.color_id === color.id} onChange={() => setFields((current) => ({ ...current, color_id: color.id }))} />
              <span className="plan-color-swatch" style={{ backgroundColor: color.background, color: color.foreground }} aria-hidden="true">✓</span>
              <span>{color.name}</span>
            </label>)}
          </fieldset>
          <div className="plan-preview" style={{ backgroundColor: CALENDAR_COLORS.find((color) => color.id === fields.color_id)?.background, color: CALENDAR_COLORS.find((color) => color.id === fields.color_id)?.foreground }}>
            {fields.name.trim() || "Tên kế hoạch"}
          </div>
          {validationError && <p className="account-error" role="alert">{validationError}</p>}
          {saveError && <p className="account-error" role="alert">{saveError}</p>}
          {account.error && <p className="account-error" role="alert">{account.error}</p>}
          <div className="plan-form-actions">
            <button type="button" disabled={busy} onClick={() => {
              if (dirty) setConfirmDiscard(true);
              else resetEditor();
            }}>Quay lại</button>
            <button type="submit" className="account-submit" disabled={busy}>{busy ? "Đang lưu…" : "Lưu kế hoạch"}</button>
          </div>
        </form>}

        {confirmDiscard && <div className="plan-discard-backdrop">
          <section className="plan-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="plan-discard-title">
            <h3 id="plan-discard-title">Bỏ thay đổi chưa lưu?</h3>
            <p>Tên hoặc màu kế hoạch sẽ không được lưu.</p>
            <div className="plan-form-actions">
              <button type="button" autoFocus onClick={() => setConfirmDiscard(false)}>Tiếp tục sửa</button>
              <button type="button" onClick={() => { resetEditor(); onClose(); }}>Bỏ thay đổi</button>
            </div>
          </section>
        </div>}
      </section>
    </div>,
    document.body,
  );
}
