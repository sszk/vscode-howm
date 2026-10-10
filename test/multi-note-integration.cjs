const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Store } = require("../dist/storage");
const { TodoProvider } = require("../dist/todos");
const { noteTreeItem } = require("../dist/notes");
const { dateString } = require("../dist/core");

async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
async function concatenateResults(command, ...args) {
  await vscode.commands.executeCommand(command, ...args);
  await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await vscode.commands.executeCommand("howm.concatenate");
  const doc = vscode.window.activeTextEditor.document;
  assert.equal(doc.uri.scheme, "howm");
  const links = await vscode.commands.executeCommand(
    "vscode.executeLinkProvider",
    doc.uri,
  );
  return { doc, links };
}

exports.run = async (base) => {
  const root = path.join(base, "multi-note");
  await fs.mkdir(root);
  const today = dateString();
  const uri = vscode.Uri.file(path.join(root, "multiple.md"));
  const text = [
    "Ignored preamble",
    "[2000-01-01]+ IgnoredTask",
    "<<< IgnoredKeyword",
    "# Same",
    `[${today}]`,
    "<<< SharedTopic",
    "[2000-01-01]+ FirstTask",
    "# Same",
    `[${today}]`,
    ">>> SharedTopic",
    "[2000-01-01]+ SecondTask",
    "",
  ].join("\n");
  await fs.writeFile(uri.fsPath, text);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("howm.refresh");
  const store = new Store();
  const provider = new TodoProvider(store);
  const entries = () =>
    provider.getChildren().flatMap((group) => provider.getChildren(group));
  try {
    await store.initialize();
    provider.update();
    assert.equal(store.files.size, 1);
    assert.equal(store.noteCount, 2);
    assert.deepEqual(store.keywords(), ["SharedTopic"]);
    const [first, second] = store.all();
    assert.equal(first.startLine, 3);
    assert.equal(second.startLine, 7);
    assert.notEqual(noteTreeItem(first).id, noteTreeItem(second).id);
    assert.equal(noteTreeItem(second).description, today);
    assert.ok(noteTreeItem(second).tooltip.includes(":8"));
    const item = noteTreeItem(second);
    await vscode.commands.executeCommand(
      item.command.command,
      ...item.command.arguments,
    );
    assert.equal(
      vscode.window.activeTextEditor.document.uri.toString(),
      uri.toString(),
    );
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 7);
    const doc = vscode.window.activeTextEditor.document;
    const links = await vscode.commands.executeCommand(
      "vscode.executeLinkProvider",
      uri,
    );
    assert.deepEqual(
      links
        .filter((link) => link.target?.scheme === "command")
        .map((link) => link.range.start.line),
      [5, 9],
    );
    assert.deepEqual(
      entries().map((entry) => entry.reminder.text),
      ["FirstTask", "SecondTask"],
    );

    // Search previews and acceptance must land in the matching section.
    vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("howm.search", "SecondTask");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await vscode.commands.executeCommand(
      "workbench.action.quickOpenSelectNext",
    );
    await until(
      () =>
        vscode.window.activeTextEditor?.document.uri.toString() ===
          uri.toString() &&
        vscode.window.activeTextEditor.selection.active.line === 7,
      "search preview should open the second heading",
    );
    await vscode.commands.executeCommand(
      "workbench.action.acceptSelectedQuickOpenItem",
    );
    await until(
      () => vscode.window.activeTextEditor.selection.active.line === 7,
      "search selection should open the second heading",
    );

    const regex = await concatenateResults(
      "howm.searchRegex",
      "FirstTask|SecondTask",
    );
    assert.equal(regex.links.length, 2);
    assert.ok(!regex.doc.getText().includes("Ignored preamble"));
    for (const link of regex.links)
      assert.ok(regex.doc.getText(link.range).startsWith("元のメモを開く:"));
    const target = regex.links[1].target;
    await vscode.commands.executeCommand(
      target.path,
      ...JSON.parse(decodeURIComponent(target.query)),
    );
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 7);
    vscode.window.activeTextEditor.selection = new vscode.Selection(3, 0, 3, 0);
    const related = await concatenateResults("howm.related");
    assert.equal(related.links.length, 1);
    assert.ok(related.doc.getText().includes("SecondTask"));
    assert.ok(!related.doc.getText().includes("FirstTask"));

    // Complete a later section from another dirty editor without saving either.
    const otherUri = vscode.Uri.file(path.join(root, "other.md"));
    await fs.writeFile(otherUri.fsPath, "# Other\n");
    const other = await vscode.workspace.openTextDocument(otherUri);
    const otherEditor = await vscode.window.showTextDocument(other);
    await otherEditor.edit((edit) =>
      edit.insert(new vscode.Position(1, 0), "Unsaved other\n"),
    );
    const task = entries().find(
      (entry) => entry.reminder.text === "SecondTask",
    );
    assert.equal(task.note.id, second.id);
    await vscode.commands.executeCommand("howm.completeReminder", task);
    assert.equal(vscode.window.activeTextEditor.document, other);
    assert.ok(doc.isDirty && other.isDirty);
    assert.ok(doc.getText().includes(`[${today}]. [2000-01-01]:+ SecondTask`));
    assert.ok(doc.getText().includes("[2000-01-01]+ FirstTask"));
    assert.equal(await fs.readFile(uri.fsPath, "utf8"), text);
    await until(
      () => !entries().some((entry) => entry.reminder.text === "SecondTask"),
      "completion should remove only the selected task",
    );
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("undo");
    assert.equal(doc.getText(), text);
    await until(
      () => entries().some((entry) => entry.reminder.text === "SecondTask"),
      "undo should restore a task from the second section",
    );
    editor.selection = new vscode.Selection(10, 0, 10, 0);
    await vscode.commands.executeCommand("howm.complete");
    assert.ok(doc.getText().includes(`[${today}]. [2000-01-01]:+ SecondTask`));
    await vscode.commands.executeCommand("undo");
    assert.equal(doc.getText(), text);

    // Even a change to an earlier section must invalidate a later cached item.
    const stale = entries().find(
      (entry) => entry.reminder.text === "SecondTask",
    );
    const staleNote = store.files.get(uri.toString())[1];
    await editor.edit((edit) =>
      edit.insert(
        new vscode.Position(7, 0),
        "# Added\n[2000-01-01]+ AddedTask\n",
      ),
    );
    const shifted = doc.getText();
    await vscode.commands.executeCommand("howm.completeReminder", stale);
    assert.equal(doc.getText(), shifted);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("howm.openNote", staleNote);
    assert.equal(
      editor.selection.active.line,
      0,
      "stale navigation must not open a different heading",
    );
    assert.equal(store.files.get(uri.toString()).length, 3);
    await until(
      () =>
        entries().some(
          (entry) =>
            entry.reminder.text === "SecondTask" && entry.reminder.line === 12,
        ),
      "heading insertion should refresh absolute reminder positions",
    );
    const refreshed = entries().find(
      (entry) => entry.reminder.text === "SecondTask",
    );
    await vscode.commands.executeCommand("howm.completeReminder", refreshed);
    assert.ok(doc.getText().includes("# Added\n[2000-01-01]+ AddedTask"));
    assert.ok(other.isDirty && other.getText().includes("Unsaved other"));
    assert.equal(await fs.readFile(uri.fsPath, "utf8"), text);
    await vscode.commands.executeCommand("undo");
    await vscode.commands.executeCommand("undo");
    assert.equal(doc.getText(), text);
    await editor.edit((edit) => edit.delete(new vscode.Range(7, 0, 8, 0)));
    assert.equal(
      store.files.get(uri.toString()).length,
      1,
      "removing a heading should merge its content into the previous note",
    );
    await vscode.commands.executeCommand("undo");
    assert.equal(store.files.get(uri.toString()).length, 2);

    const completionUri = vscode.Uri.file(path.join(root, "completion.md"));
    await fs.writeFile(
      completionUri.fsPath,
      ">>> SharedTopic\n# Completion\n>>> \n~~~\n>>> SharedTopic\n~~~\n",
    );
    await vscode.commands.executeCommand("howm.refresh");
    const completionLabels = async (line, column) => {
      const result = await vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        completionUri,
        new vscode.Position(line, column),
      );
      return result.items.map((item) =>
        typeof item.label === "string" ? item.label : item.label.label,
      );
    };
    assert.ok(
      (await completionLabels(2, 4)).includes("SharedTopic"),
      "completion must work immediately after an empty >>> prefix",
    );
    assert.ok(
      !(await completionLabels(0, 4)).includes("SharedTopic"),
      "preamble must not provide howm completions",
    );
    assert.ok(
      !(await completionLabels(4, 4)).includes("SharedTopic"),
      "code must not provide howm completions",
    );

    // A separate file checks watcher-driven re-splitting and deletion.
    const external = vscode.Uri.file(path.join(root, "external.md"));
    await fs.writeFile(
      external.fsPath,
      "# External A\n[2000-01-01]+ ExternalA\n# External B\n[2000-01-01]+ ExternalB\n",
    );
    await until(
      () => store.files.get(external.toString())?.length === 2,
      "external creation should index both sections",
    );
    const diskStale = store.files.get(external.toString())[1];
    const diskTask = {
      type: "reminder",
      note: diskStale,
      reminder: diskStale.reminders[0],
    };
    const revised =
      "# External New\n[2000-01-01]+ New\n" + diskStale.source.text;
    await fs.writeFile(external.fsPath, revised);
    await vscode.commands.executeCommand("howm.completeReminder", diskTask);
    assert.equal(await fs.readFile(external.fsPath, "utf8"), revised);
    await until(
      () => store.files.get(external.toString())?.length === 3,
      "external edits should re-split every section",
    );
    await fs.writeFile(
      external.fsPath,
      "# Merged\n[2000-01-01]+ ExternalA\n[2000-01-01]+ ExternalB\n",
    );
    await until(
      () => store.files.get(external.toString())?.length === 1,
      "external heading deletion should remove old sections",
    );
    await fs.unlink(external.fsPath);
    await until(
      () => !store.files.has(external.toString()),
      "external file deletion should remove all its sections",
    );
    console.log(
      "MULTI-NOTE PASSED: headings/counts, scoped links, search preview, regex/related/concatenated navigation, completion/undo, dirty edits, stale safety, live heading changes and external deletion",
    );
  } finally {
    provider.dispose();
    store.dispose();
  }
};
