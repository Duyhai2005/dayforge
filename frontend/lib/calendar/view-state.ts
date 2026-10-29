export type CalendarKind = "work" | "milestones";
export type MilestoneScale = "week" | "month" | "year";
export type ViewState = { calendar: CalendarKind; anchor: string; scale: MilestoneScale };
export type ViewPreference = { anchor: string; scale: MilestoneScale; scrollY: number };
export const MIN_CALENDAR_DATE = "0001-01-01";
export const MAX_CALENDAR_DATE = "9999-12-31";

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value < MIN_CALENDAR_DATE || value > MAX_CALENDAR_DATE) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function scale(value: unknown): value is MilestoneScale {
  return value === "week" || value === "month" || value === "year";
}
function validPreference(value: unknown, calendar: CalendarKind): value is ViewPreference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ViewPreference>;
  return calendarDate(candidate.anchor) && scale(candidate.scale) &&
    (calendar !== "work" || candidate.scale === "week") &&
    typeof candidate.scrollY === "number" && Number.isFinite(candidate.scrollY) && candidate.scrollY >= 0;
}
export function todayInUtc7(now: Date): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function parseViewState(pathname: string, search: URLSearchParams, now: Date, preference: ViewPreference | null): ViewState {
  const calendar: CalendarKind = pathname === "/milestones" ? "milestones" : "work";
  const saved = validPreference(preference, calendar) ? preference : null;
  const date = search.get("date");
  const requestedScale = search.get("scale");
  return {
    calendar,
    anchor: search.has("date") ? (calendarDate(date) ? date : todayInUtc7(now)) : saved?.anchor ?? todayInUtc7(now),
    scale: calendar === "work" ? "week" : search.has("scale") ? (scale(requestedScale) ? requestedScale : "month") : saved?.scale ?? "month",
  };
}
export function readPreference(calendar: CalendarKind, storage: Storage): ViewPreference | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(`dayforge:view:v1:${calendar}`) ?? "null");
    if (!validPreference(value, calendar)) return null;
    return { anchor: value.anchor, scale: value.scale, scrollY: value.scrollY };
  } catch { return null; }
}
export function writePreference(calendar: CalendarKind, preference: ViewPreference, storage: Storage): void {
  try {
    const value = {
      anchor: preference.anchor,
      scale: calendar === "work" ? "week" as const : preference.scale,
      scrollY: Number.isFinite(preference.scrollY) ? Math.max(0, Math.round(preference.scrollY)) : 0,
    };
    if (validPreference(value, calendar)) storage.setItem(`dayforge:view:v1:${calendar}`, JSON.stringify(value));
  } catch { /* View preferences must never block navigation. */ }
}
export function serializeViewState(view: ViewState): string {
  const search = new URLSearchParams({ date: view.anchor });
  if (view.calendar === "milestones") search.set("scale", view.scale);
  return `/${view.calendar}?${search.toString()}`;
}
export function moveAnchor(view: ViewState, direction: -1 | 1): ViewState {
  const date = new Date(`${view.anchor}T00:00:00.000Z`);
  if (view.calendar === "work" || view.scale === "week") date.setUTCDate(date.getUTCDate() + direction * 7);
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    if (view.scale === "month") date.setUTCMonth(date.getUTCMonth() + direction);
    else date.setUTCFullYear(date.getUTCFullYear() + direction);
    const last = new Date(date.getTime());
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, last.getUTCDate()));
  }
  const anchor = date.toISOString().slice(0, 10);
  return calendarDate(anchor) ? { ...view, anchor } : view;
}
