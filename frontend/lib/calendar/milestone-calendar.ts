const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function toCalendarDate(date: Date): string | null {
  const year = date.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Return a Monday-first month grid, padded to six weeks when requested. */
export function milestoneMonthDates(year: number, monthIndex: number, sixWeeks = false): Array<string | null> {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR ||
      !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) return [];

  const first = utcDate(year, monthIndex, 1);
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const daysInMonth = utcDate(year, monthIndex + 1, 0).getUTCDate();
  const cellCount = sixWeeks ? 42 : Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  const gridStart = utcDate(year, monthIndex, 1 - mondayOffset);

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(gridStart.getTime());
    date.setUTCDate(date.getUTCDate() + index);
    return toCalendarDate(date);
  });
}

export function milestoneMonthAnchor(year: number, monthIndex: number, day = 1): string | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const date = utcDate(year, monthIndex, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) return null;
  return toCalendarDate(date);
}
