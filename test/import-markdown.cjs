const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { parseNotes, noteDisplayDate, search } = require("../dist/core");
const execute = promisify(execFile);
const script = path.resolve(__dirname, "../scripts/import-markdown.pl");

async function run(args, timezone = "UTC") {
  try {
    const result = await execute("perl", [script, ...args], {
      env: { ...process.env, TZ: timezone },
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("CLI uses actual ctime in JST in every system timezone, and its output is usable by howm", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "howm-import-"));
  try {
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const source = path.join(
      root,
      `${today.replaceAll("-", "")} 日本語 with spaces.md`,
    );
    const content = Buffer.from(
      "\uFEFF# 買い物\r\n<<< 牛乳\r\n[2000-01-01]+ 牛乳を買う\r\n# 読書\r\n[2010-02-03]\r\n読みたい本\r\n",
      "utf8",
    );
    await fs.writeFile(source, content);
    const before = await fs.stat(source);
    const jst = new Date(
      Math.floor(before.ctimeMs / 1000) * 1000 + 9 * 3600000,
    );
    const ctimeDay = jst.toISOString().slice(0, 10);
    const time =
      ctimeDay === today
        ? jst.toISOString().slice(11, 19).replaceAll(":", "")
        : "000000";
    for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      const destination = path.join(
        root,
        "保存先 " + timezone.replaceAll("/", "-"),
      );
      const result = await run([destination, source], timezone);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.ok(result.stdout.includes(source));
      const output = path.join(
        destination,
        today.slice(0, 4),
        today.slice(5, 7),
        `${today}-${time}.md`,
      );
      const bytes = await fs.readFile(output);
      assert.deepEqual(bytes, content);
      const notes = parseNotes(
        pathToFileURL(output).href,
        new TextDecoder().decode(bytes),
      );
      assert.deepEqual(
        notes.map((note) => note.title),
        ["買い物", "読書"],
      );
      assert.equal(noteDisplayDate(notes[0]).date, today);
      assert.equal(noteDisplayDate(notes[1]).date, "2010-02-03");
      assert.equal(notes[0].reminders[0].text, "牛乳を買う");
      assert.equal(search(notes, "読みたい本")[0], notes[1]);
    }
    assert.deepEqual(await fs.readFile(source), content);
    assert.equal((await fs.stat(source)).ctimeMs, before.ctimeMs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI continues past invalid inputs, keeps existing output, and numbers same-day files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "howm-import-"));
  try {
    const destination = path.join(root, "output");
    const directory = path.join(destination, "2000", "01");
    await fs.mkdir(directory, { recursive: true });
    const existing = path.join(directory, "2000-01-01-000000.md");
    await fs.writeFile(existing, "# Existing\n");
    const a = path.join(root, "20000101-first.txt"),
      b = path.join(root, "20000101-second.md");
    await fs.writeFile(a, "# First\n");
    await fs.writeFile(b, "# Second\n");
    const invalidDate = path.join(root, "20000230-invalid.md"),
      invalidUtf8 = path.join(root, "20000102-invalid.md");
    await fs.writeFile(invalidDate, "# Invalid\n");
    await fs.writeFile(invalidUtf8, Buffer.from([255]));
    const result = await run([
      destination,
      path.join(root, "missing.md"),
      invalidDate,
      invalidUtf8,
      root,
      a,
      b,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Copied: 2; Failed: 4/);
    assert.match(result.stderr, /invalid date in filename/);
    assert.match(result.stderr, /not valid UTF-8/);
    assert.equal(await fs.readFile(existing, "utf8"), "# Existing\n");
    assert.equal(
      await fs.readFile(path.join(directory, "2000-01-01-000000-1.md"), "utf8"),
      "# First\n",
    );
    assert.equal(
      await fs.readFile(path.join(directory, "2000-01-01-000000-2.md"), "utf8"),
      "# Second\n",
    );
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      "2000-01-01-000000-1.md",
      "2000-01-01-000000-2.md",
      "2000-01-01-000000.md",
    ]);
    const usage = await run([]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /Usage:/);
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /JST/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("simultaneous imports allocate different files without overwriting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "howm-import-"));
  try {
    const source = path.join(root, "20000101-note.md"),
      destination = path.join(root, "output");
    const directory = path.join(destination, "2000", "01");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(source, "# Shared\n");
    const results = await Promise.all([
      run([destination, source]),
      run([destination, source]),
    ]);
    assert.deepEqual(
      results.map((result) => result.code),
      [0, 0],
    );
    const files = (await fs.readdir(directory)).sort();
    assert.deepEqual(files, ["2000-01-01-000000-1.md", "2000-01-01-000000.md"]);
    for (const name of files)
      assert.equal(
        await fs.readFile(path.join(directory, name), "utf8"),
        "# Shared\n",
      );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
