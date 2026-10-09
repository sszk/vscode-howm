const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Store } = require("../dist/storage");
const { TodoProvider } = require("../dist/todos");
const { dateString, dayNumber } = require("../dist/core");

async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
exports.run = async (base) => {
  const root = path.join(base, "sidebar");
  await fs.mkdir(root, { recursive: true });
  const today = dateString();
  const tomorrow = new Date((dayNumber(today) + 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  const yesterday = new Date((dayNumber(today) - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  const text = `# Sidebar\n[${today}]!7 Deadline\n[${today}]+ Active task\n[${tomorrow}]+ Future task\n[${yesterday}]@ Past event\n[${today}]-\n[${today}]. Already done\n`;
  const workUri = vscode.Uri.file(path.join(root, "work.md"));
  const otherUri = vscode.Uri.file(path.join(root, "other.md"));
  await fs.writeFile(workUri.fsPath, text);
  await fs.writeFile(otherUri.fsPath, `# Other\n[${today}]@ Appointment\n`);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  assert.equal(
    await vscode.commands.executeCommand("howm.showTodos"),
    true,
    "registered sidebar must become visible",
  );
  const manifest = vscode.extensions.getExtension(
    "local-howm.markdown-howm",
  ).packageJSON;
  assert.deepEqual(
    manifest.contributes.views.howm.map((v) => v.id),
    ["howm.todos", "howm.notes"],
  );
  assert.ok(
    manifest.contributes.viewsContainers.activitybar.some(
      (c) => c.id === "howm",
    ),
  );

  const store = new Store();
  let day = today;
  const provider = new TodoProvider(store, () => day);
  const visibility = new vscode.EventEmitter();
  const view = {
    visible: false,
    onDidChangeVisibility: visibility.event,
    message: undefined,
    description: undefined,
  };
  provider.attach(view);
  const entries = () =>
    provider.getChildren().flatMap((g) => provider.getChildren(g));
  try {
    const first = store.initialize();
    assert.equal(
      first,
      store.initialize(),
      "simultaneous refreshes should share a promise",
    );
    await first;
    provider.update();
    assert.deepEqual(
      provider.getChildren().map((g) => g.id),
      ["todos", "schedule", "hidden"],
    );
    const { noteTreeItem } = require("../dist/notes");
    const { parseNote } = require("../dist/core");
    const dated = parseNote(
      workUri.toString(),
      `# Dated note\n\n[2026-09-21 14:30]\n[${today}]! Deadline\n`,
    );
    const memoItem = noteTreeItem(dated);
    assert.equal(memoItem.label, "Dated note");
    assert.equal(memoItem.description, "2026-09-21");
    assert.ok(memoItem.tooltip.includes("メモ内の日付: 2026-09-21"));
    assert.equal(memoItem.command.command, "vscode.open");
    assert.equal(memoItem.resourceUri.toString(), workUri.toString());
    const groups = provider.getChildren();
    assert.equal(
      provider.getTreeItem(groups[0]).collapsibleState,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    assert.equal(
      provider.getTreeItem(groups[2]).collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const blank = entries().find((e) => !e.reminder.text);
    assert.equal(provider.getTreeItem(blank).label, "本文なし");
    assert.ok(!entries().some((e) => e.reminder.text === "Already done"));
    const target = entries().find((e) => e.reminder.text === "Active task");
    const item = provider.getTreeItem(target);
    assert.equal(item.contextValue, "howm.reminder");
    assert.ok(item.tooltip.includes(`${workUri.fsPath}:3`));
    await vscode.commands.executeCommand(
      item.command.command,
      ...item.command.arguments,
    );
    assert.equal(
      vscode.window.activeTextEditor.document.uri.toString(),
      workUri.toString(),
    );
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 2);
    const targetDoc = vscode.window.activeTextEditor.document;
    const otherDoc = await vscode.workspace.openTextDocument(otherUri);
    const otherEditor = await vscode.window.showTextDocument(otherDoc);
    await otherEditor.edit((b) =>
      b.insert(new vscode.Position(0, 0), "Unsaved other edit\n"),
    );
    await vscode.commands.executeCommand("howm.completeReminder", target);
    assert.equal(
      vscode.window.activeTextEditor.document.uri.toString(),
      otherUri.toString(),
    );
    assert.ok(otherDoc.isDirty);
    assert.ok(targetDoc.isDirty);
    assert.match(
      targetDoc.getText(),
      new RegExp(`\\[${today}\\]\\. \\[${today}\\]:\\+ Active task`),
    );
    assert.equal(
      await fs.readFile(workUri.fsPath, "utf8"),
      text,
      "completion must not save",
    );
    await until(
      () => !entries().some((e) => e.reminder.text === "Active task"),
      "completed task should disappear automatically",
    );
    const targetEditor = await vscode.window.showTextDocument(targetDoc);
    await vscode.commands.executeCommand("undo");
    assert.equal(targetDoc.getText(), text);
    await until(
      () => entries().some((e) => e.reminder.text === "Active task"),
      "undo should restore the task",
    );

    const stale = entries().find((e) => e.reminder.text === "Active task");
    await targetEditor.edit((b) =>
      b.insert(new vscode.Position(0, 0), "Shift rows\n"),
    );
    const shifted = targetDoc.getText();
    await vscode.commands.executeCommand("howm.completeReminder", stale);
    assert.equal(
      targetDoc.getText(),
      shifted,
      "stale completion must not edit another row",
    );
    await until(
      () =>
        entries().some(
          (e) => e.reminder.text === "Active task" && e.reminder.line === 3,
        ),
      "stale items should update",
    );
    const refreshed = entries().find((e) => e.reminder.text === "Active task");
    await vscode.window.showTextDocument(otherDoc);
    await vscode.commands.executeCommand("howm.completeReminder", refreshed);
    assert.ok(targetDoc.getText().startsWith("Shift rows\n"));
    assert.ok(
      targetDoc.isDirty && otherDoc.isDirty,
      "existing unsaved edits must be preserved",
    );
    assert.equal(await fs.readFile(workUri.fsPath, "utf8"), text);

    const externalUri = vscode.Uri.file(path.join(root, "external.md"));
    await fs.writeFile(
      externalUri.fsPath,
      `# External\n[${today}]+ External add\n`,
    );
    await until(
      () => entries().some((e) => e.reminder.text === "External add"),
      "external creation should update the tree",
    );
    await fs.writeFile(
      externalUri.fsPath,
      `# External\n[${today}]+ External change\n`,
    );
    await until(
      () => entries().some((e) => e.reminder.text === "External change"),
      "external edits should update the tree",
    );
    const diskStale = entries().find(
      (e) => e.reminder.text === "External change",
    );
    const diskEdited = `# External\nShift on disk\n[${today}]+ External change\n`;
    await fs.writeFile(externalUri.fsPath, diskEdited);
    await vscode.commands.executeCommand("howm.completeReminder", diskStale);
    assert.equal(
      await fs.readFile(externalUri.fsPath, "utf8"),
      diskEdited,
      "stale disk content must not be completed",
    );
    const externalDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === externalUri.toString(),
    );
    assert.ok(!externalDoc?.isDirty);
    await until(
      () =>
        entries().some(
          (e) => e.reminder.text === "External change" && e.reminder.line === 2,
        ),
      "disk changes should refresh the stale row",
    );
    const removed = entries().find(
      (e) => e.reminder.text === "External change",
    );
    await fs.unlink(externalUri.fsPath);
    await vscode.commands.executeCommand("howm.completeReminder", removed);
    await until(
      () => !entries().some((e) => e.note.uri === externalUri.toString()),
      "deleted notes should disappear",
    );
    assert.equal(
      await fs.stat(externalUri.fsPath).then(
        () => true,
        () => false,
      ),
      false,
    );

    day = tomorrow;
    provider.checkDate();
    assert.ok(
      provider
        .getChildren()
        .find((g) => g.id === "todos")
        .entries.some((e) => e.reminder.text === "Future task"),
    );

    // Simulate lost notifications, then verify visibility-triggered reconciliation.
    store.watcher.dispose();
    await fs.writeFile(
      externalUri.fsPath,
      `# External\n[${today}]+ Found on show\n`,
    );
    view.visible = true;
    visibility.fire({ visible: true });
    await until(
      () => entries().some((e) => e.reminder.text === "Found on show"),
      "showing the view should recover missed notifications",
    );
    view.visible = false;
    visibility.fire({ visible: false });
    assert.equal(provider.dayTimer, undefined);

    const missing = path.join(base, "missing-sidebar-root");
    await vscode.workspace
      .getConfiguration("howm")
      .update("notesDirectory", missing, vscode.ConfigurationTarget.Global);
    await provider.refresh();
    assert.equal(provider.getChildren().length, 0);
    assert.match(view.message, /保存先を読み込めません/);
    assert.ok(view.message.includes(missing));
    await fs.mkdir(missing);
    await fs.writeFile(
      path.join(missing, "recovered.md"),
      `[${today}]+ Recovered\n`,
    );
    await provider.refresh();
    assert.ok(entries().some((e) => e.reminder.text === "Recovered"));
    assert.equal(store.error, undefined);
    assert.equal(view.message, undefined);
    await fs.writeFile(
      path.join(missing, "after-recovery.md"),
      `[${today}]+ Watched after recovery\n`,
    );
    await until(
      () => entries().some((e) => e.reminder.text === "Watched after recovery"),
      "a newly created root must resume automatic watching",
    );

    console.log(
      "SIDEBAR PASSED: native view registration/focus, grouping, open row, completion/undo without saving, stale/deleted item safety, live external updates, day rollover, visibility refresh, error recovery",
    );
  } finally {
    provider.dispose();
    store.dispose();
    visibility.dispose();
  }
};
