const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
exports.run = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "howm-notes-"));
  try {
    const ext = vscode.extensions.getExtension("local-howm.markdown-howm");
    assert.ok(ext);
    await ext.activate();
    await vscode.workspace
      .getConfiguration("howm")
      .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
    await fs.writeFile(
      path.join(root, "a.md"),
      "# A\n<<< 検索UI\n[2026-10-15]!7 試作\n",
    );
    await fs.writeFile(path.join(root, "b.md"), "# B\n検索UIについて\n");
    await vscode.commands.executeCommand("howm.refresh");
    const uri = vscode.Uri.file(path.join(root, "b.md"));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const links = await vscode.commands.executeCommand(
      "vscode.executeLinkProvider",
      uri,
    );
    assert.ok(links.some((l) => l.target?.scheme === "command"));
    const a = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(root, "a.md")),
    );
    const editor = await vscode.window.showTextDocument(a);
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand("howm.complete");
    assert.match(a.getText(), /\]\. \[2026-10-15\]:!7/);
    await vscode.commands.executeCommand("undo");
    assert.match(a.getText(), /\[2026-10-15\]!7/);
    const { Store } = require("../dist/storage");
    const store = new Store();
    await store.initialize();
    assert.equal(store.noteCount, 2);
    await editor.edit((e) =>
      e.insert(new vscode.Position(3, 0), "未保存の変更\n"),
    );
    assert.ok(store.files.get(a.uri.toString())[0].text.includes("未保存の変更"));
    await fs.writeFile(path.join(root, "b.md"), "# B changed\n検索UI\n");
    await store.read(uri);
    assert.equal(store.files.get(uri.toString())[0].title, "B changed");
    await fs.unlink(path.join(root, "b.md"));
    await store.read(uri);
    assert.equal(store.files.has(uri.toString()), false);
    store.dispose();
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor",
    );
    await vscode.workspace
      .getConfiguration("howm")
      .update("filenamePattern", "fixed.md", vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("howm.create", "Created title");
    await vscode.commands.executeCommand("howm.create", "Second title");
    assert.match(
      await fs.readFile(path.join(root, "fixed.md"), "utf8"),
      /# Created title/,
    );
    assert.match(
      await fs.readFile(path.join(root, "fixed-1.md"), "utf8"),
      /# Second title/,
    );
    await vscode.commands.executeCommand("howm.list");
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    await vscode.commands.executeCommand("howm.concatenate");
    const virtual = vscode.window.activeTextEditor.document;
    assert.equal(virtual.uri.scheme, "howm");
    assert.ok(virtual.getText().includes("Created title"));
    const sourceLinks = await vscode.commands.executeCommand(
      "vscode.executeLinkProvider",
      virtual.uri,
    );
    assert.equal(sourceLinks.length, 3);
    for (const link of sourceLinks)
      assert.ok(virtual.getText(link.range).startsWith("元のメモを開く:"));

    const watcherStore = new Store();
    await watcherStore.initialize();
    await fs.writeFile(
      path.join(root, "todo.md"),
      `# Todo test\n[2000-01-01]+ パレット表示の検証\n`,
    );
    for (
      let retry = 0;
      retry < 100 &&
      !watcherStore.files.has(
        vscode.Uri.file(path.join(root, "todo.md")).toString(),
      );
      retry++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      watcherStore.files.has(
        vscode.Uri.file(path.join(root, "todo.md")).toString(),
      ),
      "new notes should be indexed automatically by the watcher",
    );
    watcherStore.dispose();
    const reminderCommand = vscode.commands.executeCommand("howm.reminders");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await vscode.commands.executeCommand(
      "workbench.action.acceptSelectedQuickOpenItem",
    );
    await reminderCommand;
    assert.equal(
      vscode.window.activeTextEditor.document.uri.fsPath,
      path.join(root, "todo.md"),
    );
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 1);

    // Start with a missing directory, then create notes there. Opening the
    // reminder picker must find them even if filesystem notifications lag.
    const freshRoot = path.join(root, "new-notes");
    await vscode.workspace
      .getConfiguration("howm")
      .update("notesDirectory", freshRoot, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("howm.refresh");
    await fs.mkdir(path.join(freshRoot, "nested"), { recursive: true });
    const freshTodo = path.join(freshRoot, "nested", "fresh.md");
    await fs.writeFile(
      freshTodo,
      "# Newly created\n[2000-01-01]+ 新しい保存先のTodo\n",
    );
    const freshCommand = vscode.commands.executeCommand("howm.reminders");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vscode.commands.executeCommand(
      "workbench.action.acceptSelectedQuickOpenItem",
    );
    await freshCommand;
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, freshTodo);
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 1);

    await require("./sidebar-integration.cjs").run(root);
    await require("./multi-note-integration.cjs").run(root);
    await require("./notes-search-integration.cjs").run(root);

    console.log(
      "INTEGRATION PASSED: activation, links, completion, undo, dirty overlay, external edit/delete, reminder picker selection",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};
