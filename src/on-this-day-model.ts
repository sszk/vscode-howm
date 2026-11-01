import { Note, dateString, noteDisplayDate } from "./core";

export interface AnniversaryYear {
  year: number;
  yearsAgo: number;
  notes: Note[];
}

// The input is Store.all(): keep the existing note-list order within each year.
export function onThisDay(
  notes: Note[],
  today = dateString(),
): AnniversaryYear[] {
  const year = Number(today.slice(0, 4));
  const groups = new Map<number, AnniversaryYear>();
  for (const note of notes) {
    const date = noteDisplayDate(note).date;
    const noteYear = Number(date.slice(0, 4));
    if (noteYear >= year || date.slice(5) !== today.slice(5)) continue;
    let group = groups.get(noteYear);
    if (!group) {
      group = { year: noteYear, yearsAgo: year - noteYear, notes: [] };
      groups.set(noteYear, group);
    }
    group.notes.push(note);
  }
  return [...groups.values()].sort((a, b) => b.year - a.year);
}
