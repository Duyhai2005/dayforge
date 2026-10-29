"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { MAX_CALENDAR_DATE, MIN_CALENDAR_DATE, moveAnchor, parseViewState, todayInUtc7, type CalendarKind, type MilestoneScale, type ViewState } from "../../lib/calendar/view-state";

export type CalendarWidgetProps = {
  calendar: CalendarKind;
  view: ViewState;
  onNavigate(next: ViewState): void;
  onSwitch(nextCalendar: CalendarKind): void;
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

export function CalendarWidget({ calendar, view, onNavigate, onSwitch }: CalendarWidgetProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
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
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        toggle.current?.focus({ preventScroll: true });
      }
    };
    const outside = (event: MouseEvent) => {
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
          {["Thêm công việc", "Thêm dấu mốc", "Thêm kế hoạch"].map(label => <button key={label} type="button" disabled aria-describedby={explanationId}>{label}</button>)}
        </div>
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
      <div className="widget-bar">
        <button className="widget-quick-add" type="button" disabled aria-describedby={explanationId} aria-label="Thêm nhanh">+</button>
        <div className="widget-summary"><strong>{calendar === "work" ? "Lịch công việc" : "Lịch dấu mốc"}</strong><span role="status">Chưa kết nối dữ liệu</span></div>
        <button ref={toggle} className="widget-toggle" type="button" aria-label="Mở hoặc đóng điều hướng lịch" aria-expanded={open} aria-controls={panelId} onClick={() => { if (open) close(); else setOpen(true); }}><span aria-hidden="true">{open ? "⌄" : "⌃"}</span></button>
      </div>
      <p id={explanationId} className="widget-save-explanation">Chưa thể lưu dữ liệu. Tính năng lưu sẽ có trong bước tiếp theo.</p>
    </div>
  );
}
