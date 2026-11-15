const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseNotes, parseNote } = require("../dist/core");
const {
  extractPassageQuery,
  passageWindows,
  PassageIndex,
  deduplicatePassages,
} = require("../dist/related-passages-model");

const phrase = "RISC-VコンパイラのLLVM ClangとC23への対応を検討する。";
const query = (note, line = note.startLine + 1, context = 5, min = 30) =>
  extractPassageQuery(note, line, context, min);

test("cursor context stays inside memo and heading boundaries, including headings in code", () => {
  const notes = parseNotes(
    "file:///multiple.md",
    [
      "outside preamble",
      "# Current",
      "## First",
      phrase,
      "- 第一の検討項目",
      "",
      "- 第二の検討項目",
      "## Second",
      "other section must not leak",
      "```md",
      "## fake heading",
      "# fake memo",
      "```",
      phrase,
      "# Other memo",
      "another memo must not leak",
    ].join("\n"),
  );
  assert.equal(notes.length, 2);
  const q = query(notes[0], 4);
  assert.equal(q.startLine, 3);
  assert.equal(q.endLine, 7);
  assert.ok(q.text.includes("第一の検討項目"));
  assert.ok(
    q.text.includes("第二の検討項目"),
    "blank lines retain list context",
  );
  assert.doesNotMatch(q.text, /other section|another memo|fake|outside/);
  const code = query(notes[0], 11);
  assert.match(code.text, /対応を検討/);
  assert.doesNotMatch(code.text, /fake/);
  assert.equal(query(notes[1]), undefined);
});

test("context initially uses at most eleven physical lines and expands only when too short", () => {
  const note = parseNote(
    "file:///a.md",
    "# Memo\n" +
      Array.from(
        { length: 25 },
        (_, i) => `本文のコンパイラ検討結果について ${i}`,
      ).join("\n"),
  );
  const q = query(note, 13);
  assert.equal(q.startLine, 8);
  assert.equal(q.endLine, 19);
  const sparse = parseNote("sparse", "# Memo\n" + "x\n".repeat(9) + phrase);
  assert.match(query(sparse, 1).text, /対応を検討/);
  assert.equal(query(parseNote("short", "# Title\nあい")), undefined);
  assert.equal(
    query(parseNote("only-code", "# Title\n```\n" + phrase + "\n```")),
    undefined,
  );
  const distant = parseNote(
    "code",
    "# Title\n" + phrase + "\n```\n" + "code\n".repeat(40) + "```",
  );
  assert.match(query(distant, 22).text, /対応を検討/);
  assert.ok(
    query(parseNote("long", "# Title\n" + phrase.repeat(500))).text.length <=
      4000,
  );
});

test("query strips formatting, links, dates, reminder symbols and URL-only lines", () => {
  const note = parseNote(
    "a",
    "# Heading\n[2026-11-15]!7\nhttps://irrelevant.example\n- **ＲＩＳＣ-V** [LLVM Clang](https://secret.example) のコンパイラとC23への対応を検討する。\n---\n`excluded_inline_code`",
  );
  const q = query(note, 3);
  assert.match(q.text, /risc-v llvm clang/);
  assert.doesNotMatch(q.text, /2026|https|secret|excluded|\*|\[|!7/);
  assert.equal(
    query(
      parseNote(
        "decorations",
        "# Heading\n---\n***\n[2026-11-15]\nhttps://example.com",
      ),
    ),
    undefined,
  );
});

test("five-line windows advance by two effective prose lines and retain the short tail", () => {
  const windows = (count) => [
    ...passageWindows(
      parseNote(
        "a",
        "# Title\n" +
          Array.from({ length: count }, (_, i) => `本文${i + 1}`).join("\n"),
      ),
    ),
  ];
  assert.deepEqual(
    windows(9).map((p) => [p.startLine, p.endLine]),
    [
      [1, 6],
      [3, 8],
      [5, 10],
    ],
  );
  assert.deepEqual(
    windows(8).map((p) => [p.startLine, p.endLine]),
    [
      [1, 6],
      [3, 8],
      [5, 9],
    ],
  );
  assert.deepEqual(
    windows(3).map((p) => [p.startLine, p.endLine]),
    [[1, 4]],
  );
  const notes = parseNotes(
    "multi",
    "# One\naaaa\n\n---\nbbbb\n```\nignored\n## ignored\n```\ncccc\n## Section\ndddd\n# Two\neeee",
  );
  const all = notes.flatMap((n) => [...passageWindows(n)]);
  assert.deepEqual(
    all.map((p) => p.text),
    ["aaaa\nbbbb\ncccc", "dddd", "eeee"],
  );
  assert.ok(all[0].endLine <= all[1].startLine);
});

test("passage IDF and ranking find buried content, exclude self, include sibling memo and independent distant matches", async () => {
  const notes = parseNotes(
    "file:///same.md",
    "# Query\n" +
      phrase +
      "\n# Long memo\n" +
      Array.from({ length: 40 }, (_, i) =>
        i === 7 || i === 33 ? phrase : `garden plants vegetables ${i}`,
      ).join("\n") +
      "\n# Other\n火星探査機の燃料と宇宙飛行について考える",
  );
  const index = new PassageIndex();
  await index.sync(notes);
  const result = await index.search(query(notes[0]));
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.passage.note.id === notes[1].id));
  assert.ok(result.every((r) => r.score >= 0.15 && r.score <= 1));
  assert.ok(
    result.every((r) => r.excerpt.includes("LLVM Clang")),
    "display preserves source casing",
  );
  assert.ok(result.every((r) => r.excerpt.split("\n").length <= 3));
  assert.equal(
    index.count,
    [...index.notes.values()].reduce((sum, n) => sum + n.passages.length, 0),
  );
  assert.ok(index.count > notes.length);
  const matchingWindows = [...index.notes.values()]
    .flatMap((n) => n.passages)
    .filter((p) => p.terms.has("2:ll")).length;
  assert.equal(
    index.frequencies.get("2:ll"),
    matchingWindows,
    "DF counts windows, not memos",
  );
  assert.deepEqual(await index.search(query(notes[0]), 10, 1), []);
  assert.equal((await index.search(query(notes[0]), 1)).length, 1);
  const mono = new PassageIndex();
  await mono.sync([notes[0]]);
  assert.deepEqual(await mono.search(query(notes[0])), []);
});

