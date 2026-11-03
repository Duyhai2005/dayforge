"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { milestoneMonthAnchor, milestoneMonthDates } from "../../lib/calendar/milestone-calendar";
import { todayInUtc7 } from "../../lib/calendar/view-state";
import { workWeekDates } from "../../lib/calendar/work-week";
import { semanticRootHash, type MilestoneData, type MilestoneRoot, type Period, type PlanRoot, type ProjectionState } from "../../lib/sync/reducer";
import type { UUID } from "../../lib/sync/protocol";
import { useAccount } from "../account/account-provider";
import { CALENDAR_COLORS } from "./plan-manager";
import type { MilestoneEditorTarget } from "./milestone-editor";

const WEEKDAYS = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy", "Chủ nhật"] as const;
const PERIODS: ReadonlyArray<{ id: Period; label: string }> = [
  { id: "morning", label: "Sáng" },
  { id: "afternoon", label: "Chiều" },
  { id: "evening", label: "Tối" },
];

type MilestoneCard = {
  id: UUID;
  root: MilestoneRoot;
  data: MilestoneData;
  color: (typeof CALENDAR_COLORS)[number];
  legendLabel: string;
};

type MonthView = { year: number; monthIndex: number; dates: Array<string | null> };

function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("vi-VN", { ...options, timeZone: "UTC" }).format(new Date(`${date}T00:00:00.000Z`));
}

