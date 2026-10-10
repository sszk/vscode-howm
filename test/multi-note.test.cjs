const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseNotes,
  noteAtLine,
  noteDisplayDate,
  keywordLinks,
  relatedNotes,
  search,
  reminderList,
} = require("../dist/core");
const { regexSearch } = require("../dist/search");
const { calendarDays } = require("../dist/calendar-model");

test("H1 sections exclude the preamble and preserve exact CRLF text and absolute positions", () => {
  const text =
    "Ignored\r\n[2026-10-01]\r\n<<< ignored\r\n[2026-10-01]+ ignored\r\n# First\r\n[2026-10-10]\r\n<<< first\r\n[2026-10-10]+ Buy milk\r\n## Subheading\r\nBody\r\n# Second\r\n[2026-10-11]\r\n<<< second\r\n[2026-10-11]@ Read\r\n";
  const notes = parseNotes("file:///2026-09-01.md", text, 42);
  assert.deepEqual(
    notes.map((n) => [n.title, n.startLine, n.endLine]),
    [
      ["First", 4, 10],
      ["Second", 10, 15],
    ],
  );
  assert.equal(notes[0].source, notes[1].source);
  assert.equal(notes[0].source.text, text);
  assert.equal(
    notes[0].text + notes[1].text,
    text.slice(text.indexOf("# First")),
  );
  assert.equal(notes[0].reminders[0].line, 7);
  assert.equal(notes[1].links[0].line, 12);
  assert.equal(notes[1].reminders[0].line, 13);
  assert.deepEqual(
    notes.map((n) => n.keywords),
    [["first"], ["second"]],
  );
  assert.equal(noteAtLine(notes, 0), undefined);
  assert.equal(noteAtLine(notes, 9), notes[0]);
  assert.equal(noteAtLine(notes, 10), notes[1]);
  assert.equal(noteAtLine(notes, 15), undefined);
  assert.equal(search(notes, "ignored").length, 0);
  assert.equal(search(notes, "Buy milk")[0], notes[0]);
  assert.equal(search(notes, "Read")[0], notes[1]);
  assert.deepEqual(
    reminderList(notes, "2026-10-10").all.map((x) => x.note.title),
    ["First", "Second"],
  );
  assert.deepEqual(
    notes.map((n) => noteDisplayDate(n).date),
    ["2026-10-10", "2026-10-11"],
  );
});

test("only ATX level-one headings outside code delimit notes", () => {
  const notes = parseNotes(
    "file:///notes.md",
    [
      "# First",
      "## Child",
      "### Grandchild",
      "#not-a-heading",
      "    # Indented",
      "\t# Tab-indented",
      "\\# Escaped",
      "> # Quote",
      "````md",
      "# Fenced",
      "```",
      "# Still fenced",
      "````",
      "~~~",
      "# Tilde fenced",
      "~~~",
      "   # Second ###",
      "# `Third`",
    ].join("\n"),
  );
  assert.deepEqual(
    notes.map((n) => n.title),
    ["First", "Second", "`Third`"],
  );
  assert.equal(notes[1].startLine, 16);
  const unclosed = parseNotes(
    "file:///notes.md",
    "# First\n```\n# Hidden\n# Also hidden",
  );
  assert.equal(unclosed.length, 1);
});

test("heading-less and empty files remain one note; empty and duplicate titles remain distinct", () => {
  for (const text of [
    "",
    "No heading\n[2026-10-10]+ Todo",
    "## Small heading\nBody",
  ]) {
    const notes = parseNotes("file:///plain.md", text);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, "plain.md");
    assert.equal(notes[0].text, text);
    assert.equal(notes[0].startLine, 0);
  }
  const notes = parseNotes("file:///plain.md", "#\n# \n# Same\n# Same\n");
  assert.deepEqual(
    notes.map((n) => n.title),
    ["plain.md", "plain.md", "Same", "Same"],
  );
  assert.equal(new Set(notes.map((n) => n.id)).size, 4);
});

test("dates, declarations and related notes stay scoped to each section", () => {
  const notes = parseNotes(
    "file:///2026-09-01.md",
    "[2026-08-01]\n# A\n<<< topic\n[2026-10-10]\n# B\n[2026-10-11]\ntopic and `topic`\n# C\n[2026-10-15]+ Todo\n",
  );
  assert.deepEqual(
    notes.map((n) => noteDisplayDate(n).date),
    ["2026-10-10", "2026-10-11", "2026-09-01"],
  );
  assert.deepEqual(relatedNotes(notes[0], notes, ["topic"]), [notes[1]]);
  assert.deepEqual(relatedNotes(notes[1], notes, ["topic"]), [notes[0]]);
  assert.deepEqual(
    keywordLinks(notes[1], ["topic"]).map((l) => [l.line, l.start]),
    [[6, 0]],
  );
  const days = calendarDays(notes);
  assert.deepEqual(days.get("2026-10-10").notes, [notes[0]]);
  assert.deepEqual(days.get("2026-10-11").notes, [notes[1]]);
  assert.deepEqual(days.get("2026-10-15").notes, [notes[2]]);
  assert.equal(days.has("2026-08-01"), false);
  const sharedDay = parseNotes(
    "file:///same.md",
    "# Same\n[2026-10-10]\n[2026-10-10]+ A\n# Same\n[2026-10-10]\n[2026-10-10]+ B",
  );
  assert.deepEqual(calendarDays(sharedDay).get("2026-10-10").notes, sharedDay);
});

test("regex worker returns distinct matches from the same file", async () => {
  const notes = parseNotes(
    "file:///same.md",
    "# Same\nmatch A\n# Same\nmatch B\n# Other\nNothing",
  );
  assert.deepEqual(await regexSearch(notes, "match [AB]"), notes.slice(0, 2));
  assert.deepEqual(await regexSearch(notes, "match B"), [notes[1]]);
  await assert.rejects(regexSearch(notes, "["), /Invalid regular expression/);
});
