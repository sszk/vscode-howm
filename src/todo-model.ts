import { Note, Reminder, dateString, dayNumber, reminderList } from "./core";

export type ReminderHighlight = "dueSoon" | "overdue" | "today";

export function reminderHighlight(
  reminder: Reminder,
  today = dateString(),
  dueSoonDays = 3,
): ReminderHighlight | undefined {
  const remaining = dayNumber(reminder.date) - dayNumber(today);
  if (reminder.kind === "@") return remaining === 0 ? "today" : undefined;
  // Other reminder dates are start dates or recurrence anchors, not deadlines.
  if (reminder.kind !== "!") return undefined;
  if (remaining < 0) return "overdue";
  const threshold =
    Number.isInteger(dueSoonDays) && dueSoonDays >= 0 ? dueSoonDays : 3;
  return remaining >= 0 && remaining <= threshold ? "dueSoon" : undefined;
}

export interface TodoEntry {
  type: "reminder";
  id: string;
  note: Note;
  reminder: Reminder;
}
export interface TodoGroup {
  type: "group";
  id: string;
  label: string;
  expanded: boolean;
  entries: TodoEntry[];
}
export type TodoNode = TodoGroup | TodoEntry;

export function todoGroups(notes: Note[], today = dateString()): TodoGroup[] {
  const { todos, schedule, hidden } = reminderList(notes, today);
  const groups = [
    { id: "todos", label: "Todo（優先度順）", expanded: true, rows: todos },
    {
      id: "schedule",
      label: "これからの予定・締切",
      expanded: true,
      rows: schedule,
    },
    {
      id: "hidden",
      label: "開始前のTodo・過去の予定",
      expanded: false,
      rows: hidden,
    },
  ];
  return groups
    .filter((g) => g.rows.length)
    .map((g) => ({
      type: "group",
      id: g.id,
      label: g.label,
      expanded: g.expanded,
      entries: g.rows.map(({ note, r }) => ({
        type: "reminder",
        id: JSON.stringify([g.id, note.id, r.line, r.start]),
        note,
        reminder: r,
      })),
    }));
}

export function emptyTodoReason(notes: Note[]): string {
  if (!notes.length)
    return "対象のMarkdownメモがありません。保存先を確認してください。";
  const { all, unfinished } = reminderList(notes);
  if (!all.length)
    return "リマインダがありません。本文に [YYYY-MM-DD]+ 内容 を記述してください（コードブロック内は対象外）。";
  if (!unfinished.length) return "リマインダはすべて完了済みです。";
  return "表示するリマインダがありません。";
}
