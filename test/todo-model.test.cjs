const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseNote } = require("../dist/core");
const { todoGroups, emptyTodoReason } = require("../dist/todo-model");

test("sidebar groups preserve reminder priority, duplicate deadlines and collapse inactive entries", () => {
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
    ["deadline", "appointment"],
  );
  assert.deepEqual(
    groups[2].entries.map((e) => e.reminder.text),
    ["future", "past"],
  );
  const entries = groups.flatMap((g) => g.entries);
  assert.ok(entries.every((e) => e.reminder.kind !== "."));
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
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
