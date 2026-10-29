"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { parseViewState, readPreference, serializeViewState, writePreference, type CalendarKind, type ViewState } from "../../lib/calendar/view-state";
import { CalendarWidget, currentPeriod } from "./calendar-widget";

export type CalendarViewProps = { calendar: CalendarKind };

export function CalendarView({ calendar }: CalendarViewProps): React.JSX.Element {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [view, setView] = useState<ViewState | null>(null);
  const query = search.toString();

  useEffect(() => {
    document.getElementById("calendar-main")?.focus({ preventScroll: true });
  }, [calendar]);

  useEffect(() => {
    let saved = null;
    try { saved = readPreference(calendar, window.sessionStorage); } catch { /* Storage may be disabled. */ }
    const next = parseViewState(pathname, new URLSearchParams(query), new Date(), saved);
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

  const navigate = (next: ViewState) => router.push(serializeViewState(next), { scroll: false });
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
    {view && <CalendarWidget calendar={calendar} view={view} onNavigate={navigate} onSwitch={switchCalendar} />}
  </>;
}
