import * as vscode from "vscode";
import { windowsPathLink } from "./windows-path-link";

export async function insertWindowsPathLink() {
  const e = vscode.window.activeTextEditor;
  if (!e) return;
  const version = e.document.version;
  const selection = e.selection;
  const input = selection.isEmpty
    ? await vscode.env.clipboard.readText()
    : e.document.getText(selection);
  if (
    vscode.window.activeTextEditor !== e ||
    e.document.version !== version ||
    !e.selection.isEqual(selection)
  )
    return;
  const link = windowsPathLink(input);
  if (link === undefined) {
    void vscode.window.showErrorMessage(
      "howm: 有効なWindows絶対パス、UNCパス、またはfile URIを指定してください（URIのパーセントエンコードは有効なUTF-8が必要です）",
    );
    return;
  }
  if (!(await e.edit((b) => b.replace(selection, link))))
    void vscode.window.showErrorMessage("howm: リンクを挿入できませんでした");
}