test("deduplication retains best original range and does not combine distant passages", () => {
  const entry = (id, start, end, score, noteId = "memo") => ({
    score,
    passage: { id, startLine: start, endLine: end, note: { id: noteId } },
  });
  const best = entry("best", 3, 8, 0.9);
  const distant = entry("far", 20, 25, 0.7);
  const other = entry("other", 3, 8, 0.6, "different");
  assert.deepEqual(
    deduplicatePassages(
      [best, entry("overlap", 1, 6, 0.8), distant, other],
      10,
    ),
    [best, distant, other],
  );
  assert.equal(best.passage.startLine, 3);
  assert.equal(best.passage.endLine, 8);
});

test("incremental edits, undo, metadata, additions, deletions and geometry changes agree with a fresh index", async () => {
  const notes = [
    parseNote("a", "# A\n" + phrase),
    parseNote("b", "# B\n" + phrase),
    parseNote("c", "# C\ngarden vegetables"),
  ];
  const index = new PassageIndex();
  await index.sync(notes);
  const cached = index.notes.get(notes[0].id).passages[0];
  const revised = [
    parseNote("a", notes[0].text, 55),
    parseNote("b", "# B\ngarden plants"),
    parseNote("new", "# New\n" + phrase),
  ];
  await index.sync(revised);
  assert.equal(index.notes.get(notes[0].id).passages[0], cached);
  assert.equal(cached.note.modified, 55);
  assert.ok(!index.notes.has(notes[2].id));
  const fresh = new PassageIndex();
  await fresh.sync(revised);
  const summary = (r) =>
    r.map((x) => [
      x.passage.note.id,
      x.passage.startLine,
      x.passage.endLine,
      x.score,
    ]);
  assert.deepEqual(
    summary(await index.search(query(revised[0]))),
    summary(await fresh.search(query(revised[0]))),
  );
  await index.sync(notes);
  assert.equal(
    (await index.search(query(notes[0])))[0].passage.note.id,
    notes[1].id,
  );
  await index.sync(notes, 2, 1);
  assert.notEqual(index.notes.get(notes[0].id).passages[0], cached);
  index.dispose();
  assert.equal(index.count, 0);
  assert.equal(index.notes.size, 0);
  assert.equal(index.frequencies.size, 0);
});

test("large indexes yield, cancel obsolete work and retain unchanged feature caches", async () => {
  const notes = Array.from({ length: 1000 }, (_, i) =>
    parseNote(
      `file:///notes/${i}.md`,
      "# Memo\n" +
        Array.from({ length: 15 }, (_, j) => phrase + ` ${i} ${j}`).join("\n"),
    ),
  );
  const index = new PassageIndex();
  let cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  assert.equal(await index.sync(notes, 5, 2, () => cancelled), false);
  await index.sync(notes);
  const cached = index.notes.get(notes[0].id).passages;
  await index.sync([notes[0], ...notes.slice(2)]);
  assert.equal(index.notes.get(notes[0].id).passages, cached);
  cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  assert.deepEqual(
    await index.search(query(notes[0]), 10, 0, () => cancelled),
    [],
  );
  assert.equal(cancelled, true);
  index.dispose();
});
