export function workWeekDates(anchor: string): Array<string | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || anchor < "0001-01-01" || anchor > "9999-12-31") {
    return Array.from({ length: 7 }, () => null);
  }
  const date = new Date(`${anchor}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== anchor) {
    return Array.from({ length: 7 }, () => null);
  }
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(date.getTime());
    day.setUTCDate(day.getUTCDate() + index);
    const year = day.getUTCFullYear();
    if (year < 1 || year > 9999) return null;
    return day.toISOString().slice(0, 10);
  });
}
