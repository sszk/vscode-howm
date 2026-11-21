const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { dateString } = require("../dist/core");

exports.run = async (base) => {
  const today = dateString();
  const root = path.join(base, "daily-memo");
  await fs.mkdir(root, { recursive: true });
  const olderName = `${today}-080000.md`;
  const newerName = `${today}-090000.md`;
  const olderPath = path.join(root, olderName);
  const newerPath = path.join(root, newerName);
  await fs.writeFile(olderPath, "# Older filename time\n");
  await fs.writeFile(newerPath, "# Newer filename time\n");
  const sameMtime = new Date(Date.now() - 60_000);
  await fs.utimes(olderPath, sameMtime, sameMtime);
  await fs.utimes(newerPath, sameMtime, sameMtime);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("howm.refresh");

  const target = await vscode.workspace.openTextDocument(
    vscode.Uri.file(newerPath),
  );
  await vscode.window.showTextDocument(target);
  await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(vscode.Uri.file(olderPath)),
  );
  await vscode.commands.executeCommand("howm.openDailyMemo");
  assert.equal(
    vscode.window.activeTextEditor.document.uri.fsPath,
    newerPath,
    "an already-open daily memo tab should be activated",
  );
  assert.deepEqual(
    vscode.window.activeTextEditor.selection.active,
    target.lineAt(target.lineCount - 1).range.end,
    "the cursor should move to the end of an existing daily memo",
  );

  const emptyRoot = path.join(base, "daily-memo-empty");
  await fs.mkdir(emptyRoot, { recursive: true });
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", emptyRoot, vscode.ConfigurationTarget.Global);
  await vscode.workspace
    .getConfiguration("howm")
    .update(
      "filenamePattern",
      "{YYYY}-{MM}-{DD}-{HH}{mm}{ss}.md",
      vscode.ConfigurationTarget.Global,
    );
  await Promise.all([
    vscode.commands.executeCommand("howm.openDailyMemo"),
    vscode.commands.executeCommand("howm.openDailyMemo"),
  ]);
  const created = (await fs.readdir(emptyRoot)).filter((name) =>
    name.endsWith(".md"),
  );
  assert.equal(created.length, 1, "concurrent commands must create one memo");
  assert.ok(created[0].startsWith(today));
  const createdEditor = vscode.window.activeTextEditor;
  assert.deepEqual(
    createdEditor.selection.active,
    createdEditor.document.lineAt(createdEditor.document.lineCount - 1).range
      .end,
    "the cursor should move to the end of a newly created daily memo",
  );
};
