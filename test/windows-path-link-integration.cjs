const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

exports.run = async (root) => {
  const uri = vscode.Uri.file(path.join(root, "windows-path-link.md"));
  const input = String.raw`C:\共有資料\基本設計\設計 書(1).pdf`;
  const text = `# Windows path link\n${input}\n`;
  await fs.writeFile(uri.fsPath, text);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const manifest = vscode.extensions.getExtension(
    "local-howm.markdown-howm",
  ).packageJSON;
  assert.ok(
    manifest.contributes.commands.some(
      (c) =>
        c.command === "howm.insertWindowsPathLink" &&
        c.title === "howm: Windowsパスをリンクとして挿入",
    ),
  );
  editor.selection = new vscode.Selection(1, 0, 1, input.length);
  await vscode.commands.executeCommand("howm.insertWindowsPathLink");
  assert.equal(
    doc.lineAt(1).text,
    String.raw`[設計 書\(1\).pdf](file:///C:/共有資料/基本設計/設計%20書%281%29.pdf)`,
  );
  assert.ok(doc.isDirty);
  assert.equal(
    await fs.readFile(uri.fsPath, "utf8"),
    text,
    "link conversion must not save",
  );
  await vscode.commands.executeCommand("undo");
  assert.equal(doc.getText(), text, "conversion is undone in one step");
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor",
  );
  console.log(
    "WINDOWS PATH LINK INTEGRATION PASSED: command registration, selected path conversion, readable Unicode, Markdown escaping, undo and no save",
  );
};
