import * as vscode from "vscode";
import { Note } from "./core";
import { Store } from "./storage";

export async function openNote(
  store: Store,
  note: Note,
  line = note.startLine,
  preview = false,
  selection?: vscode.Range,
): Promise<vscode.TextEditor | undefined> {
  const uri = vscode.Uri.parse(note.uri);
  if (!store.contains(uri)) return;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await store.initialize();
    void vscode.window.showInformationMessage(
      "元のメモが見つかりません。一覧を更新しました。",
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const diskText = doc.isDirty
    ? undefined
    : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  if (
    doc.getText() !== note.source.text ||
    (diskText !== undefined && diskText !== note.source.text)
  ) {
    await store.read(uri);
    void vscode.window.showInformationMessage(
      "メモが変更されています。一覧の更新後にもう一度選択してください。",
    );
    return;
  }
  const range = selection ?? new vscode.Range(line, 0, line, 0);
  const editor = await vscode.window.showTextDocument(doc, {
    preview,
    selection: range,
  });
  editor.revealRange(
    range,
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
  return editor;
}
