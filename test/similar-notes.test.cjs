const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseNotes, parseNote } = require("../dist/core");
const {
  SimilarityIndex,
  normalizeSimilarityText,
} = require("../dist/similar-notes-model");

const run = async (notes, query = notes[0], min = 0.1) => {
  const index = new SimilarityIndex();
  await index.sync(notes);
  return index.search(query.id, 10, min);
};

test("Japanese phrases discover sibling sections and duplicate titles without explicit links or preambles", async () => {
  const notes = parseNotes(
    "file:///notes.md",
    "索引外の火星基地\n# 台北旅行の計画\n台湾旅行のホテル予約と航空券\n# 台北旅行の計画\n台湾旅行のホテル予約について\n# 宇宙\n火星基地と探査機の燃料\n",
  );
  const result = await run(notes);
  assert.equal(result[0].note, notes[1]);
  assert.ok(result.every((r) => r.note.id !== notes[0].id));
  assert.ok(!result.some((r) => r.note.id === notes[2].id));
  assert.ok(result.every((r) => r.score >= 0 && r.score <= 1));
});

test("Unicode/case normalization and English technical terms work without breaking surrogate pairs", async () => {
  const notes = [
    parseNote("a", "# ＴｙｐｅＳｃｒｉｐｔ\nNode.js compiler configuration"),
    parseNote("b", "# typescript\nNODE.JS Compiler Configuration"),
    parseNote("c", "# 畑\n野菜と肥料の計画"),
  ];
  assert.equal((await run(notes))[0].note, notes[1]);
  assert.equal(normalizeSimilarityText("**ＡＢＣ**"), "  abc  ");
  const astral = [
    parseNote("x", "# 𠮷野家で食事\n𠮷野家の牛丼"),
    parseNote("y", "# 𠮷野家で食事\n𠮷野家の牛丼"),
  ];
  assert.equal((await run(astral))[0].note, astral[1]);
  const index = new SimilarityIndex();
  await index.sync(astral);
  for (const term of index.documents.get(astral[0].id).terms.keys()) {
    assert.ok(
      !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(
        term,
      ),
    );
  }
});

test("title matches carry more weight than body matches; boilerplate, dates and short/empty notes stay weak", async () => {
  const notes = [
    parseNote("a", "# Kubernetes\ncontainer cluster orchestration"),
    parseNote("b", "# Kubernetes\nunrelated gardening vegetables"),
    parseNote("c", "# Gardening\nKubernetes"),
  ];
  const result = await run(notes, notes[0], 0);
  assert.ok(
    result.find((r) => r.note === notes[1]).score >
      result.find((r) => r.note === notes[2]).score,
  );
  const short = [
    parseNote("s", "# あい"),
    parseNote("t", "# あい"),
    parseNote("e", ""),
    parseNote("g", "# メモ\n[2025-11-01]"),
  ];
  assert.deepEqual(await run(short), []);
  assert.deepEqual(await run(short, short[2]), []);
  const generic = [
    parseNote("g1", "# メモ\n[2025-11-01]"),
    parseNote("g2", "# メモ\n[2025-11-01]"),
  ];
  assert.deepEqual(await run(generic), []);
});

test("incremental cache recalculates DF once per note and remains equivalent to a fresh corpus after edits, saves and deletions", async () => {
  const index = new SimilarityIndex();
  const notes = [
    parseNote("a", "# TypeScript\nTypeScript"),
    parseNote("b", "# TypeScript\ncompiler"),
    parseNote("c", "# 独立\n野菜"),
  ];
  await index.sync(notes);
  assert.equal(index.frequencies.get("w:typescript"), 2);
  const cached = index.documents.get(notes[0].id).terms;
  await index.sync(notes.map((n) => parseNote(n.uri, n.text, 55)));
  assert.equal(
    index.documents.get(notes[0].id).terms,
    cached,
    "saving the same text reuses raw features",
  );
  const revised = [
    notes[0],
    parseNote("b", "# 別の内容\n野菜"),
    parseNote("new", "# TypeScript\ncompiler"),
  ];
  await index.sync(revised);
  const fresh = new SimilarityIndex();
  await fresh.sync(revised);
  assert.deepEqual(
    await index.search(notes[0].id),
    await fresh.search(notes[0].id),
  );
  assert.ok(!index.documents.has(notes[2].id));
  await index.sync([notes[0], notes[1]]); // Undo.
  assert.equal((await index.search(notes[0].id))[0].note.id, notes[1].id);
  index.dispose();
  assert.equal(index.documents.size, 0);
  assert.equal(index.frequencies.size, 0);
});

test("asynchronous work yields and honors obsolete requests", async () => {
  const index = new SimilarityIndex();
  let cancelled = false,
    yielded = false;
  setImmediate(() => {
    cancelled = true;
    yielded = true;
  });
  const large = parseNote(
    "large",
    "# Large\n" + "共通語句とTypeScriptコンパイラ ".repeat(30000),
  );
  assert.equal(await index.sync([large], () => cancelled), false);
  assert.equal(yielded, true);
  await index.sync([parseNote("small", "# TypeScript")]);
  assert.deepEqual(await index.search("small", 10, 0.1, () => true), []);
});

test("heading-less notes, subheadings and code remain inside indexed note boundaries; result limits and empty files are safe", async () => {
  const notes = parseNotes(
    "file:///multiple.md",
    "TypeScript compiler preamble\n# Query\nTypeScript compiler configuration\n# Candidate\n## Subheading\n```markdown\n# TypeScript compiler configuration\n```\n",
  );
  const other = parseNote(
    "file:///headingless.md",
    "TypeScript compiler configuration",
  );
  const empty = parseNote("file:///2025-11-01-123456.md", "");
  const index = new SimilarityIndex();
  await index.sync([...notes, other, empty]);
  assert.equal(notes.length, 2, "code headings do not create candidate notes");
  assert.equal((await index.search(notes[0].id)).length, 2);
  assert.equal((await index.search(notes[0].id, 1)).length, 1);
  assert.deepEqual(await index.search(empty.id), []);
});

test("several thousand notes yield during initial indexing and reuse unchanged features after an edit", async () => {
  const notes = Array.from({ length: 3000 }, (_, i) =>
    parseNote(
      `file:///notes/${i}.md`,
      `# TypeScript compiler ${i}\n型検査とコンパイラの設定について調べる ${i}`,
    ),
  );
  const index = new SimilarityIndex();
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  let start = performance.now();
  await index.sync(notes);
  const initial = performance.now() - start;
  assert.equal(yielded, true);
  const unchanged = index.documents.get(notes[0].id).terms;
  start = performance.now();
  assert.equal((await index.search(notes[0].id)).length, 10);
  const query = performance.now() - start;
  notes[1] = parseNote(notes[1].uri, notes[1].text + "\n未保存の変更");
  start = performance.now();
  await index.sync(notes);
  const delta = performance.now() - start;
  assert.equal(index.documents.get(notes[0].id).terms, unchanged);
  assert.equal(index.documents.size, 3000);
  console.log(
    `3,000 similar notes: index ${Math.round(initial)}ms, query ${Math.round(query)}ms, single edit ${Math.round(delta)}ms`,
  );
  index.dispose();
});
