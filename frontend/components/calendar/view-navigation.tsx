"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { moveAnchor, parseViewState, readPreference, serializeViewState, todayInUtc7, writePreference, type CalendarKind, type MilestoneScale, type ViewState } from "../../lib/calendar/view-state";

// Temporary route controls; the shared widget can consume the same view-state API.
export function CalendarViewNavigation({ calendar }: { calendar: CalendarKind }): React.JSX.Element | null {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [view, setView] = useState<ViewState | null>(null);
  const query = search.toString();

  useEffect(() => {
    let saved = null;
    try { saved = readPreference(calendar, window.sessionStorage); } catch { /* Storage may be disabled. */ }
    const next = parseViewState(pathname, new URLSearchParams(query), new Date(), saved);
    setView(next);

    const save = () => {
      try { writePreference(calendar, { anchor: next.anchor, scale: next.scale, scrollY: window.scrollY }, window.sessionStorage); } catch { /* Storage may be disabled. */ }
    };
    // Make the initial resolved view part of this history entry before preferences change.
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

  if (!view) return null;
  const navigate = (next: ViewState) => router.push(serializeViewState(next), { scroll: false });
  return (
    <nav aria-label="Điều hướng lịch">
      <Link href="/work" scroll={false}>Lịch công việc</Link>{" "}
      <Link href="/milestones" scroll={false}>Lịch dấu mốc</Link>{" "}
      <button type="button" onClick={() => navigate(moveAnchor(view, -1))}>Lùi</button>{" "}
      <button type="button" onClick={() => navigate({ ...view, anchor: todayInUtc7(new Date()) })}>Hôm nay</button>{" "}
      <button type="button" onClick={() => navigate(moveAnchor(view, 1))}>Tiến</button>{" "}
      <label>Ngày đang xem <input type="date" value={view.anchor} onChange={event => {
        const next = parseViewState(pathname, new URLSearchParams({ date: event.target.value, scale: view.scale }), new Date(), null);
        navigate(next);
      }} /></label>{" "}
      {calendar === "milestones" && <label>Quy mô <select value={view.scale} onChange={event => navigate({ ...view, scale: event.target.value as MilestoneScale })}>
        <option value="week">Tuần</option><option value="month">Tháng</option><option value="year">Năm</option>
      </select></label>}
    </nav>
  );
}
