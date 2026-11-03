"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useBuildGate } from "../offline/offline-bootstrap";
import { shouldUseDocumentNavigation } from "../../lib/offline/navigation";
import { parseViewState, readPreference, serializeViewState, writePreference, type CalendarKind, type ViewState } from "../../lib/calendar/view-state";
import { CalendarWidget, currentPeriod } from "./calendar-widget";
import { PlanManager } from "./plan-manager";
import { TaskEditor, type TaskEditorTarget } from "./task-editor";
import { WorkWeekCalendar } from "./work-week-calendar";
import { MilestoneEditor, type MilestoneEditorTarget } from "./milestone-editor";
import { MilestoneCalendar } from "./milestone-calendar";
import type { Period } from "../../lib/sync/reducer";
import { useAccount } from "../account/account-provider";

export type CalendarViewProps = { calendar: CalendarKind };

export function CalendarView({ calendar }: CalendarViewProps): React.JSX.Element {
  const account = useAccount();
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const { gate } = useBuildGate();
  const [view, setView] = useState<ViewState | null>(null);
  const [planManagerOpen, setPlanManagerOpen] = useState(false);
  const [taskEditor, setTaskEditor] = useState<{ date: string; period: Period | null; editing?: TaskEditorTarget } | null>(null);
  const [milestoneEditor, setMilestoneEditor] = useState<{ date: string; editing?: MilestoneEditorTarget } | null>(null);
  const query = search.toString();

  useEffect(() => {
    document.getElementById("calendar-main")?.focus({ preventScroll: true });
  }, [calendar]);

  useEffect(() => {
    let saved = null;
    try { saved = readPreference(calendar, window.sessionStorage); } catch { /* Storage may be disabled. */ }
    const next = parseViewState(pathname, new URLSearchParams(query), new Date(), saved);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Client preference from sessionStorage is read on mount and route change
    setView(next);
    const save = () => {
      try { writePreference(calendar, { anchor: next.anchor, scale: next.scale, scrollY: window.scrollY }, window.sessionStorage); } catch { /* Storage may be disabled. */ }
    };
    const canonical = serializeViewState(next);
    if (`${pathname}?${query}` !== canonical) router.replace(canonical, { scroll: false });
    const frame = requestAnimationFrame(() => {
      if (saved && saved.anchor === next.anchor && saved.scale === next.scale) window.scrollTo(0, saved.scrollY);
      save();
    });
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", save);
      window.removeEventListener("pagehide", save);
    };
  }, [calendar, pathname, query, router]);

  useEffect(() => {
    let handlingPopState = false;
    const handlePopState = () => {
      if (handlingPopState) return;
      handlingPopState = true;
      void shouldUseDocumentNavigation(gate).then((useDocument) => {
        if (useDocument) window.location.reload();
      }).finally(() => { handlingPopState = false; });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [gate]);

  useEffect(() => {
    const onWorkerMessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; href?: string } | null;
      if (message?.type !== "DAYFORGE_DOCUMENT_NAVIGATION_REQUIRED" || typeof message.href !== "string") return;
      try {
        const target = new URL(message.href, window.location.href);
        if (target.origin !== window.location.origin ||
            (target.pathname !== "/work" && target.pathname !== "/milestones")) return;
        // This must be a document load because the router cannot consume the rejected Flight response.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign(`${target.pathname}${target.search}${target.hash}`);
      } catch {
        // Ignore malformed worker navigation hints; they never carry app data.
      }
    };
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
  }, []);

  const navigate = (next: ViewState) => {
    const href = serializeViewState(next);
    void shouldUseDocumentNavigation(gate).then((useDocument) => {
      if (useDocument) window.location.assign(href);
      else router.push(href, { scroll: false });
    });
  };
  const switchCalendar = (nextCalendar: CalendarKind) => {
    let saved = null;
    try { saved = readPreference(nextCalendar, window.sessionStorage); } catch { /* Storage may be disabled. */ }
    navigate(parseViewState(`/${nextCalendar}`, new URLSearchParams(), new Date(), saved));
  };

  return <>
    <header className="calendar-heading">
      <p className="calendar-kicker">DAYFORGE · UTC+07:00</p>
      <h1 id="calendar-title">{calendar === "work" ? "Lịch công việc" : "Lịch dấu mốc"}</h1>
      {view && <p key={`${calendar}:${view.anchor}:${view.scale}`} className="calendar-period" aria-label="Khoảng đang xem" aria-live="polite">{currentPeriod(view)}</p>}
    </header>
    {view && <CalendarWidget calendar={calendar} view={view} onNavigate={navigate} onSwitch={switchCalendar} onOpenPlans={() => setPlanManagerOpen(true)} onAddTask={(date, period) => setTaskEditor({ date, period })} onAddMilestone={(date) => setMilestoneEditor({ date })} />}
    {view && calendar === "work" && <WorkWeekCalendar anchor={view.anchor}
      onAddTask={(date, period) => setTaskEditor({ date, period })}
      onEditTask={(editing) => setTaskEditor({ date: editing.data.date, period: editing.data.period, editing })}
      onAddMilestone={(date) => setMilestoneEditor({ date })}
      onEditMilestone={(editing) => setMilestoneEditor({ date: editing.data.date, editing })}
      onMoveTask={async (target, date, period, beforeTaskId) => {
        await account.repositionTask(target.id, { ...target.data, date, period }, target.expectedRootHash, beforeTaskId);
      }} />}
    {view && calendar === "milestones" && <MilestoneCalendar anchor={view.anchor} scale={view.scale}
      onNavigate={navigate}
      onEditMilestone={(editing) => setMilestoneEditor({ date: editing.data.date, editing })}
      onAddMilestone={(date) => setMilestoneEditor({ date })}
      onOpenWorkWeek={(date) => navigate({ calendar: "work", anchor: date, scale: "week" })} />}
    <PlanManager open={planManagerOpen} onClose={() => setPlanManagerOpen(false)} />
    {taskEditor && <TaskEditor key={`${taskEditor.date}:${taskEditor.period ?? "any"}:${taskEditor.editing?.id ?? "new"}`} open date={taskEditor.date} period={taskEditor.period} editing={taskEditor.editing} onClose={() => setTaskEditor(null)} />}
    {milestoneEditor && <MilestoneEditor key={`${milestoneEditor.date}:${milestoneEditor.editing?.id ?? "new"}`} open date={milestoneEditor.date} editing={milestoneEditor.editing} onClose={() => setMilestoneEditor(null)} />}
  </>;
}
