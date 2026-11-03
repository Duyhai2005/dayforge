"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { todayInUtc7 } from "../../lib/calendar/view-state";
import { workWeekDates } from "../../lib/calendar/work-week";
import { semanticRootHash, workItemsForDates, type ColorId, type MilestoneData, type MilestoneRoot, type Period, type ProjectionState, type WorkItemCard } from "../../lib/sync/reducer";
import type { UUID } from "../../lib/sync/protocol";
import { useAccount } from "../account/account-provider";
import { CALENDAR_COLORS } from "./plan-manager";
import type { TaskEditorTarget } from "./task-editor";
import type { MilestoneEditorTarget } from "./milestone-editor";

const PERIODS: ReadonlyArray<{ id: Period; name: string }> = [
  { id: "morning", name: "Sáng" },
  { id: "afternoon", name: "Chiều" },
  { id: "evening", name: "Tối" },
];

type WorkCard = WorkItemCard;
type WorkMilestone = { id: UUID; data: MilestoneData; root: MilestoneRoot };
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

function milestonesForWeek(projection: ProjectionState | null, dates: ReadonlyArray<string | null>): WorkMilestone[] {
  if (!projection) return [];
  const visibleDates = new Set(dates.filter((date): date is string => date !== null));
  return Object.entries(projection.roots)
    .filter((entry): entry is [string, MilestoneRoot] => entry[0].startsWith("milestone:") && !entry[1].deleted &&
      "data" in entry[1] && "show_in_work_calendar" in entry[1].data && entry[1].data.show_in_work_calendar)
    .map(([key, root]) => ({ id: key.slice("milestone:".length) as UUID, data: root.data, root }))
    .filter((milestone) => visibleDates.has(milestone.data.date))
    .sort((left, right) => left.data.title.localeCompare(right.data.title, "vi") || left.id.localeCompare(right.id));
}

function colorForTask(projection: ProjectionState | null, data: { plan_id: UUID | null; standalone_color_id: ColorId }) {
  const plan = data.plan_id ? projection?.roots[`plan:${data.plan_id}`] : null;
  const colorId = plan && !("kind" in plan) && !plan.deleted && "color_id" in plan.data ? plan.data.color_id : data.standalone_color_id;
  return CALENDAR_COLORS.find((color) => color.id === colorId) ?? CALENDAR_COLORS[0];
}

export type WorkWeekCalendarProps = {
  anchor: string;
  onAddTask(date: string, period: Period): void;
  onEditTask(target: TaskEditorTarget): void;
  onAddMilestone(date: string): void;
  onEditMilestone(target: MilestoneEditorTarget): void;
  onMoveTask(target: TaskEditorTarget, date: string, period: Period, beforeTaskId: UUID | null): Promise<void>;
};

type DropPreview = { taskId: UUID; date: string; period: Period; beforeTaskId: UUID | null };

function millisecondsUntilNextUtc7Midnight(now: Date): number {
  const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const nextMidnightUtc = Date.UTC(utc7Now.getUTCFullYear(), utc7Now.getUTCMonth(), utc7Now.getUTCDate() + 1) - 7 * 60 * 60 * 1000;
  return Math.max(1, nextMidnightUtc - now.getTime());
}

