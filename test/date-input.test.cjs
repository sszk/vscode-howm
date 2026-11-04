const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { parseHowmDate } = require("../dist/date-input");

const today = new Date(2026, 10, 5, 23, 45);
function cases(entries, base = today) {
  for (const [input, expected] of entries)
    assert.equal(parseHowmDate(input, base), expected, input);
}

test("today, tomorrow and +N use local calendar days; plain numbers name a day", () => {
  cases([
    ["", "2026-11-05"],
    ["0", "2026-11-05"],
    ["today", "2026-11-05"],
    ["tomorrow", "2026-11-06"],
    ["+0", "2026-11-05"],
    ["+1", "2026-11-06"],
    ["+7", "2026-11-12"],
    ["+30", "2026-12-05"],
    ["5", "2026-11-05"],
    ["7", "2026-11-07"],
    ["20", "2026-11-20"],
    ["3", "2026-12-03"],
    ["31", "2026-12-31"],
  ]);
});

test("day-only dates skip months without the requested day and cross the year", () => {
  cases(
    [
      ["28", "2026-02-28"],
      ["29", "2026-03-29"],
      ["30", "2026-03-30"],
      ["31", "2026-03-31"],
    ],
    new Date(2026, 1, 28),
  );
  cases(
    [
      ["29", "2024-02-29"],
      ["30", "2024-03-30"],
    ],
    new Date(2024, 1, 28),
  );
  cases([["31", "2026-05-31"]], new Date(2026, 3, 30));
  cases(
    [
      ["1", "2027-01-01"],
      ["31", "2026-12-31"],
    ],
    new Date(2026, 11, 31),
  );
});

test("month/day chooses the closest occurrence on or after today", () => {
  cases([
    ["11/5", "2026-11-05"],
    ["11/20", "2026-11-20"],
    ["12/5", "2026-12-05"],
    ["1/10", "2027-01-10"],
    ["11/3", "2027-11-03"],
    ["12-5", "2026-12-05"],
    ["01/01", "2027-01-01"],
    ["2/29", "2028-02-29"],
  ]);
  cases([["2/29", "2024-02-29"]], new Date(2024, 1, 29));
  cases([["2/29", "2028-02-29"]], new Date(2024, 2, 1));
  cases([["2/29", "2104-02-29"]], new Date(2097, 0, 1));
});

test("explicit years allow past dates and enforce leap-year validity", () => {
  cases([
    ["2027/2/20", "2027-02-20"],
    ["2027-2-20", "2027-02-20"],
    ["2026-11-05", "2026-11-05"],
    ["2025/1/1", "2025-01-01"],
    ["2000/2/29", "2000-02-29"],
    ["0099/1/1", "0099-01-01"],
    ["0000/2/29", "0000-02-29"],
  ]);
});

test("all weekdays include today when it matches", () => {
  cases([
    ["thu", "2026-11-05"],
    ["fri", "2026-11-06"],
    ["sat", "2026-11-07"],
    ["sun", "2026-11-08"],
    ["mon", "2026-11-09"],
    ["tue", "2026-11-10"],
    ["wed", "2026-11-11"],
  ]);
});

test("keywords ignore case and all forms ignore surrounding whitespace", () => {
  cases([
    ["  ToDaY\t", "2026-11-05"],
    [" TOMORROW ", "2026-11-06"],
    ["\n MON ", "2026-11-09"],
    [" +7 ", "2026-11-12"],
    [" 15 ", "2026-11-15"],
    [" 12/5 ", "2026-12-05"],
    [" 2025/1/1 ", "2025-01-01"],
    ["\t ", "2026-11-05"],
  ]);
});

test("invalid dates, syntax and extreme values are rejected without rollover", () => {
  for (const input of [
    "abc",
    "32",
    "99",
    "-1",
    "2/30",
    "2/31",
    "4/31",
    "13/1",
    "0/1",
    "1/0",
    "2026/2/29",
    "1900/2/29",
    "2100/2/29",
    "2026/11/31",
    "2026/13/1",
    "++7",
    "+-7",
    "+1.5",
    "+1e3",
    "+Infinity",
    "+NaN",
    "+",
    "7 days",
    "2026/2-20",
    "26/2/20",
    "10000/1/1",
    "2026/01/001",
    "1 / 1",
    "monday",
    "[2026-11-05]",
    "2026-11-05T00:00:00Z",
    "+9007199254740991",
    "+9007199254740992",
    "+999999999999999999999999999999",
    "+" + "9".repeat(400),
  ])
    assert.equal(parseHowmDate(input, today), undefined, input);
  assert.equal(parseHowmDate("today", new Date(NaN)), undefined);
});

test("calendar addition crosses year boundaries and rejects dates beyond four-digit years", () => {
  cases(
    [
      ["+1", "2027-01-01"],
      ["+32", "2027-02-01"],
    ],
    new Date(2026, 11, 31),
  );
  cases(
    [
      ["+1", "2024-02-29"],
      ["+2", "2024-03-01"],
    ],
    new Date(2024, 1, 28),
  );
  cases(
    [
      ["+0", "9999-12-31"],
      ["+1", undefined],
      ["tomorrow", undefined],
      ["1", undefined],
      ["1/1", undefined],
      ["2/29", undefined],
    ],
    new Date(9999, 11, 31),
  );
});

test("local calendar fields and DST transitions are independent of UTC dates and day length", () => {
  for (const tz of ["Asia/Tokyo", "America/New_York", "Europe/Berlin"]) {
    execFileSync(
      process.execPath,
      [
        "-e",
        `
      const assert = require("node:assert/strict");
      const { parseHowmDate } = require(${JSON.stringify(require.resolve("../dist/date-input"))});
      for (const [year, month, day, expected] of [
        [2026, 2, 7, "2026-03-08"], [2026, 2, 8, "2026-03-09"],
        [2026, 9, 31, "2026-11-01"], [2026, 10, 1, "2026-11-02"],
        [2026, 2, 28, "2026-03-29"], [2026, 2, 29, "2026-03-30"],
        [2026, 9, 24, "2026-10-25"], [2026, 9, 25, "2026-10-26"],
      ]) {
        for (const hour of [0, 1, 12, 23]) {
          const date = new Date(year, month, day, hour, 30);
          assert.equal(parseHowmDate("+1", date), expected);
          assert.equal(parseHowmDate("tomorrow", date), expected);
        }
      }
      for (const hour of [0, 23]) {
        const date = new Date(2026, 10, 5, hour, 30);
        assert.equal(parseHowmDate("today", date), "2026-11-05");
        assert.equal(parseHowmDate("thu", date), "2026-11-05");
        assert.equal(parseHowmDate("5", date), "2026-11-05");
      }
    `,
      ],
      { env: { ...process.env, TZ: tz }, stdio: "pipe" },
    );
  }
});
