const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Store } = require("../dist/storage");
const { SimilarNotesProvider } = require("../dist/similar-notes");
const { OnThisDayProvider } = require("../dist/on-this-day");
const { LocalDayClock } = require("../dist/local-day");

async function until(check, message) {
  for (let retry = 0; retry < 120; retry++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

exports.run = async (base) => {
  const root = path.join(base, "discovery");
  await fs.mkdir(root);
  const uri = vscode.Uri.file(path.join(root, "notes.md"));
  const text =
    "Preamble TypeScript\n# TypeScript compiler\n[2025-11-01]\nTypeScript compiler configuration\n# TypeScript compiler\n[2023-11-01]\nTypeScript compiler configuration\n# Gardening\n[2026-11-01]\nVegetables and fertiliser\n";
  await fs.writeFile(uri.fsPath, text);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("howm.refresh");
  // Native view contributions are usable, including their refresh commands.
  for (const id of ["howm.onThisDay", "howm.similarNotes"]) {
    assert.ok(
      (await vscode.commands.getCommands(true)).includes(`${id}.focus`),
    );
    await vscode.commands.executeCommand(`${id}.focus`);
  }
  await vscode.commands.executeCommand("howm.refreshOnThisDay");
  await vscode.commands.executeCommand("howm.refreshSimilarNotes");
  const store = new Store();
  await store.initialize();
  let day = "2026-11-01";
  const clock = new LocalDayClock(() => day);
  const similar = new SimilarNotesProvider(store);
  const anniversary = new OnThisDayProvider(store, clock, () => day);
  const visibility = new vscode.EventEmitter();
  const view = () => ({
    visible: true,
    onDidChangeVisibility: visibility.event,
  });
  const similarView = view(),
    anniversaryView = view();
  const notes = () => similar.getChildren();
  const past = () =>
    anniversary.getChildren().flatMap((g) => anniversary.getChildren(g));
  const click = async (provider, note) => {
    const item = provider.getTreeItem(note);
    await vscode.commands.executeCommand(
      item.command.command,
      ...item.command.arguments,
    );
  };
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    similar.attach(similarView);
    anniversary.attach(anniversaryView);
    await similar.update();
    assert.equal(notes().length, 1);
    assert.equal(notes()[0].startLine, 4);
    assert.deepEqual(
      anniversary.getChildren().map((g) => g.year),
      [2025, 2023],
    );
    await click(similar, notes()[0]);
    assert.equal(editor.selection.active.line, 4);
    await until(
      () => notes()[0]?.startLine === 1,
      "cursor movement switches to the second memo",
    );
    await click(anniversary, past()[0]);
    assert.equal(editor.selection.active.line, 1);

    const old = past()[1];
    await editor.edit((edit) =>
      edit.insert(new vscode.Position(0, 0), "Unsaved prefix\n"),
    );
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await click(anniversary, old);
    assert.equal(
      editor.selection.active.line,
      0,
      "old line IDs must never open another memo",
    );
    await until(
      () => past()[1]?.startLine === 5,
      "dirty heading positions refresh",
    );
    await click(anniversary, past()[1]);
    assert.equal(editor.selection.active.line, 5);
    assert.ok(doc.isDirty);
    assert.equal(
      await fs.readFile(uri.fsPath, "utf8"),
      text,
      "navigation must not save",
    );
    await vscode.commands.executeCommand("undo");
    await until(
      () => past()[1]?.startLine === 4,
      "undo restores heading positions",
    );
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await similar.update();
    const editEnd = new vscode.Position(6, doc.lineAt(6).text.length);
    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(4, 0, editEnd.line, editEnd.character),
        "# Rust ownership\n[2023-11-02]\nBorrow checker lifetimes",
      ),
    );
    await until(
      () => notes().length === 0 && past().length === 1,
      "unsaved changes update both views",
    );
    await vscode.commands.executeCommand("undo");
    await until(
      () => notes().length === 1 && past().length === 2,
      "undo updates both views",
    );
    await doc.save();
    await until(
      () => store.noteCount === 3,
      "saving must not duplicate sections",
    );

    const external = vscode.Uri.file(path.join(root, "external.md"));
    await fs.writeFile(
      external.fsPath,
      "# TypeScript compiler\n[2022-11-01]\nTypeScript compiler configuration\n",
    );
    await until(
      () => notes().length === 2 && past().length === 3,
      "watcher creation updates both views",
    );
    await fs.writeFile(
      external.fsPath,
      "# Rust ownership\n[2022-11-02]\nBorrow checker lifetimes\n",
    );
    await until(
      () => notes().length === 1 && past().length === 2,
      "external edits update both views",
    );
    await fs.unlink(external.fsPath);
    await until(
      () => !store.files.has(external.toString()),
      "watcher deletion removes cached features",
    );
    await similar.update();
    assert.equal(similar.index.documents.size, 3);

    // Rapid asynchronous calculations must never leave results for an old cursor.
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    const obsolete = similar.update();
    editor.selection = new vscode.Selection(7, 0, 7, 0);
    await similar.update();
    await obsolete;
    assert.deepEqual(notes(), []);
    day = "2026-11-02";
    clock.checkDate();
    assert.deepEqual(past(), []);
    assert.match(anniversaryView.message, /過去の今日のメモはありません/);

    await vscode.workspace
      .getConfiguration("howm")
      .update(
        "similarNotes.autoRefresh",
        false,
        vscode.ConfigurationTarget.Global,
      );
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await similar.refresh();
    assert.equal(
      notes().length,
      1,
      "manual refresh works with autoRefresh off",
    );
    await vscode.workspace
      .getConfiguration("howm")
      .update("similarNotes.maxResults", 1, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("howm")
      .update(
        "similarNotes.minSimilarity",
        1,
        vscode.ConfigurationTarget.Global,
      );
    await until(
      () => notes().length === 0,
      "threshold changes apply immediately",
    );
    await vscode.workspace
      .getConfiguration("howm")
      .update("similarNotes.enabled", false, vscode.ConfigurationTarget.Global);
    assert.equal(similar.index.documents.size, 0);
    await vscode.workspace
      .getConfiguration("howm")
      .update("onThisDay.enabled", false, vscode.ConfigurationTarget.Global);
    assert.match(anniversaryView.message, /無効/);
    assert.equal(clock.timer, undefined);

    // Hidden trees do not render, and re-showing reconciles missed file events.
    similarView.visible = anniversaryView.visible = false;
    visibility.fire({ visible: false });
    await vscode.workspace
      .getConfiguration("howm")
      .update("onThisDay.enabled", true, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("howm")
      .update("similarNotes.enabled", true, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("howm")
      .update(
        "similarNotes.minSimilarity",
        0.1,
        vscode.ConfigurationTarget.Global,
      );
    store.watcher.dispose();
    await fs.writeFile(
      external.fsPath,
      "# TypeScript compiler\n[2022-11-02]\nTypeScript compiler configuration\n",
    );
    let renders = 0;
    const listener = similar.onDidChangeTreeData(() => renders++);
    assert.equal(renders, 0);
    similarView.visible = anniversaryView.visible = true;
    visibility.fire({ visible: true });
    await until(
      () => notes().length === 1 && past().length === 1,
      "re-show refreshes the index and obeys maxResults",
    );
    listener.dispose();
    console.log(
      "DISCOVERY PASSED: native trees, per-section navigation, cursor switches, unsaved edits/undo/save, stale row safety, watcher create/edit/delete, cancellation, date rollover, settings and visibility reconciliation",
    );
  } finally {
    similar.dispose();
    anniversary.dispose();
    clock.dispose();
    store.dispose();
    visibility.dispose();
    for (const key of [
      "similarNotes.enabled",
      "similarNotes.autoRefresh",
      "similarNotes.maxResults",
      "similarNotes.minSimilarity",
      "onThisDay.enabled",
    ]) {
      await vscode.workspace
        .getConfiguration("howm")
        .update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }
};
