const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseNote } = require("../dist/core");
const {
  todoGroups,
  emptyTodoReason,
  reminderHighlight,
} = require("../dist/todo-model");

test("deadline highlights include the threshold and due date, with overdue starting the next day", () => {
  const deadline = (date) => ({ kind: "!", date, days: 7 });
  const today = "2026-10-10";
  assert.equal(reminderHighlight(deadline("2026-10-09"), today), "overdue");
  assert.equal(reminderHighlight(deadline(today), today), "dueSoon");
  assert.equal(reminderHighlight(deadline("2026-10-13"), today), "dueSoon");
  assert.equal(reminderHighlight(deadline("2026-10-14"), today), undefined);
  assert.equal(reminderHighlight(deadline("2026-10-14"), today, 4), "dueSoon");
  assert.equal(reminderHighlight(deadline(today), today, 0), "dueSoon");
  assert.equal(reminderHighlight(deadline("2026-10-11"), today, 0), undefined);
  // The highlight threshold is independent of the reminder's priority grace period.
  assert.equal(
    reminderHighlight({ ...deadline("2026-10-13"), days: 1 }, today),
    "dueSoon",
  );
  for (const invalid of [-1, 1.5, NaN, Infinity, "7"])
    assert.equal(
      reminderHighlight(deadline("2026-10-14"), today, invalid),
      undefined,
    );
});

test("only today's appointments and actual deadlines are highlighted", () => {
  const today = "2026-10-10";
  assert.equal(reminderHighlight({ kind: "@", date: today }, today), "today");
  for (const date of ["2026-10-09", "2026-10-11"])
    assert.equal(reminderHighlight({ kind: "@", date }, today), undefined);
  for (const kind of ["+", "-", "~", "."])
    for (const date of ["2026-10-09", today, "2026-10-11"])
      assert.equal(reminderHighlight({ kind, date }, today), undefined);
});

test("highlight day counts cross month, year, leap day and daylight saving boundaries", () => {
  for (const [today, date, days] of [
    ["2026-10-31", "2026-11-01", 1],
    ["2026-12-31", "2027-01-01", 1],
    ["2028-02-28", "2028-03-01", 2],
    ["2026-03-07", "2026-03-09", 2],
    ["2026-10-31", "2026-11-02", 2],
  ]) {
    const reminder = { kind: "!", date };
    assert.equal(reminderHighlight(reminder, today, days), "dueSoon");
    assert.equal(reminderHighlight(reminder, today, days - 1), undefined);
  }
  assert.equal(
    reminderHighlight({ kind: "!", date: "2026-02-30" }, "2026-03-01"),
    undefined,
  );
});

test("sidebar groups preserve reminder priority without duplicate deadlines and collapse inactive entries", () => {
  const note = parseNote(
    "file:///a.md",
    "# A\n[2026-10-08]+ task\n[2026-10-10]! deadline\n[2026-10-12]@ appointment\n[2026-10-15]+ future\n[2026-10-01]@ past\n[2026-10-10]. done\n[2026-10-10]-",
  );
  const groups = todoGroups([note], "2026-10-10");
  assert.deepEqual(
    groups.map((g) => [g.id, g.expanded]),
    [
      ["todos", true],
      ["schedule", true],
      ["hidden", false],
    ],
  );
  assert.deepEqual(
    groups[0].entries.map((e) => e.reminder.text),
    ["deadline", "", "task"],
  );
  assert.deepEqual(
    groups[1].entries.map((e) => e.reminder.text),
    ["appointment"],
  );
  assert.deepEqual(
    groups[2].entries.map((e) => e.reminder.text),
    ["future", "past"],
  );
  const entries = groups.flatMap((g) => g.entries);
  assert.ok(entries.every((e) => e.reminder.kind !== "."));
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  assert.equal(
    new Set(
      entries.map((e) =>
        JSON.stringify([e.note.id, e.reminder.line, e.reminder.start]),
      ),
    ).size,
    entries.length,
  );
});
test("empty and completed notes have clear empty states and no empty groups", () => {
  assert.deepEqual(todoGroups([], "2026-10-10"), []);
  assert.match(emptyTodoReason([]), /保存先/);
  assert.match(
    emptyTodoReason([parseNote("a", "# Plain")]),
    /リマインダがありません/,
  );
  const done = [parseNote("a", "[2026-10-10]. done")];
  assert.deepEqual(todoGroups(done, "2026-10-10"), []);
  assert.match(emptyTodoReason(done), /すべて完了/);
});
test("calendar day changes move pending tasks into the active list", () => {
  const note = parseNote("a", "[2026-10-11]+ next day");
  assert.equal(todoGroups([note], "2026-10-10")[0].id, "hidden");
  assert.equal(todoGroups([note], "2026-10-11")[0].id, "todos");
});
