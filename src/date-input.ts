import { dayNumber } from "./core";

function calendarDate(year: number, month: number, day: number) {
  if (year < 0 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31)
    return undefined;
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return Number.isFinite(dayNumber(value)) ? value : undefined;
}

// Start from local calendar fields. dayNumber represents civil days, so adding
// days here does not depend on the length of a local day during DST changes.
export function parseHowmDate(input: string, today: Date): string | undefined {
  if (!Number.isFinite(today.getTime())) return undefined;
  const year = today.getFullYear(),
    month = today.getMonth() + 1,
    day = today.getDate();
  const base = calendarDate(year, month, day);
  if (!base) return undefined;
  const value = input.trim().toLowerCase();
  const addDays = (days: number): string | undefined => {
    const ordinal = dayNumber(base) + days;
    if (
      !Number.isSafeInteger(days) ||
      days < 0 ||
      ordinal > dayNumber("9999-12-31")
    )
      return undefined;
    return new Date(ordinal * 86400000).toISOString().slice(0, 10);
  };
  if (value === "" || value === "0" || value === "today") return base;
  if (value === "tomorrow") return addDays(1);
  if (/^\+\d+$/.test(value)) return addDays(Number(value.slice(1)));

  const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const weekday = weekdays.indexOf(value);
  if (weekday !== -1) {
    const current = new Date(dayNumber(base) * 86400000).getUTCDay();
    return addDays((weekday - current + 7) % 7);
  }

  const full = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(value);
  if (full)
    return calendarDate(Number(full[1]), Number(full[3]), Number(full[4]));

  const monthDay = /^(\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (monthDay) {
    const m = Number(monthDay[1]),
      d = Number(monthDay[2]);
    // A leap year accepts every possible month/day, including February 29.
    if (!calendarDate(2000, m, d)) return undefined;
    for (let y = year; y <= 9999; y++) {
      const candidate = calendarDate(y, m, d);
      if (candidate && candidate >= base) return candidate;
    }
    return undefined;
  }

  if (/^\d{1,2}$/.test(value)) {
    const d = Number(value);
    if (d < 1 || d > 31) return undefined;
    for (let offset = 0; offset < 12; offset++) {
      const m = month - 1 + offset;
      const candidate = calendarDate(
        year + Math.floor(m / 12),
        (m % 12) + 1,
        d,
      );
      if (candidate && candidate >= base) return candidate;
    }
  }
  return undefined;
}
