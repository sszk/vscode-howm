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
    assert.equal(store.notes.size, 2);
    await editor.edit((e) =>
      e.insert(new vscode.Position(3, 0), "未保存の変更\n"),
    );
    assert.ok(store.notes.get(a.uri.toString()).text.includes("未保存の変更"));
    await fs.writeFile(path.join(root, "b.md"), "# B changed\n検索UI\n");
    await store.read(uri);
    assert.equal(store.notes.get(uri.toString()).title, "B changed");
    await fs.unlink(path.join(root, "b.md"));
    await store.read(uri);
    assert.equal(store.notes.has(uri.toString()), false);
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

    console.log(
      "INTEGRATION PASSED: activation, links, completion, undo, dirty overlay, external edit/delete",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};
