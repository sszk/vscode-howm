const { test } = require("node:test");
const assert = require("node:assert/strict");
const { calendarDays, monthDates } = require("../dist/calendar-model");
const { parseNote } = require("../dist/core");

test("calendar groups note dates and unfinished reminder dates without duplicates", () => {
  const note = parseNote(
    "file:///2026-10-01.md",
    "# Task\n[2026-10-02 12:30]\n[2026-10-03]+ First\n[2026-10-03]! Second\n[2026-10-04]. Done\n```\n[2026-10-05]+ Example\n```",
  );
  const days = calendarDays([note]);
  assert.deepEqual([...days.keys()].sort(), ["2026-10-02", "2026-10-03"]);
  assert.equal(days.get("2026-10-03").notes.length, 1);
  assert.equal(days.get("2026-10-03").reminders.length, 2);
  assert.equal(days.get("2026-10-02").reminders.length, 0);
  const completed = parseNote(
    note.uri,
    note.text.replace("]+ First", "]. First").replace("]! Second", "]. Second"),
  );
  assert.equal(calendarDays([completed]).has("2026-10-03"), false);
  assert.equal(calendarDays([note]).has("2026-10-03"), true);
});

test("calendar includes all unfinished kinds and notes sharing a date", () => {
  const a = parseNote(
    "file:///2026-10-01.md",
    "# A\n" +
      ["@", "+", "!", "-", "~"].map((k) => `[2026-11-01]${k} Task`).join("\n"),
  );
  const b = parseNote("file:///2026-11-01.md", "# B");
  const days = calendarDays([a, b]);
  assert.equal(days.get("2026-11-01").notes.length, 2);
  assert.equal(days.get("2026-11-01").reminders.length, 5);
});

test("month grids handle leap years and year boundaries", () => {
  assert.equal(monthDates("2024-02").filter(Boolean).length, 29);
  assert.equal(monthDates("2026-02").filter(Boolean).length, 28);
  assert.equal(monthDates("2026-12").filter(Boolean).at(-1), "2026-12-31");
  assert.equal(monthDates("2027-01")[5], "2027-01-01");
  assert.equal(monthDates("2026-10").length % 7, 0);
  assert.throws(() => monthDates("2026-13"));
});

test("Sunday and Monday week starts align every date with its weekday", () => {
  for (const month of [
    "2026-10",
    "2026-11",
    "2026-06",
    "2026-08",
    "2024-02",
    "2026-02",
    "2026-12",
    "2027-01",
  ]) {
    for (const weekStart of ["sunday", "monday"]) {
      const cells = monthDates(month, weekStart);
      assert.equal(cells.length % 7, 0);
      const dates = cells.filter(Boolean);
      assert.equal(new Set(dates).size, dates.length);
      assert.equal(dates.length, monthDates(month).filter(Boolean).length);
      cells.forEach((date, index) => {
        if (date)
          assert.equal(
            new Date(`${date}T00:00:00Z`).getUTCDay(),
            (index + (weekStart === "monday" ? 1 : 0)) % 7,
          );
      });
    }
  }
  assert.equal(monthDates("2026-11", "sunday")[0], "2026-11-01");
  assert.equal(monthDates("2026-11", "monday")[6], "2026-11-01");
  assert.equal(monthDates("2026-06", "monday")[0], "2026-06-01");
  assert.equal(monthDates("2026-06", "sunday")[1], "2026-06-01");
  assert.equal(monthDates("2026-08", "sunday")[6], "2026-08-01");
});
