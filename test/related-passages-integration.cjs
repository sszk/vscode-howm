const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Store } = require("../dist/storage");
const { RelatedPassagesProvider } = require("../dist/related-passages");
const phrase =
  "TypeScript compiler configuration supports strict type checking and incremental builds.";
async function until(check, message) {
  for (let i = 0; i < 120; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
exports.run = async (base) => {
  const root = path.join(base, "related-passages");
  await fs.mkdir(root);
  const uri = vscode.Uri.file(path.join(root, "multi.md"));
  const text =
    "# Query\n" +
    phrase +
    "\n# Candidate\n[2025-11-04]\n" +
    phrase +
    "\n# Garden\nGardening vegetables compost fertiliser flowers planting in the garden.\n";
  await fs.writeFile(uri.fsPath, text);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("howm.refresh");
  assert.ok(
    (await vscode.commands.getCommands(true)).includes(
      "howm.relatedPassages.focus",
    ),
  );
  await vscode.commands.executeCommand("howm.relatedPassages.focus");
  await vscode.commands.executeCommand("howm.refreshRelatedPassages");
  const store = new Store();
  await store.initialize();
  let scans = 0;
  store.initialize = async () => {
    scans++;
  };
  const provider = new RelatedPassagesProvider(store);
  const visibility = new vscode.EventEmitter(),
    disposed = new vscode.EventEmitter(),
    received = new vscode.EventEmitter();
  const posted = [];
  const view = {
    visible: true,
    onDidChangeVisibility: visibility.event,
    onDidDispose: disposed.event,
    webview: {
      html: "",
      onDidReceiveMessage: received.event,
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
    },
  };
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const move = (line) => {
    editor.selection = new vscode.Selection(line, 0, line, 0);
  };
  const results = () => provider.results;
  try {
    move(1);
    provider.resolveWebviewView(view);
    received.fire({ type: "ready" });
    await provider.update();
    assert.equal(results().length, 1);
    assert.equal(results()[0].passage.startLine, 4);
    assert.ok(
      posted
        .at(-1)
        .html.includes(vscode.l10n.t("{0} · Line {1}", "2025-11-04", 5)),
    );
    await provider.open(results()[0]);
    assert.equal(
      vscode.window.activeTextEditor.document.uri.toString(),
      uri.toString(),
    );
    assert.equal(editor.selection.active.line, 4);
    assert.ok(!editor.selection.isEmpty);
    await until(
      () => results()[0]?.passage.note.title === "Query",
      "cursor movement searches from the candidate memo",
    );
    move(1);
    await provider.update();

    const external = vscode.Uri.file(path.join(root, "external.md"));
    await fs.writeFile(external.fsPath, "# External\n" + phrase);
    await until(
      () => results().length === 2,
      "file creation updates passage index",
    );
    await fs.writeFile(
      external.fsPath,
      "# External\nGardening vegetables compost flowers planting",
    );
    await until(
      () => results().length === 1,
      "external edit removes unrelated passages",
    );
    await fs.unlink(external.fsPath);
    await until(
      () => !store.files.has(external.toString()),
      "file deletion reaches Store",
    );
    await provider.update();
    assert.ok(
      [...provider.index.notes.values()].every(
        (n) => n.note.uri !== external.toString(),
      ),
    );

    const old = results()[0];
    await editor.edit((edit) =>
      edit.insert(new vscode.Position(0, 0), "Unsaved prefix\n"),
    );
    move(0);
    await provider.open(old);
    assert.equal(
      editor.selection.active.line,
      0,
      "stale snapshot must never use its old line",
    );
    assert.ok(doc.isDirty);
    assert.equal(
      await fs.readFile(uri.fsPath, "utf8"),
      text,
      "search and navigation never save",
    );
    await vscode.commands.executeCommand("undo");
    await until(() => doc.getText() === text, "undo restores memo boundaries");
    move(1);
    await provider.update();
    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(4, 0, 4, doc.lineAt(4).text.length),
        "Gardening vegetables compost flowers planting",
      ),
    );
    move(1);
    await until(
      () => !results().length && !provider.timer,
      "unsaved candidate changes refresh results",
    );
    await vscode.commands.executeCommand("undo");
    await until(() => doc.getText() === text, "undo restores candidate");
    move(1);
    await until(() => results().length === 1, "undo restores related passages");
    await vscode.commands.executeCommand("redo");
    await until(
      () => !results().length && !provider.timer,
      "redo removes related passage again",
    );
    await vscode.commands.executeCommand("undo");
    await until(() => doc.getText() === text, "restore original text");
    move(1);
    await provider.update();

    const obsolete = provider.update();
    move(6);
    await provider.update();
    await obsolete;
    assert.equal(
      results().length,
      0,
      "an old async search cannot overwrite the latest cursor",
    );
    view.visible = false;
    visibility.fire({ visible: false });
    const renders = posted.length;
    move(1);
    await provider.refresh();
    assert.equal(posted.length, renders);
    view.visible = true;
    visibility.fire({ visible: true });
    await until(
      () => results().length === 1,
      "re-show searches from the latest cursor",
    );
    assert.equal(
      scans,
      0,
      "cursor, refresh and re-show must never rescan all files",
    );
    console.log(
      "RELATED PASSAGES PASSED: view registration, excerpts, range navigation, cursor, dirty edits, undo/redo, stale rows, watcher create/edit/delete, cancellation, visibility and no rescans",
    );
  } finally {
    provider.dispose();
    store.dispose();
    visibility.dispose();
    disposed.dispose();
    received.dispose();
  }
};
