import { Note, Reminder, dayNumber, noteDisplayDate } from "./core";

export interface CalendarDay {
  date: string;
  notes: Note[];
  reminders: { note: Note; reminder: Reminder }[];
}

export function calendarDays(notes: Note[]): Map<string, CalendarDay> {
  const days = new Map<string, CalendarDay>();
  const get = (date: string) => {
    let day = days.get(date);
    if (!day) {
      day = { date, notes: [], reminders: [] };
      days.set(date, day);
    }
    return day;
  };
  for (const note of notes) {
    const dates = new Set([noteDisplayDate(note).date]);
    for (const reminder of note.reminders) {
      if (reminder.kind === ".") continue;
      get(reminder.date).reminders.push({ note, reminder });
      dates.add(reminder.date);
    }
    for (const date of dates) get(date).notes.push(note);
  }
  return days;
}

export function calendarNoteText(note: Note, date: string): string {
  const reminders = note.reminders.filter(
    (reminder) => reminder.date === date && reminder.kind !== ".",
  );
  if (reminders.length)
    return reminders.map((reminder) => reminder.text || note.title).join("\n");

  for (let index = 0; index < note.active.length; index++) {
    const timestamp =
      /^\s*\[(\d{4}-\d{2}-\d{2})(?: (?:[01]\d|2[0-3]):[0-5]\d)?\](?![@+!~.\-])/.exec(
        note.active[index],
      );
    if (timestamp?.[1] === date) {
      const text = note.lines[index].slice(timestamp[0].length).trim();
      if (text) return text;
    }
  }
  return note.title;
}

// UTC arithmetic keeps month grids independent of daylight-saving changes.
export type CalendarWeekStart = "sunday" | "monday";

export function monthDates(
  month: string,
  weekStart: CalendarWeekStart = "sunday",
): (string | undefined)[] {
  if (
    !/^\d{4}-\d{2}$/.test(month) ||
    !Number.isFinite(dayNumber(`${month}-01`))
  )
    throw new Error("Invalid calendar month");
  const first = dayNumber(`${month}-01`);
  const start = weekStart === "monday" ? 1 : 0;
  const offset = (new Date(first * 86400000).getUTCDay() - start + 7) % 7;
  const cells: (string | undefined)[] = Array(offset).fill(undefined);
  for (let day = 1; day <= 31; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    if (!Number.isFinite(dayNumber(date))) break;
    cells.push(date);
  }
  while (cells.length % 7) cells.push(undefined);
  return cells;
}