export function WorkWeekCalendar({ anchor, onAddTask, onEditTask, onAddMilestone, onEditMilestone, onMoveTask }: WorkWeekCalendarProps): React.JSX.Element {
  const account = useAccount();
  const [draggedTaskId, setDraggedTaskId] = useState<UUID | null>(null);
  const [cards, setCards] = useState<WorkCard[]>([]);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [today, setToday] = useState(() => todayInUtc7(new Date()));
  const [relatedDay, setRelatedDay] = useState<string | null>(null);
  const [settledTaskId, setSettledTaskId] = useState<UUID | null>(null);
  const draggedTaskRef = useRef<UUID | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const updateToday = () => setToday(todayInUtc7(new Date()));
    const timer = window.setTimeout(updateToday, millisecondsUntilNextUtc7Midnight(new Date()) + 25);
    window.addEventListener("focus", updateToday);
    document.addEventListener("visibilitychange", updateToday);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", updateToday);
      document.removeEventListener("visibilitychange", updateToday);
    };
  }, [today]);
  const dates = useMemo(() => workWeekDates(anchor), [anchor]);
  const days = useMemo(() => dates.map(weekDayFor), [dates]);
  const projection = account.state === "unlocked" && account.calendarReady ? account.calendarProjection : null;
  useEffect(() => {
    let target: string | null = null;
    try {
      target = window.sessionStorage.getItem("dayforge:related-work-day:v1");
      if (target && !dates.includes(target)) window.sessionStorage.removeItem("dayforge:related-work-day:v1");
    } catch {
      return;
    }
    if (!target || !dates.includes(target)) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        if (window.sessionStorage.getItem("dayforge:related-work-day:v1") === target) {
          window.sessionStorage.removeItem("dayforge:related-work-day:v1");
        }
      } catch { /* The hint is visual state only. */ }
      setRelatedDay(target);
    });
    const timer = window.setTimeout(() => setRelatedDay((current) => current === target ? null : current), 520);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [anchor, dates]);
  useEffect(() => {
    if (!settledTaskId) return;
    const taskId = settledTaskId;
    const timer = window.setTimeout(() => setSettledTaskId((current) => current === taskId ? null : current), 180);
    return () => window.clearTimeout(timer);
  }, [settledTaskId]);
  useEffect(() => {
    let current = true;
    void workItemsForDates(projection, dates).then((items) => {
      if (current) setCards(items);
    }).catch((cause: unknown) => {
      if (current) setMoveError(cause instanceof Error ? cause.message : "Không thể khai triển công việc trong tuần này.");
    });
    return () => { current = false; };
  }, [projection, dates]);
  const milestones = useMemo(() => milestonesForWeek(projection, dates), [projection, dates]);
  const cardsByBucket = useMemo(() => {
    const grouped = new Map<string, WorkCard[]>();
    for (const card of cards) {
      const key = `${card.data.date}:${card.data.period}`;
      grouped.set(key, [...(grouped.get(key) ?? []), card]);
    }
    return grouped;
  }, [cards]);
  const milestonesByDate = useMemo(() => {
    const grouped = new Map<string, WorkMilestone[]>();
    for (const milestone of milestones) grouped.set(milestone.data.date, [...(grouped.get(milestone.data.date) ?? []), milestone]);
    return grouped;
  }, [milestones]);
  const ready = account.state === "unlocked" && account.calendarReady;

  async function editTask(card: WorkCard): Promise<void> {
    const expectedRootHash = await semanticRootHash({ kind: "work_item", id: card.root_id }, card.root);
    onEditTask({ id: card.root_id, data: card.data, expectedRootHash, target: card.target, root: card.root });
  }

  async function editMilestone(milestone: WorkMilestone): Promise<void> {
    const expectedRootHash = await semanticRootHash({ kind: "milestone", id: milestone.id }, milestone.root);
    onEditMilestone({ id: milestone.id, data: milestone.data, expectedRootHash });
  }

  async function toggleTaskStatus(card: WorkCard): Promise<void> {
    try {
      setMoveError(null);
      const expectedRootHash = await semanticRootHash({ kind: "work_item", id: card.root_id }, card.root);
      const status = card.data.status === "completed" ? "pending" : "completed";
      await account.changeWorkItemStatus(card.root_id, card.target, { ...card.data, status }, expectedRootHash);
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : "Không thể đổi trạng thái công việc.");
    }
  }

  async function moveTask(card: WorkCard, date: string, period: Period, beforeTaskId: UUID | null): Promise<void> {
    try {
      setMoveError(null);
      if (beforeTaskId === card.id) return;
      const destinationCards = cards.filter((entry) => entry.data.date === date && entry.data.period === period);
      const remaining = destinationCards.filter((entry) => entry.id !== card.id);
      const insertionIndex = beforeTaskId === null ? remaining.length : remaining.findIndex((entry) => entry.id === beforeTaskId);
      if (insertionIndex < 0) throw new Error("Vị trí nhận đã thay đổi. Hãy thử thao tác lại.");
      const nextIds = remaining.map((entry) => entry.id);
      nextIds.splice(insertionIndex, 0, card.id);
      const sameBucket = card.data.date === date && card.data.period === period;
      const currentIds = destinationCards.map((entry) => entry.id);
      if (sameBucket && currentIds.length === nextIds.length && currentIds.every((entry, index) => entry === nextIds[index])) return;
      const expectedRootHash = await semanticRootHash({ kind: "work_item", id: card.root_id }, card.root);
      await onMoveTask({ id: card.root_id, data: card.data, expectedRootHash, target: card.target, root: card.root }, date, period, beforeTaskId);
      setSettledTaskId(card.id);
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : "Không thể đổi lịch công việc.");
    }
  }

  function insertionBefore(bucket: HTMLDivElement, clientY: number, taskId: UUID): UUID | null {
    const entries = [...bucket.querySelectorAll<HTMLElement>(".work-task-entry[data-work-item-id]")];
    for (const entry of entries) {
      const entryId = entry.dataset.workItemId as UUID | undefined;
      if (!entryId || entryId === taskId) continue;
      const bounds = entry.getBoundingClientRect();
      if (clientY < bounds.top + bounds.height / 2) return entryId;
    }
    return null;
  }

  function previewFor(event: React.DragEvent<HTMLDivElement>, taskId: UUID): DropPreview | null {
    const date = event.currentTarget.dataset.workDate;
    const period = event.currentTarget.dataset.period as Period | undefined;
    if (!date || !period) return null;
    return { taskId, date, period, beforeTaskId: insertionBefore(event.currentTarget, event.clientY, taskId) };
  }

  function showPreview(next: DropPreview | null): void {
    setDropPreview((current) => current?.taskId === next?.taskId && current?.date === next?.date &&
      current?.period === next?.period && current?.beforeTaskId === next?.beforeTaskId ? current : next);
  }

  function handleDragStart(event: React.DragEvent<HTMLButtonElement>, card: WorkCard): void {
    if (!ready) { event.preventDefault(); return; }
    draggedTaskRef.current = card.id;
    setDraggedTaskId(card.id);
    setMoveError(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.id);
    const dragImage = document.createElement("div");
    dragImage.className = "work-task-drag-preview";
    dragImage.textContent = card.data.title;
    document.body.appendChild(dragImage);
    event.dataTransfer.setDragImage(dragImage, 12, 16);
    window.setTimeout(() => dragImage.remove(), 0);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    const taskId = draggedTaskRef.current;
    if (!ready || !taskId) return;
    const next = previewFor(event, taskId);
    if (!next) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    showPreview(next);
    const scrollDelta = event.clientY < 72 ? -10 : event.clientY > window.innerHeight - 72 ? 10 : 0;
    if (scrollDelta !== 0 && autoScrollFrameRef.current === null) {
      autoScrollFrameRef.current = window.requestAnimationFrame(() => {
        window.scrollBy(0, scrollDelta);
        autoScrollFrameRef.current = null;
      });
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    const taskId = draggedTaskRef.current;
    if (!taskId) return;
    event.preventDefault();
    const preview = previewFor(event, taskId);
    draggedTaskRef.current = null;
    setDraggedTaskId(null);
    setDropPreview(null);
    const card = cards.find((entry) => entry.id === taskId);
    if (!preview || !card || preview.beforeTaskId === taskId) return;
    void moveTask(card, preview.date, preview.period, preview.beforeTaskId);
  }

  function handleDragEnd(): void {
    draggedTaskRef.current = null;
    setDraggedTaskId(null);
    setDropPreview(null);
    if (autoScrollFrameRef.current !== null) window.cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropPreview((current) => current && current.date === event.currentTarget.dataset.workDate && current.period === event.currentTarget.dataset.period ? null : current);
  }

  function keyboardMove(card: WorkCard, index: number, taskCards: WorkCard[], direction: -1 | 1): void {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= taskCards.length) return;
    const beforeTaskId = direction < 0
      ? taskCards[targetIndex].id
      : taskCards[targetIndex + 1]?.id ?? null;
    void moveTask(card, card.data.date, card.data.period, beforeTaskId);
  }

  return <section className="work-week" aria-label="Lịch công việc theo tuần">
    <p id="work-week-move-help" className="work-week-move-help">Kéo thẻ công việc để đổi ngày, buổi hoặc vị trí. Dùng các nút Sắp xếp bằng bàn phím; mở thẻ để đổi ngày và buổi trong biểu mẫu.</p>
    <p className="sr-only" role="status" aria-live="polite">{dropPreview ? `Điểm thả: ${days.find((day) => day.date === dropPreview.date)?.weekday ?? dropPreview.date}, buổi ${PERIODS.find((period) => period.id === dropPreview.period)?.name.toLocaleLowerCase("vi") ?? ""}${dropPreview.beforeTaskId ? ", trước công việc được chọn" : ", cuối danh sách"}.` : draggedTaskId ? "Đang kéo công việc. Thả vào một buổi trong tuần đang xem hoặc nhấn Escape để hủy." : ""}</p>
    {moveError && <p className="work-week-message account-error" role="alert">{moveError}</p>}
    <div className="work-week-days">
      {days.map((day, index) => <div key={day.date ?? `outside-${index}`} className="work-week-day-heading" data-today={day.date === today} data-related-day={day.date === relatedDay || undefined}>
        <h2>{day.weekday}</h2>
        <p>{day.dateLabel}</p>
      </div>)}
    </div>

    <section className="work-week-all-day" aria-labelledby="work-period-all-day">
      <h2 id="work-period-all-day" className="work-week-period-title">Cả ngày</h2>
      <div className="work-week-all-day-buckets">
        {days.map((day, index) => {
          const dayName = day.date ? `${day.weekday} ${day.dateLabel}` : day.dateLabel;
          const allDayMilestones = day.date ? (milestonesByDate.get(day.date) ?? []).filter((item) => item.data.period === null) : [];
          return <div key={day.date ?? `outside-${index}`} className="work-week-all-day-bucket" data-work-date={day.date ?? undefined}>
            {allDayMilestones.map((milestone) => {
              const color = colorForTask(projection, milestone.data);
              return <button key={milestone.id} type="button" className="work-task-card work-milestone-card" data-milestone-id={milestone.id} data-work-date={milestone.data.date}
                style={{ backgroundColor: color.background, color: color.foreground }} aria-label={`${milestone.data.title}, Dấu mốc${milestone.data.note ? ", Có ghi chú" : ""}`}
                onClick={() => void editMilestone(milestone)}>
                <span className="work-task-title">{milestone.data.title}</span>
                <span className="work-task-meta">Dấu mốc{milestone.data.note && " · ▤ Có ghi chú"}</span>
              </button>;
            })}
            <button type="button" className="work-week-add work-milestone-add" disabled={!ready || !day.date}
              aria-label={`Thêm dấu mốc cả ngày ${dayName}`} onClick={() => { if (day.date) onAddMilestone(day.date); }}>+</button>
          </div>;
        })}
      </div>
    </section>

    {PERIODS.map((period) => <section key={period.id} className={`work-week-period work-week-period-${period.id}`} aria-labelledby={`work-period-${period.id}`}>
      <h2 id={`work-period-${period.id}`} className="work-week-period-title">{period.name}</h2>
      <div className="work-week-buckets">
        {days.map((day, index) => {
          const dayName = day.date ? `${day.weekday} ${day.dateLabel}` : day.dateLabel;
          const taskCards = day.date ? cardsByBucket.get(`${day.date}:${period.id}`) ?? [] : [];
          const periodMilestones = day.date ? (milestonesByDate.get(day.date) ?? []).filter((item) => item.data.period === period.id) : [];
          const isDropActive = dropPreview?.date === day.date && dropPreview.period === period.id;
          return <div key={`${day.date ?? `outside-${index}`}:${period.id}`} className="work-week-bucket" data-work-date={day.date ?? undefined} data-period={period.id}
            data-drop-active={isDropActive ? "true" : undefined} onDragOver={handleDragOver} onDrop={handleDrop} onDragLeave={handleDragLeave}>
            {isDropActive && <div className="work-task-drop-target"><span>Thả vào</span><strong>{dayName}</strong><span>Buổi {period.name.toLocaleLowerCase("vi")}</span></div>}
            {periodMilestones.map((milestone) => {
              const color = colorForTask(projection, milestone.data);
              return <button key={milestone.id} type="button" className="work-task-card work-milestone-card" data-milestone-id={milestone.id} data-work-date={milestone.data.date}
                style={{ backgroundColor: color.background, color: color.foreground }} aria-label={`${milestone.data.title}, Dấu mốc${milestone.data.note ? ", Có ghi chú" : ""}`}
                onClick={() => void editMilestone(milestone)}>
                <span className="work-task-title">{milestone.data.title}</span>
                <span className="work-task-meta">Dấu mốc{milestone.data.note && " · ▤ Có ghi chú"}</span>
              </button>;
            })}
            {taskCards.map((card, cardIndex) => {
              const color = colorForTask(projection, card.data);
              const late = card.data.status === "pending" && card.data.date < today;
              const stateLabel = card.data.status === "completed" ? "Đã hoàn thành" : late ? "Chưa hoàn thành" : "";
              const accessibleLabel = [card.data.title, card.data.duration_minutes === null ? "Chưa ước lượng" : `${card.data.duration_minutes} phút`, stateLabel].filter(Boolean).join(", ");
              const showInsertionBefore = isDropActive && dropPreview.beforeTaskId === card.id;
              return <Fragment key={card.id}>
                {showInsertionBefore && <div className="work-task-drop-marker" aria-label={`Thả trước ${card.data.title}`}><span />Thả trước {card.data.title}</div>}
                <div className="work-task-entry" data-work-item-id={card.id} data-dragging={draggedTaskId === card.id ? "true" : undefined} data-settled={settledTaskId === card.id ? "true" : undefined}>
                  <button type="button" disabled={!ready} draggable={ready} className="work-task-card" style={{ backgroundColor: color.background, color: color.foreground }} aria-label={`${accessibleLabel}${card.target.kind === "occurrence" ? ", lần lặp" : card.target.kind === "detached" ? ", việc một lần đã tách" : ""}, mở biểu mẫu để sửa`} aria-describedby="work-week-move-help"
                    onClick={() => void editTask(card)} onDragStart={(event) => handleDragStart(event, card)} onDragEnd={handleDragEnd}>
                    <span className="work-task-grip" aria-hidden="true">⠿</span>
                    <span className="work-task-title">{card.data.title}</span>
                    <span className="work-task-meta">
                      {card.data.duration_minutes === null ? "Chưa ước lượng" : `${card.data.duration_minutes} phút`}
                      {card.target.kind === "occurrence" && <span> · ↻ Lặp lại</span>}
                      {card.target.kind === "detached" && <span> · Một lần</span>}
                      {stateLabel && <span className="work-task-state">{card.data.status === "completed" ? "✓" : "◷"} {stateLabel}</span>}
                    </span>
                  </button>
                  <div className="work-task-order-actions" aria-label={"Thao tác " + card.data.title}>
                    <button type="button" className="work-task-status-toggle" disabled={!ready}
                      aria-label={"Đánh dấu " + card.data.title + " " + (card.data.status === "completed" ? "chưa hoàn thành" : "hoàn thành")}
                      aria-pressed={card.data.status === "completed"} title={card.data.status === "completed" ? "Bỏ hoàn thành" : "Đánh dấu hoàn thành"}
                      onClick={() => void toggleTaskStatus(card)}>{card.data.status === "completed" ? "↶" : "✓"}</button>
                    <button type="button" disabled={!ready || cardIndex === 0} aria-label={`Đưa ${card.data.title} lên trước`} title="Đưa lên trước" onClick={() => keyboardMove(card, cardIndex, taskCards, -1)}>↑</button>
                    <button type="button" disabled={!ready || cardIndex === taskCards.length - 1} aria-label={`Đưa ${card.data.title} xuống sau`} title="Đưa xuống sau" onClick={() => keyboardMove(card, cardIndex, taskCards, 1)}>↓</button>
                  </div>
                </div>
              </Fragment>;
            })}
            {isDropActive && dropPreview.beforeTaskId === null && <div className="work-task-drop-marker" aria-label="Thả ở cuối danh sách"><span />Thả ở cuối danh sách</div>}
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
    {ready && cards.length === 0 && milestones.length === 0 && <p className="work-week-message" role="status">Tuần này chưa có công việc hoặc dấu mốc.</p>}
  </section>;
}
