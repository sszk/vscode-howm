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
      vscode.l10n.t(
        "howm: Enter a valid absolute Windows path, UNC path, or file URI (percent encoding must be valid UTF-8).",
      ),
    );
    return;
  }
  if (!(await e.edit((b) => b.replace(selection, link))))
    void vscode.window.showErrorMessage(
      vscode.l10n.t("howm: Could not insert the link"),
    );
}
