const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { dateString } = require("../dist/core");

exports.run = async (root) => {
  const uri = vscode.Uri.file(path.join(root, "date-input.md"));
  const text = "# Date input\nreplace\ninsert here\n[2026-11-05]!7 deadline\n";
  await fs.writeFile(uri.fsPath, text);
  await vscode.workspace
    .getConfiguration("howm")
    .update("notesDirectory", root, vscode.ConfigurationTarget.Global);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const manifest = vscode.extensions.getExtension(
    "local-howm.markdown-howm",
  ).packageJSON;
  assert.ok(
    manifest.contributes.commands.some(
      (c) => c.command === "howm.inputDate" && c.title === "howm: 日付を入力",
    ),
  );
  const today = dateString();
  const runInput = async (action) => {
    const command = vscode.commands.executeCommand("howm.inputDate");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      doc.getText(),
      text,
      "opening the input must not change the document",
    );
    await vscode.commands.executeCommand(action);
    await command;
  };
  editor.selections = [
    new vscode.Selection(1, 0, 1, 7),
    new vscode.Selection(2, 7, 2, 7),
  ];
  await runInput("workbench.action.acceptSelectedQuickOpenItem");
  assert.equal(
    doc.getText(),
    `# Date input\n[${today}]\ninsert [${today}]here\n[2026-11-05]!7 deadline\n`,
  );
  assert.ok(doc.isDirty);
  assert.equal(
    await fs.readFile(uri.fsPath, "utf8"),
    text,
    "date insertion must not save",
  );
  await vscode.commands.executeCommand("undo");
  assert.equal(doc.getText(), text, "one undo restores every selection");
  await runInput("workbench.action.closeQuickOpen");
  assert.equal(
    doc.getText(),
    text,
    "cancellation must not change the document",
  );

  editor.selection = new vscode.Selection(2, 7, 2, 7);
  await vscode.commands.executeCommand("howm.insertDate");
  assert.equal(doc.lineAt(2).text, `insert [${today}]here`);
  await vscode.commands.executeCommand("undo");
  assert.equal(doc.getText(), text, "direct today insertion stays undoable");
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor",
  );
  console.log(
    "DATE INPUT INTEGRATION PASSED: command contribution, blank input, multiple selections, undo, cancel, no save, direct today insertion",
  );
};
