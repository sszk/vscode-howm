const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const vm = require("node:vm");
const { localization } = require("./localization-fixture.cjs");
const api = {
  ...localization("en"),
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
};
const original = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? api : original.call(this, name, ...args);
};
const ui = require("../dist/localization");
const pin = require("../dist/pin-ui");
const { CalendarProvider } = require("../dist/calendar");
const { NotesViewProvider } = require("../dist/notes-view");
const { SimilarNotesViewProvider } = require("../dist/similar-notes-view");
const { RelatedPassagesProvider } = require("../dist/related-passages");
Module._load = original;

for (const language of ["en", "ja", "fr"]) {
  test(`${language}: webviews, dates, model labels, errors and pin updates follow the UI language`, () => {
    api.env.language = language;
    const ja = language === "ja";
    assert.equal(ui.uiLanguage(), ja ? "ja" : "en");
    assert.equal(
      ui.calendarMonth("2026-11"),
      ja ? "2026年11月" : "November 2026",
    );
    assert.deepEqual(
      ui.calendarWeekdays("sunday"),
      ja
        ? ["日", "月", "火", "水", "木", "金", "土"]
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    );
    assert.equal(
      ui.modelText("メモ内の日付"),
      ja ? "メモ内の日付" : "Date in note",
    );
    assert.equal(
      ui.errorMessage(new Error("正規表現検索が時間制限（2秒）を超えました")),
      ja
        ? "正規表現検索が時間制限（2秒）を超えました"
        : "Regular expression search exceeded the time limit (2 seconds)",
    );
    const userText = "# メモ <user>&";
    assert.equal(ui.modelText(userText), userText);
    for (const Provider of [
      NotesViewProvider,
      SimilarNotesViewProvider,
      RelatedPassagesProvider,
    ]) {
      const provider = Object.create(Provider.prototype);
      provider.query = "";
      const html = provider.html();
      assert.ok(html.includes(`lang="${ja ? "ja" : "en"}"`));
      assert.ok(html.includes("default-src 'none'"));
      if (!ja) assert.doesNotMatch(html, /[ぁ-んァ-ヶ一-龠]/);
      if (Provider === NotesViewProvider)
        assert.ok(html.includes(ja ? "全文検索…" : "Search all text…"));
    }
    const calendar = new CalendarProvider(
      { all: () => [], root: {}, onChange: () => ({ dispose() {} }) },
      async () => {},
    );
    try {
      const view = { webview: { html: "" } };
      calendar.view = view;
      calendar.render();
      assert.ok(
        view.webview.html.includes(
          ja ? "該当するメモはありません。" : "No notes for this date.",
        ),
      );
      if (!ja) assert.doesNotMatch(view.webview.html, /[ぁ-んァ-ヶ一-龠]/);
    } finally {
      calendar.dispose();
    }
    const button = {
      dataset: { pinId: "note" },
      setAttribute(key, value) {
        this[key] = value;
      },
    };
    const context = {
      document: { querySelectorAll: () => [button] },
      window: { addEventListener() {} },
    };
    vm.runInNewContext(pin.pinUpdateScript(), context);
    context.updatePins(["note"]);
    assert.equal(button.title, ja ? "ピン留めを解除" : "Unpin Note");
    context.updatePins([]);
    assert.equal(button.title, ja ? "メモをピン留め" : "Pin Note");
    assert.ok(
      pin.pinButton("note", false).includes(`aria-label="${button.title}"`),
    );
  });
}

test("translated pin labels stay safe in both HTML and inline scripts", () => {
  const translate = api.l10n.t;
  const hostile = `"'<&</script>\u2028\u2029`;
  api.l10n.t = () => hostile;
  try {
    const html = pin.pinButton("note", false);
    assert.ok(html.includes("&quot;&#39;&lt;&amp;&lt;/script&gt;"));
    const script = pin.pinUpdateScript();
    assert.ok(!script.includes("</script>"));
    const button = { dataset: { pinId: "note" }, setAttribute() {} };
    const context = {
      document: { querySelectorAll: () => [button] },
      window: { addEventListener() {} },
    };
    vm.runInNewContext(script, context);
    context.updatePins([]);
    assert.equal(button.title, hostile);
  } finally {
    api.l10n.t = translate;
  }
});

test("translation checker rejects missing, unused and mismatched entries without changing translations", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const root = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "howm-l10n-check-"));
  try {
    for (const file of [
      "src",
      "l10n",
      "package.json",
      "package.nls.json",
      "package.nls.ja.json",
    ])
      await fs.cp(path.join(root, file), path.join(temp, file), {
        recursive: true,
      });
    const dictionary = require("../l10n/bundle.l10n.ja.json");
    const file = path.join(temp, "l10n/bundle.l10n.ja.json");
    for (const [mutate, expected] of [
      [
        (value) => {
          delete value["Loading…"];
        },
        /missing Loading…/,
      ],
      [
        (value) => {
          value["Obsolete message"] = "不要";
        },
        /unused Obsolete message/,
      ],
      [
        (value) => {
          value["Notes for {0} ({1})"] = "{0}";
        },
        /placeholder mismatch/,
      ],
    ]) {
      const value = { ...dictionary };
      mutate(value);
      const text = JSON.stringify(value);
      await fs.writeFile(file, text);
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/check-l10n.cjs")],
        { cwd: temp, encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expected);
      assert.equal(await fs.readFile(file, "utf8"), text);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
