import * as vscode from "vscode";
import { Note, Reminder, dateString, parseNotes } from "./core";
import { Store } from "./storage";

// Use the same edit for sidebar completion and the current-line command.
// A full-text snapshot check prevents a stale tree item from editing another row.
export async function completeReminder(
  store: Store,
  note: Note,
  reminder: Reminder,
): Promise<boolean> {
  const uri = vscode.Uri.parse(note.uri);
  if (!store.contains(uri)) return false;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await store.initialize();
    void vscode.window.showInformationMessage(
      "元のメモが見つかりません。一覧を更新しました。",
    );
    return false;
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
      "メモが変更されています。一覧の更新後にもう一度完了操作をしてください。",
    );
    return false;
  }
  const current = parseNotes(note.uri, doc.getText())
    .find((n) => n.id === note.id)
    ?.reminders.find(
      (r) =>
        r.line === reminder.line &&
        r.start === reminder.start &&
        r.end === reminder.end &&
        r.kind === reminder.kind &&
        r.kind !== ".",
    );
  if (!current) return false;
  const range = new vscode.Range(
    current.line,
    current.start,
    current.line,
    current.end,
  );
  const original = doc.getText(range);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, `[${dateString()}]. ${original.replace("]", "]:")}`);
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) await store.read(uri);
  return applied;
}