function monthView(anchor: string): MonthView {
  const date = new Date(`${anchor}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  return { year, monthIndex, dates: milestoneMonthDates(year, monthIndex, true) };
}

function cardColor(projection: ProjectionState | null, data: MilestoneData) {
  const plan = data.plan_id ? projection?.roots[`plan:${data.plan_id}`] : null;
  if (plan && !("kind" in plan) && !plan.deleted && "color_id" in plan.data) {
    const root = plan as PlanRoot;
    const color = CALENDAR_COLORS.find((option) => option.id === root.data.color_id) ?? CALENDAR_COLORS[0];
    return { color, legendLabel: root.data.name };
  }
  const color = CALENDAR_COLORS.find((option) => option.id === data.standalone_color_id) ?? CALENDAR_COLORS[0];
  return { color, legendLabel: color.id === "neutral" ? "Không thuộc kế hoạch" : color.name };
}

function milestonesFor(projection: ProjectionState | null): MilestoneCard[] {
  if (!projection) return [];
  return Object.entries(projection.roots)
    .filter((entry): entry is [string, MilestoneRoot] => entry[0].startsWith("milestone:") && !entry[1].deleted &&
      "data" in entry[1] && "title" in entry[1].data && "show_in_work_calendar" in entry[1].data)
    .map(([key, root]) => {
      const id = key.slice("milestone:".length) as UUID;
      const { color, legendLabel } = cardColor(projection, root.data);
      return { id, root, data: root.data, color, legendLabel };
    })
    .sort((left, right) => left.data.date.localeCompare(right.data.date) ||
      ((left.data.period ? PERIODS.findIndex((period) => period.id === left.data.period) + 1 : 0) -
        (right.data.period ? PERIODS.findIndex((period) => period.id === right.data.period) + 1 : 0)) ||
      left.data.title.localeCompare(right.data.title, "vi") || left.id.localeCompare(right.id));
}

function periodLabel(period: Period | null): string {
  return period ? PERIODS.find((entry) => entry.id === period)?.label ?? "Cả ngày" : "Cả ngày";
}

function MilestoneButton({ milestone, compact = false, onEdit }: {
  milestone: MilestoneCard;
  compact?: boolean;
  onEdit(card: MilestoneCard): void;
}): React.JSX.Element {
  const noteLabel = milestone.data.note ? ", Có ghi chú" : "";
  const label = `${milestone.data.title}, ${periodLabel(milestone.data.period)}${noteLabel}`;
  return <button type="button" className={`milestone-calendar-event${compact ? " is-compact" : ""}`}
    data-milestone-id={milestone.id} data-milestone-date={milestone.data.date}
    style={{ backgroundColor: milestone.color.background, color: milestone.color.foreground }}
    aria-label={label} onClick={() => onEdit(milestone)}>
    <span className="milestone-event-period">{periodLabel(milestone.data.period)}</span>
    <span className="milestone-event-title">{milestone.data.title}</span>
    {milestone.data.note && <span className="milestone-event-note" aria-hidden="true">▤</span>}
  </button>;
}

export type MilestoneCalendarProps = {
  anchor: string;
  scale: "week" | "month" | "year";
  onNavigate(next: { calendar: "milestones"; anchor: string; scale: "week" | "month" | "year" }): void;
  onEditMilestone(target: MilestoneEditorTarget): void;
  onAddMilestone(date: string): void;
  onOpenWorkWeek(date: string): void;
};

export function MilestoneCalendar({ anchor, scale, onNavigate, onEditMilestone, onAddMilestone, onOpenWorkWeek }: MilestoneCalendarProps): React.JSX.Element {
  const account = useAccount();
  const projection = account.state === "unlocked" && account.calendarReady ? account.calendarProjection : null;
  const milestones = useMemo(() => milestonesFor(projection), [projection]);
  const byDate = useMemo(() => {
    const grouped = new Map<string, MilestoneCard[]>();
    for (const milestone of milestones) {
      const bucket = grouped.get(milestone.data.date);
      if (bucket) bucket.push(milestone);
      else grouped.set(milestone.data.date, [milestone]);
    }
    return grouped;
  }, [milestones]);
  const weekDates = useMemo(() => workWeekDates(anchor), [anchor]);
  const month = useMemo(() => monthView(anchor), [anchor]);
  const monthGridDates = month.dates;
  const year = new Date(`${anchor}T00:00:00.000Z`).getUTCFullYear();
  const yearMonths = useMemo(() => Array.from({ length: 12 }, (_, monthIndex) => ({
    monthIndex,
    anchor: milestoneMonthAnchor(year, monthIndex) ?? anchor,
    dates: milestoneMonthDates(year, monthIndex),
  })), [anchor, year]);
  const milestonesByYearMonth = useMemo(() => {
    const grouped = new Map<number, MilestoneCard[]>();
    const yearPrefix = `${year}-`;
    for (const milestone of milestones) {
      if (!milestone.data.date.startsWith(yearPrefix)) continue;
      const monthIndex = Number(milestone.data.date.slice(5, 7)) - 1;
      const bucket = grouped.get(monthIndex);
      if (bucket) bucket.push(milestone);
      else grouped.set(monthIndex, [milestone]);
    }
    return grouped;
  }, [milestones, year]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const dayDialog = useRef<HTMLDialogElement>(null);
  const dayTrigger = useRef<HTMLButtonElement | null>(null);
  const today = todayInUtc7(new Date());
  const canWrite = account.state === "unlocked" && account.calendarReady;

  useEffect(() => {
    const dialog = dayDialog.current;
    if (selectedDate && dialog && !dialog.open) dialog.showModal();
    else if (!selectedDate && dialog?.open) dialog.close();
  }, [selectedDate]);

  const openDay = (date: string, trigger?: HTMLButtonElement) => {
    dayTrigger.current = trigger ?? null;
    setSelectedDate(date);
  };
  const closeDay = () => {
    setSelectedDate(null);
    requestAnimationFrame(() => dayTrigger.current?.focus({ preventScroll: true }));
  };
  const editFromDay = async (card: MilestoneCard) => {
    dayDialog.current?.close();
    setSelectedDate(null);
    const expectedRootHash = await semanticRootHash({ kind: "milestone", id: card.id }, card.root);
    onEditMilestone({ id: card.id, data: card.data, expectedRootHash });
  };
  const visibleMilestones = useMemo(() => {
    if (scale === "year") return milestones.filter((milestone) => milestone.data.date.startsWith(`${year}-`));
    const dates = scale === "week" ? weekDates : monthGridDates;
    const dateSet = new Set(dates.filter((date): date is string => date !== null));
    return milestones.filter((milestone) => dateSet.has(milestone.data.date));
  }, [milestones, monthGridDates, scale, weekDates, year]);
  const visibleLegend = useMemo(() => {
    const entries = new Map<string, { label: string; color: string }>();
    for (const milestone of visibleMilestones) {
      const key = `${milestone.data.plan_id ?? "standalone"}:${milestone.color.id}`;
      entries.set(key, { label: milestone.legendLabel, color: milestone.color.foreground });
    }
    return [...entries.values()].sort((left, right) => left.label.localeCompare(right.label, "vi"));
  }, [visibleMilestones]);

  function navigateToMonth(yearValue: number, monthIndex: number, day = 1): void {
    const nextAnchor = milestoneMonthAnchor(yearValue, monthIndex, day);
    if (nextAnchor) onNavigate({ calendar: "milestones", anchor: nextAnchor, scale: "month" });
  }

  function openMonthDay(date: string, button: HTMLButtonElement): void {
    openDay(date, button);
  }

  const selectedMilestones = selectedDate ? byDate.get(selectedDate) ?? [] : [];
  const dialogDateLabel = selectedDate ? formatDate(selectedDate, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";

  return <section className={`milestone-calendar milestone-calendar-${scale}`} aria-label={`Lịch dấu mốc theo ${scale === "week" ? "tuần" : scale === "month" ? "tháng" : "năm"}`}>
    {account.state !== "unlocked" && <p className="milestone-calendar-message" role="status">Mở khóa kho local để xem các dấu mốc.</p>}
    {account.state === "unlocked" && account.calendarError && <p className="milestone-calendar-message account-error" role="alert">{account.calendarError}</p>}
    {account.state === "unlocked" && !account.calendarReady && !account.calendarError && <p className="milestone-calendar-message" role="status">Đang đọc dấu mốc trên thiết bị…</p>}

    {scale === "week" && <div className="milestone-week-grid">
      {weekDates.map((date, index) => {
        const cards = date ? byDate.get(date) ?? [] : [];
        const dayName = date ? formatDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Ngoài phạm vi ngày";
        return <article key={date ?? `outside-${index}`} className="milestone-week-day" data-milestone-date={date ?? undefined} data-today={date === today}>
          <header className="milestone-day-heading">
            {date ? <button type="button" aria-label={`Xem dấu mốc ${dayName}`} onClick={(event) => openDay(date, event.currentTarget)}>
              <span>{formatDate(date, { weekday: "long" })}</span><strong>{formatDate(date, { day: "numeric", month: "short" })}</strong>
            </button> : <span>Ngoài phạm vi ngày</span>}
          </header>
          {date && <div className="milestone-week-events">
            {[null, ...PERIODS.map((period) => period.id)].map((period) => {
              const bucket = cards.filter((card) => card.data.period === period);
              if (bucket.length === 0) return null;
              return <section key={period ?? "all-day"} className="milestone-week-period" aria-label={periodLabel(period)}>
                <h3>{periodLabel(period)}</h3>
                {bucket.map((card) => <MilestoneButton key={card.id} milestone={card} onEdit={editFromDay} />)}
              </section>;
            })}
            {cards.length === 0 && <p className="milestone-empty-day">Chưa có dấu mốc</p>}
          </div>}
        </article>;
      })}
    </div>}

    {scale === "month" && <div className="milestone-month-grid" aria-label={`Ngày trong tháng ${month.monthIndex + 1}, ${month.year}`}>
      <div className="milestone-weekday-row" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
      <div className="milestone-month-days">
        {monthGridDates.map((date, index) => {
          if (!date) return <div key={`outside-${index}`} className="milestone-month-day is-outside" aria-hidden="true" />;
          const cards = byDate.get(date) ?? [];
          const inMonth = date.startsWith(`${month.year}-${String(month.monthIndex + 1).padStart(2, "0")}-`);
          const dayLabel = formatDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
          return <article key={date} className="milestone-month-day" data-in-month={inMonth} data-today={date === today} data-milestone-date={date}>
            <button type="button" className="milestone-month-date" aria-label={`Xem dấu mốc ${dayLabel}`} onClick={(event) => openMonthDay(date, event.currentTarget)}>{formatDate(date, { day: "numeric" })}</button>
            <div className="milestone-month-events">
              {cards.slice(0, 2).map((card) => <MilestoneButton key={card.id} milestone={card} compact onEdit={editFromDay} />)}
              {cards.length > 2 && <button type="button" className="milestone-more" aria-label={`${cards.length - 2} dấu mốc khác ngày ${dayLabel}`} onClick={(event) => openDay(date, event.currentTarget)}>{cards.length - 2} dấu mốc khác</button>}
            </div>
          </article>;
        })}
      </div>
    </div>}

    {scale === "year" && <div className="milestone-year-grid" aria-label={`12 tháng trong năm ${year}`}>
      {yearMonths.map((entry) => {
        const monthPrefix = `${year}-${String(entry.monthIndex + 1).padStart(2, "0")}-`;
        const monthCards = milestonesByYearMonth.get(entry.monthIndex) ?? [];
        const monthName = formatDate(entry.anchor, { month: "long" });
        return <section key={entry.monthIndex} className="milestone-year-month" aria-label={`${monthName}, ${monthCards.length} dấu mốc`}>
          <header><button type="button" onClick={() => navigateToMonth(year, entry.monthIndex)}>{monthName}</button><span>{monthCards.length} dấu mốc</span></header>
          <div className="milestone-mini-weekdays" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day.slice(0, 1)}</span>)}</div>
          <div className="milestone-mini-days">
            {entry.dates.map((date, index) => {
              if (!date || !date.startsWith(monthPrefix)) return <span key={`blank-${entry.monthIndex}-${index}`} aria-hidden="true" />;
              const dayCards = byDate.get(date) ?? [];
              const dateLabel = formatDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
              return <button key={date} type="button" aria-label={`Mở tháng từ ${dateLabel}`} data-has-milestone={dayCards.length > 0}
                onClick={() => navigateToMonth(year, entry.monthIndex, Number(date.slice(-2)))}>
                <span>{Number(date.slice(-2))}</span>
                {dayCards.slice(0, 3).map((card) => <i key={card.id} style={{ backgroundColor: card.color.foreground }} aria-hidden="true" />)}
              </button>;
            })}
          </div>
          {monthCards.length === 0
            ? <p className="milestone-year-empty">Chưa có dấu mốc</p>
            : <div className="milestone-year-summary">
              {monthCards.slice(0, 2).map((card) => <button key={card.id} type="button" style={{ borderColor: card.color.foreground }} onClick={() => navigateToMonth(year, entry.monthIndex, Number(card.data.date.slice(-2)))}>{card.data.title}</button>)}
              {monthCards.length > 2 && <span>{monthCards.length} dấu mốc</span>}
            </div>}
        </section>;
      })}
    </div>}

    {visibleLegend.length > 0 && <ul className="milestone-calendar-legend" aria-label="Màu kế hoạch trong khoảng đang xem">
      {visibleLegend.map((entry) => <li key={`${entry.label}:${entry.color}`}><span aria-hidden="true" style={{ backgroundColor: entry.color }} />{entry.label}</li>)}
    </ul>}
    {canWrite && visibleMilestones.length === 0 && <p className="milestone-calendar-message" role="status">Khoảng này chưa có dấu mốc.</p>}

    <dialog ref={dayDialog} className="milestone-day-dialog" aria-labelledby="milestone-day-title" onCancel={(event) => { event.preventDefault(); closeDay(); }} onClose={() => {
      if (selectedDate) setSelectedDate(null);
      requestAnimationFrame(() => dayTrigger.current?.focus({ preventScroll: true }));
    }}>
      {selectedDate && <>
        <header className="milestone-day-dialog-header">
          <div><p className="calendar-kicker">NGÀY ĐANG XEM</p><h2 id="milestone-day-title">{dialogDateLabel}</h2></div>
          <button type="button" aria-label="Đóng chi tiết ngày" onClick={closeDay}>×</button>
        </header>
        {selectedMilestones.length === 0
          ? <p className="milestone-empty-day">Ngày này chưa có dấu mốc.</p>
          : <div className="milestone-day-dialog-list">{selectedMilestones.map((card) => <MilestoneButton key={card.id} milestone={card} onEdit={editFromDay} />)}</div>}
        <footer className="milestone-day-dialog-actions">
          <button type="button" disabled={!canWrite} onClick={() => {
            const date = selectedDate;
            dayDialog.current?.close();
            setSelectedDate(null);
            onAddMilestone(date);
          }}>Thêm dấu mốc</button>
          <button type="button" className="milestone-open-work-week" onClick={() => {
            const date = selectedDate;
            dayDialog.current?.close();
            setSelectedDate(null);
            onOpenWorkWeek(date);
          }}>Mở tuần công việc</button>
        </footer>
      </>}
    </dialog>
  </section>;
}
