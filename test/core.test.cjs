const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseNote,
  search,
  keywordLinks,
  priority,
  dayNumber,
  filename,
  renderTemplate,
} = require("../dist/core");
test("Markdown parser preserves Japanese titles and ignores fenced, indented and inline code", () => {
  const n = parseNote(
    "file:///a.md",
    "# 日本語\n<<< 検索\n```md\n<<< 無効\n[2026-10-01]!\n```\n    >>> 無効\n`[2026-10-01]+`\n[2026-10-15]!7 試作",
  );
  assert.equal(n.title, "日本語");
  assert.deepEqual(n.keywords, ["検索"]);
  assert.equal(n.links.length, 1);
  assert.equal(n.reminders.length, 1);
  assert.equal(n.reminders[0].line, 8);
});
test("fence requires matching character and at least original length", () => {
  const n = parseNote("a", "````\n```\n<<< hidden\n````\n<<< visible");
  assert.deepEqual(n.keywords, ["visible"]);
});
test("come-from terms link occurrences but exclude code and Markdown links", () => {
  const n = parseNote(
    "a",
    "# 無題\n検索UI と 検索\n`検索` [検索](./検索.md)\n```\n検索\n```",
  );
  const l = keywordLinks(n, ["検索", "検索UI"]);
  assert.deepEqual(
    l.map((x) => [x.line, x.start, x.target]),
    [
      [1, 0, "検索UI"],
      [1, 7, "検索"],
    ],
  );
});
test("search ranks declarations first and supports regex and empty titles", () => {
  const a = parseNote("file:///untitled.md", "検索", 100),
    b = parseNote("b", "# 宣言\n<<< 検索", 1);
  assert.equal(a.title, "untitled.md");
  assert.deepEqual(
    search([a, b], "検索").map((n) => n.uri),
    ["b", "file:///untitled.md"],
  );
  assert.equal(search([a, b], "宣[言語]", true).length, 1);
  assert.throws(() => search([a], "[", true));
});
test("invalid calendar dates are rejected including leap years", () => {
  assert.ok(Number.isNaN(dayNumber("2026-02-29")));
  assert.ok(Number.isFinite(dayNumber("2024-02-29")));
  assert.equal(dayNumber("2026-03-09") - dayNumber("2026-03-08"), 1);
  assert.equal(parseNote("a", "[2026-02-30]! 無効").reminders.length, 0);
});
test("reminders rise, sink, oscillate and finish as dates advance", () => {
  const r = {
    date: "2026-10-10",
    days: 7,
    kind: "+",
    line: 0,
    start: 0,
    end: 0,
    text: "",
  };
  assert.equal(priority(r, "2026-10-09"), -Infinity);
  assert.ok(priority(r, "2026-10-17") > priority(r, "2026-10-10"));
  assert.ok(
    priority({ ...r, kind: "-" }, "2026-10-17") <
      priority({ ...r, kind: "-" }, "2026-10-10"),
  );
  assert.equal(priority({ ...r, kind: "." }, "2026-10-10"), -Infinity);
  assert.ok(
    priority({ ...r, kind: "!" }, "2026-10-10") >
      priority({ ...r, kind: "!" }, "2026-10-09"),
  );
  assert.equal(
    priority({ ...r, kind: "~" }, "2026-10-10"),
    priority({ ...r, kind: "~" }, "2026-10-17"),
  );
});
test("completion history does not become another active reminder", () => {
  const n = parseNote("a", "[2026-10-08]. [2026-10-15]:!7 試作");
  assert.equal(n.reminders.length, 1);
  assert.equal(n.reminders[0].kind, ".");
});
test("filename patterns cannot escape note directory", () => {
  for (const p of ["../a.md", "/a.md", "x/../../a.md", "C:\\a.md", "a.txt"])
    assert.throws(() => filename(p));
  assert.match(filename("{YYYY}/{MM}/note.md"), /^\d{4}\/\d{2}\/note.md$/);
});
test("template replacement does not interpret user content as placeholders", () => {
  assert.equal(renderTemplate("{title}\n{body}", "{body}", "$&"), "{body}\n$&");
});
test("ten thousand notes can be indexed and searched", () => {
  const start = performance.now();
  const notes = Array.from({ length: 10000 }, (_, i) =>
    parseNote(
      `file:///${i}.md`,
      `# メモ ${i}\n${i === 9999 ? "探す対象" : "日々の断片"}\n${"本文 ".repeat(100)}`,
      i,
    ),
  );
  const indexed = performance.now();
  assert.equal(search(notes, "探す対象").length, 1);
  console.log(
    `10,000 notes: parse ${(indexed - start).toFixed(0)}ms, search ${(performance.now() - indexed).toFixed(0)}ms`,
  );
});
test("reminder list includes active tasks and exposes why other entries are hidden", () => {
  const { reminderList } = require("../dist/core");
  const note = parseNote(
    "a",
    "[2026-10-08]+ 今日のTodo\n[2026-10-15]+ 開始前\n[2026-10-12]@ 予定\n[2026-10-01]@ 過去\n[2026-10-08]. 完了",
  );
  const result = reminderList([note], "2026-10-08");
  assert.equal(result.all.length, 5);
  assert.deepEqual(
    result.todos.map((x) => x.r.text),
    ["今日のTodo"],
  );
  assert.deepEqual(
    result.schedule.map((x) => x.r.text),
    ["予定"],
  );
  assert.deepEqual(
    result.hidden.map((x) => x.r.text),
    ["開始前", "過去"],
  );
  assert.equal(reminderList([], "2026-10-08").all.length, 0);
  assert.equal(
    reminderList([parseNote("a", "[2026-10-08]. 完了")], "2026-10-08")
      .unfinished.length,
    0,
  );
});
