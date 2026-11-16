const vscode = require("vscode");
const assert = require("node:assert/strict");
exports.run = async () => {
  const extension = vscode.extensions.getExtension("local-howm.markdown-howm");
  await extension.activate();
  assert.equal(
    vscode.env.language,
    process.env.HOWM_TEST_LOCALE,
    "Install the requested language pack in VSCODE_TEST_EXTENSIONS_DIR before running this locale",
  );
  const ja = vscode.env.language.split("-")[0] === "ja";
  assert.equal(vscode.l10n.t("Loading…"), ja ? "読み込み中…" : "Loading…");
  assert.equal(
    vscode.l10n.t("Notes for {0} ({1})", "2026-11-16", 2),
    ja ? "2026-11-16 のメモ (2)" : "Notes for 2026-11-16 (2)",
  );
  const dictionary = require(`../package.nls${ja ? ".ja" : ""}.json`);
  const contributions = extension.packageJSON.contributes;
  for (const command of contributions.commands) {
    assert.equal(
      typeof command.title === "string" ? command.title : command.title.value,
      dictionary[`${command.command}.title`],
    );
  }
  for (const [key, property] of Object.entries(
    contributions.configuration.properties,
  )) {
    assert.equal(property.description, dictionary[`${key}.description`]);
  }
  assert.equal(
    contributions.configuration.properties["howm.defaultTitle"].default,
    "メモ",
  );
  const { modelText, calendarMonth } = require("../dist/localization");
  assert.equal(modelText("メモ内の日付"), ja ? "メモ内の日付" : "Date in note");
  assert.equal(calendarMonth("2026-11"), ja ? "2026年11月" : "November 2026");
  const { NotesViewProvider } = require("../dist/notes-view");
  const provider = Object.create(NotesViewProvider.prototype);
  provider.query = "";
  const html = provider.html();
  assert.ok(html.includes(ja ? "全文検索…" : "Search all text…"));
  assert.ok(html.includes(`lang="${ja ? "ja" : "en"}"`));
  console.log(
    `LOCALIZATION PASSED: ${vscode.env.language}, runtime bundle, manifest, settings, dates, webview, unchanged default title`,
  );
};
