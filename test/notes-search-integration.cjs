const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Store } = require("../dist/storage");
const { NotesViewProvider } = require("../dist/notes-view");
const { openNote } = require("../dist/navigation");

async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

exports.run = async (base) => {
  const root = path.join(base, "notes-search");
  await fs.mkdir(root);
  const uri = vscode.Uri.file(path.join(root, "notes.md"));
  const original =
    "Ignored milk\r\n# A\r\n[2026-10-10]\r\n牛乳 milk MILK\r\n# B\r\n[2026-10-11]\r\n😀 milk later\r\n";
  await fs.writeFile(uri.fsPath, original);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("howm.refresh");
  const manifest = vscode.extensions.getExtension(
    "local-howm.markdown-howm",
  ).packageJSON;
  assert.equal(
    manifest.contributes.views.howm.find((view) => view.id === "howm.notes")
      .type,
    "webview",
  );
  assert.equal(
    await vscode.commands.executeCommand("howm.focusNotesSearch"),
    true,
    "native notes webview must load its script and receive focus",
  );

  const store = new Store();
  await store.initialize();
  let receive;
  const posted = [];
  const visibility = new vscode.EventEmitter();
  const disposal = new vscode.EventEmitter();
  const view = {
    visible: false,
    onDidChangeVisibility: visibility.event,
    onDidDispose: disposal.event,
    webview: {
      html: "",
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return new vscode.Disposable(() => {});
      },
    },
  };
  const provider = new NotesViewProvider(store, (note, selection) =>
    openNote(store, note, note.startLine, false, selection),
  );
  const latest = () =>
    posted.filter((message) => message.type === "results").at(-1);
  const click = (result, id) =>
    receive({
      type: "open",
      query: result.query,
      renderId: result.renderId,
      id,
    });
  try {
    provider.resolveWebviewView(view);
    await receive({ type: "ready", query: "milk" });
    assert.equal(latest().count, "2行 · 2メモ");
    assert.ok(!latest().html.includes("Ignored milk"));
    const second = store.all()[1];
    const id = JSON.stringify([second.id, 6]);
    await click(latest(), id);
    const editor = vscode.window.activeTextEditor;
    const doc = editor.document;
    assert.equal(doc.uri.toString(), uri.toString());
    assert.equal(editor.selection.start.line, 6);
    assert.equal(editor.selection.start.character, 3);
    assert.equal(doc.getText(editor.selection), "milk");
    assert.ok(
      editor.visibleRanges.some((range) => range.contains(editor.selection)),
    );

    const old = latest();
    await editor.edit((edit) =>
      edit.insert(new vscode.Position(0, 0), "Inserted preamble\n"),
    );
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const dirty = doc.getText();
    await click(old, id);
    assert.equal(
      editor.selection.start.line,
      0,
      "stale source content must not select a different line",
    );
    assert.equal(doc.getText(), dirty);
    assert.ok(doc.isDirty);
    assert.equal(
      await fs.readFile(uri.fsPath, "utf8"),
      original,
      "search navigation must not save edits",
    );
    await until(
      () => latest().renderId !== old.renderId,
      "dirty editing must update search results",
    );
    const moved = store.all()[1];
    await click(latest(), JSON.stringify([moved.id, 7]));
    assert.equal(editor.selection.start.line, 7);
    assert.equal(doc.getText(editor.selection), "milk");
    await vscode.commands.executeCommand("undo");
    await until(
      () => store.all()[1].startLine === 4,
      "undo must restore original result positions",
    );
    await until(
      () => latest().html.includes('<span class="line">7</span>'),
      "undo must update rendered row numbers",
    );

    await receive({ type: "search", query: "" });
    await click(latest(), JSON.stringify(["note", store.all()[1].id]));
    assert.equal(
      editor.selection.start.line,
      4,
      "cleared search returns to heading navigation",
    );
    await receive({ type: "search", query: "absent" });
    assert.match(latest().html, /一致する行がありません/);

    const external = vscode.Uri.file(path.join(root, "external.md"));
    await receive({ type: "search", query: "External" });
    await fs.writeFile(external.fsPath, "# External\nExternal match\n");
    await until(
      () => latest().count === "2行 · 1メモ",
      "external creation must update an active query",
    );
    const externalNote = store.files.get(external.toString())[0];
    const stale = latest();
    const revised = "# Changed\nRows shifted\nExternal changed\n";
    await fs.writeFile(external.fsPath, revised);
    await click(stale, JSON.stringify([externalNote.id, 1]));
    assert.equal(
      vscode.window.activeTextEditor.document.uri.toString(),
      uri.toString(),
      "stale disk results must not move the active editor",
    );
    await until(
      () => latest().count === "1行 · 1メモ",
      "external edits must update query matches",
    );
    await fs.unlink(external.fsPath);
    await until(
      () => latest().count === "0行 · 0メモ",
      "external deletion must remove all matching rows",
    );
    store.watcher.dispose();
    await fs.writeFile(external.fsPath, "# External\n");
    view.visible = true;
    visibility.fire({ visible: true });
    await until(
      () => latest().count === "1行 · 1メモ",
      "showing the view must restore missed external changes without clearing the query",
    );
    console.log(
      "NOTES SEARCH PASSED: native webview registration/focus, matching range navigation, dirty edits/undo, stale source/disk safety, clear/empty state, external edits/deletion and visibility refresh",
    );
  } finally {
    provider.dispose();
    store.dispose();
    visibility.dispose();
    disposal.dispose();
  }
};
