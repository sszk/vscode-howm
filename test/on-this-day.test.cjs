const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseNotes, parseNote } = require("../dist/core");
const { onThisDay } = require("../dist/on-this-day-model");
const { LocalDayClock } = require("../dist/local-day");

test("anniversaries use shared dates, preserve duplicate sections and list order, and group past years descending", () => {
  const notes = parseNotes(
    "file:///2020-11-01.md",
    "preamble [2010-11-01]\n# Same\n[2025-11-01 12:00]\n# Same\n[2025-11-01]\n# Earlier\n[2023-11-01]\n# This year\n[2026-11-01]\n# Future\n[2027-11-01]\n# Different\n[2025-11-02]\n# Fallback\n[2025-11-01]+ reminder\n```\n[2024-11-01]\n```\n",
  );
  const groups = onThisDay(notes, "2026-11-01");
  assert.deepEqual(
    groups.map((g) => [g.year, g.yearsAgo]),
    [
      [2025, 1],
      [2023, 3],
      [2020, 6],
    ],
  );
  assert.deepEqual(groups[0].notes, notes.slice(0, 2));
  assert.equal(groups[2].notes[0], notes.at(-1));
  assert.notEqual(groups[0].notes[0].id, groups[0].notes[1].id);
  const fallback = parseNote(
    "file:///no-date.md",
    "undated",
    new Date(2022, 10, 1, 15).getTime(),
  );
  assert.equal(onThisDay([fallback], "2026-11-01")[0].year, 2022);
  assert.deepEqual(onThisDay([], "2026-11-01"), []);
});

test("Feb 29 matches only Feb 29, and local year rollover changes anniversaries", () => {
  const notes = parseNotes(
    "file:///leap.md",
    "# Leap\n[2020-02-29]\n# End\n[2020-12-31]\n# Start\n[2020-01-01]",
  );
  assert.deepEqual(onThisDay(notes, "2024-02-28"), []);
  assert.deepEqual(onThisDay(notes, "2024-03-01"), []);
  assert.equal(onThisDay(notes, "2024-02-29")[0].notes[0].title, "Leap");
  assert.equal(onThisDay(notes, "2026-12-31")[0].notes[0].title, "End");
  assert.equal(onThisDay(notes, "2027-01-01")[0].notes[0].title, "Start");
});

test("Todo and anniversaries share one minute timer and release it when both are hidden", () => {
  let day = "2026-11-01",
    todo = 0,
    anniversary = 0;
  const clock = new LocalDayClock(() => day);
  const first = clock.watch(() => todo++);
  const timer = clock.timer;
  const second = clock.watch(() => anniversary++);
  assert.equal(clock.timer, timer);
  clock.checkDate();
  assert.equal(todo, 0);
  day = "2026-11-02";
  clock.checkDate();
  assert.equal(todo, 1);
  assert.equal(anniversary, 1);
  first.dispose();
  assert.equal(clock.timer, timer);
  second.dispose();
  assert.equal(clock.timer, undefined);
});
