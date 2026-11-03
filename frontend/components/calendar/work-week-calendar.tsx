"use client";

import { useMemo } from "react";
import { todayInUtc7 } from "../../lib/calendar/view-state";
import { workWeekDates } from "../../lib/calendar/work-week";
import { semanticRootHash, type Period, type ProjectionState, type SingleWorkRoot, type TaskData } from "../../lib/sync/reducer";
import type { UUID } from "../../lib/sync/protocol";
import { useAccount } from "../account/account-provider";
import { CALENDAR_COLORS } from "./plan-manager";
import type { TaskEditorTarget } from "./task-editor";

const PERIODS: ReadonlyArray<{ id: Period; name: string }> = [
  { id: "morning", name: "Sáng" },
  { id: "afternoon", name: "Chiều" },
  { id: "evening", name: "Tối" },
];

type WorkCard = { id: UUID; data: TaskData; root: SingleWorkRoot };
type WeekDay = { date: string | null; weekday: string; dateLabel: string };

function weekDayFor(date: string | null, index: number): WeekDay {
  if (!date) return { date: null, weekday: `Ngày ${index + 1}`, dateLabel: "Ngoài phạm vi ngày" };
  const value = new Date(`${date}T00:00:00.000Z`);
  return {
    date,
    weekday: new Intl.DateTimeFormat("vi-VN", { weekday: "long", timeZone: "UTC" }).format(value),
    dateLabel: new Intl.DateTimeFormat("vi-VN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(value),
  };
}

function workCardsForWeek(projection: ProjectionState | null, dates: ReadonlyArray<string | null>): WorkCard[] {
  if (!projection) return [];
  const visibleDates = new Set(dates.filter((date): date is string => date !== null));
  const cards: WorkCard[] = [];
  for (const [key, value] of Object.entries(projection.roots)) {
    if (!key.startsWith("work_item:") || value.deleted || !("kind" in value) || value.kind !== "single") continue;
    if (!visibleDates.has(value.single.date)) continue;
    cards.push({ id: key.slice("work_item:".length) as UUID, data: value.single, root: value });
  }
  cards.sort((left, right) => {
    const leftRank = BigInt(left.data.order_key);
    const rightRank = BigInt(right.data.order_key);
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return cards;
}

function colorForTask(projection: ProjectionState | null, data: TaskData) {
  const plan = data.plan_id ? projection?.roots[`plan:${data.plan_id}`] : null;
  const colorId = plan && !("kind" in plan) && !plan.deleted && "color_id" in plan.data ? plan.data.color_id : data.standalone_color_id;
  return CALENDAR_COLORS.find((color) => color.id === colorId) ?? CALENDAR_COLORS[0];
}

function periodName(period: Period): string {
  return PERIODS.find((item) => item.id === period)?.name ?? "";
}

export type WorkWeekCalendarProps = {
  anchor: string;
  onAddTask(date: string, period: Period): void;
  onEditTask(target: TaskEditorTarget): void;
};

export function WorkWeekCalendar({ anchor, onAddTask, onEditTask }: WorkWeekCalendarProps): React.JSX.Element {
  const account = useAccount();
  const dates = useMemo(() => workWeekDates(anchor), [anchor]);
  const days = useMemo(() => dates.map(weekDayFor), [dates]);
  const projection = account.state === "unlocked" && account.calendarReady ? account.calendarProjection : null;
  const cards = useMemo(() => workCardsForWeek(projection, dates), [projection, dates]);
  const cardsByBucket = useMemo(() => {
    const grouped = new Map<string, WorkCard[]>();
    for (const card of cards) {
      const key = `${card.data.date}:${card.data.period}`;
      grouped.set(key, [...(grouped.get(key) ?? []), card]);
    }
    return grouped;
  }, [cards]);
  const ready = account.state === "unlocked" && account.calendarReady;
  const today = todayInUtc7(new Date());

  async function editTask(card: WorkCard): Promise<void> {
    const expectedRootHash = await semanticRootHash({ kind: "work_item", id: card.id }, card.root);
    onEditTask({ id: card.id, data: card.data, expectedRootHash });
  }

  return <section className="work-week" aria-label="Lịch công việc theo tuần">
    <div className="work-week-days">
      {days.map((day, index) => <div key={day.date ?? `outside-${index}`} className="work-week-day-heading" data-today={day.date === today}>
        <h2>{day.weekday}</h2>
        <p>{day.dateLabel}</p>
      </div>)}
    </div>

    {PERIODS.map((period) => <section key={period.id} className={`work-week-period work-week-period-${period.id}`} aria-labelledby={`work-period-${period.id}`}>
      <h2 id={`work-period-${period.id}`} className="work-week-period-title">{period.name}</h2>
      <div className="work-week-buckets">
        {days.map((day, index) => {
          const dayName = day.date ? `${day.weekday} ${day.dateLabel}` : day.dateLabel;
          const taskCards = day.date ? cardsByBucket.get(`${day.date}:${period.id}`) ?? [] : [];
          return <div key={`${day.date ?? `outside-${index}`}:${period.id}`} className="work-week-bucket" data-work-date={day.date ?? undefined} data-period={period.id}>
            {taskCards.map((card) => {
              const color = colorForTask(projection, card.data);
              const late = card.data.status === "pending" && card.data.date < today;
              const stateLabel = card.data.status === "completed" ? "Đã hoàn thành" : late ? "Chưa hoàn thành" : "";
              const accessibleLabel = [card.data.title, card.data.duration_minutes === null ? "Chưa ước lượng" : `${card.data.duration_minutes} phút`, stateLabel].filter(Boolean).join(", ");
              return <button key={card.id} type="button" className="work-task-card" data-work-item-id={card.id} style={{ backgroundColor: color.background, color: color.foreground }} aria-label={accessibleLabel} onClick={() => void editTask(card)}>
                <span className="work-task-title">{card.data.title}</span>
                <span className="work-task-meta">
                  {card.data.duration_minutes === null ? "Chưa ước lượng" : `${card.data.duration_minutes} phút`}
                  {stateLabel && <span className="work-task-state">{card.data.status === "completed" ? "✓" : "◷"} {stateLabel}</span>}
                </span>
              </button>;
            })}
            <button type="button" className="work-week-add" disabled={!ready || !day.date} aria-label={`Thêm công việc buổi ${period.name.toLocaleLowerCase("vi")} ngày ${dayName}`} onClick={() => {
              if (day.date) onAddTask(day.date, period.id);
            }}>+</button>
          </div>;
        })}
      </div>
    </section>)}

    {account.state !== "unlocked" && <p className="work-week-message" role="status">Mở khóa kho local để xem công việc.</p>}
    {account.state === "unlocked" && account.calendarError && <p className="work-week-message account-error" role="alert">{account.calendarError}</p>}
    {account.state === "unlocked" && !account.calendarReady && !account.calendarError && <p className="work-week-message" role="status">Đang đọc công việc trên thiết bị…</p>}
    {ready && cards.length === 0 && <p className="work-week-message" role="status">Tuần này chưa có công việc.</p>}
  </section>;
}
