const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Store } = require("../dist/storage");
const { PinnedNotes } = require("../dist/pinned-notes");
const { PinCommands } = require("../dist/pin-commands");

async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(message);
}
exports.run = async (base) => {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const root = path.join(base, "pinned");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  const a = vscode.Uri.file(path.join(root, "same.md"));
  const b = vscode.Uri.file(path.join(root, "nested", "same.md"));
  const renamed = vscode.Uri.file(path.join(root, "renamed.md"));
  const outside = vscode.Uri.file(path.join(base, "outside-pin.md"));
  const text = "# Pin test\noriginal content\n";
  for (const uri of [a, b, outside]) await fs.writeFile(uri.fsPath, text);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  const store = new Store();
  await store.initialize();
  const values = new Map();
  const state = {
    get: (key, fallback) => values.get(key) ?? fallback,
    update: async (key, value) => {
      values.set(key, value);
    },
  };
  const pins = new PinnedNotes(state, store);
  const commands = new Map();
  const pinCommands = new PinCommands(store, pins, (name, fn) =>
    commands.set(name, fn),
  );
  try {
    // VS Code serializes a Windows drive letter to lower case even when an
    // event URI's path retains its original case. Exercise that with real URIs.
    const originalRoot = store.root;
    store.root = vscode.Uri.parse("file:///C:/notes");
    const windowsNote = vscode.Uri.parse("file:///C:/notes/日本語.md");
    const windowsRenamed = vscode.Uri.parse("file:///C:/notes/renamed.md");
    await pins.pin(windowsNote);
    assert.ok(pins.isPinned(vscode.Uri.parse("file:///c:/notes/日本語.md")));
    await pins.rename([{ oldUri: windowsNote, newUri: windowsRenamed }]);
    assert.ok(pins.isPinned(windowsRenamed));
    await pins.remove([vscode.Uri.parse("file:///C:/notes")]);
    assert.deepEqual(values.get("howm.pinnedNotes"), []);
    store.root = originalRoot;
    await Promise.all([pins.pin(a), pins.pin(b)]);
    assert.equal(values.get("howm.pinnedNotes").length, 2);
    const restarted = new PinnedNotes(state, store);
    assert.ok(restarted.isPinned(a));
    assert.ok(restarted.isPinned(b));
    restarted.dispose();
    const document = await vscode.workspace.openTextDocument(a);
    const editor = await vscode.window.showTextDocument(document);
    // Explicit target must work with another file active; pinning never edits,
    // saves, or moves the selection in either document.
    await commands.get("togglePin")(b);
    assert.equal(pins.isPinned(b), false);
    assert.ok(pins.isPinned(a));
    assert.equal(document.isDirty, false);
    const selection = editor.selection;
    await editor.edit((edit) =>
      edit.insert(new vscode.Position(1, 0), "unsaved "),
    );
    const version = document.version;
    await commands.get("togglePin")();
    assert.equal(pins.isPinned(a), false);
    assert.equal(document.version, version);
    assert.ok(document.isDirty);
    assert.deepEqual(editor.selection, selection);
    assert.equal(await fs.readFile(a.fsPath, "utf8"), text);
    await vscode.commands.executeCommand("undo");
    await until(
      () => document.getText() === text,
      "undo should restore original text",
    );
    const move = new vscode.WorkspaceEdit();
    await pins.pin(a);
    move.renameFile(a, renamed);
    assert.ok(await vscode.workspace.applyEdit(move));
    await until(() => pins.isPinned(renamed), "rename should preserve the pin");
    assert.equal(pins.isPinned(a), false);
    const out = new vscode.WorkspaceEdit();
    out.renameFile(renamed, vscode.Uri.file(path.join(base, "moved-out.md")));
    assert.ok(await vscode.workspace.applyEdit(out));
    await until(
      () => !values.get("howm.pinnedNotes").includes(renamed.toString()),
      "moving outside should remove pin",
    );
    await pins.pin(b);
    await fs.unlink(b.fsPath);
    await until(
      () => !pins.isPinned(b),
      "external watcher deletion should remove pin",
    );
    await pins.pin(outside);
    assert.equal(pins.isPinned(outside), false);
    const manifest = vscode.extensions.getExtension(
      "local-howm.markdown-howm",
    ).packageJSON;
    for (const location of ["editor/title", "editor/context"]) {
      for (const item of manifest.contributes.menus[location]) {
        assert.match(item.when, /resource in howm.noteResources/);
        assert.match(item.when, /howm.pinnedNoteResources/);
      }
    }
    assert.ok((await vscode.commands.getCommands()).includes("howm.togglePin"));
    // Check the registered extension commands also leave the editor untouched.
    const docB = await vscode.workspace.openTextDocument(outside);
    await vscode.window.showTextDocument(docB);
    const outsideVersion = docB.version;
    await vscode.commands.executeCommand("howm.togglePin");
    await vscode.commands.executeCommand("howm.pinNote", outside);
    await vscode.commands.executeCommand("howm.unpinNote", outside);
    assert.equal(docB.version, outsideVersion);
    assert.equal(docB.isDirty, false);
    assert.equal(document.getText(), text);
    console.log(
      "PINNING PASSED: real URI identity, persistence, commands, dirty state, rename/move, watcher deletion, editor menus",
    );
  } finally {
    pinCommands.dispose();
    pins.dispose();
    store.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }
};
