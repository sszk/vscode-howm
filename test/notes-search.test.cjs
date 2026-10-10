const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseNotes } = require("../dist/core");
const { searchLines, matchSnippet } = require("../dist/notes-search");

test("line search includes headings/code, excludes preambles, and uses original UTF-16 file positions", () => {
  const notes = parseNotes(
    "file:///notes.md",
    "Ignored milk\r\n# Milk\r\n牛乳 milk MILK\r\n# Second\r\n😀 milk\r\n```\r\nmilk\r\n```\r\n",
  );
  const matches = searchLines(notes, "milk");
  assert.deepEqual(
    matches.map((m) => m.line),
    [1, 2, 4, 6],
  );
  assert.deepEqual(matches[1].ranges, [
    { start: 3, end: 7 },
    { start: 8, end: 12 },
  ]);
  assert.deepEqual(matches[2].ranges, [{ start: 3, end: 7 }]);
  assert.equal(matches[2].note, notes[1]);
  assert.equal(new Set(matches.map((m) => m.id)).size, matches.length);
  assert.equal(searchLines(notes, "牛乳")[0].line, 2);
  assert.deepEqual(searchLines(notes, ""), []);
});

test("line search treats regexp characters literally and returns one row for repeated matches", () => {
  const notes = parseNotes(
    "file:///a.md",
    "# First\n[a.*]+ [a.*]+\n# First\n[a.*]+\n",
  );
  const matches = searchLines(notes, "[a.*]+");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].ranges.length, 2);
  assert.notEqual(matches[0].note.id, matches[1].note.id);
  assert.deepEqual(searchLines(notes, "no matches"), []);
  assert.equal(searchLines(notes, "First").length, 2);
});

test("search covers all notes rather than only the latest 200", () => {
  const notes = Array.from(
    { length: 250 },
    (_, i) =>
      parseNotes(
        `file:///${i}.md`,
        `# Note ${i}\n${i === 249 ? "対象" : "Nothing"}`,
        i,
      )[0],
  );
  assert.equal(searchLines(notes, "対象")[0].note, notes[249]);
});

test("long-line previews surround the first match and preserve emoji and long queries", () => {
  const notes = parseNotes(
    "file:///a.md",
    "# Note\n" + "😀".repeat(200) + "対象" + "😀".repeat(200),
  );
  const match = searchLines(notes, "対象")[0];
  const snippet = matchSnippet(match);
  assert.ok(snippet.start > 0 && snippet.end < match.text.length);
  assert.equal(
    snippet.text.slice(snippet.ranges[0].start, snippet.ranges[0].end),
    "対象",
  );
  assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(snippet.text));
  const query = "word".repeat(60);
  const long = searchLines(
    parseNotes("file:///a.md", "# Note\nPrefix " + query + " suffix"),
    query,
  )[0];
  assert.ok(matchSnippet(long).text.includes(query));
});
