import { modelText } from "./localization";
import * as vscode from "vscode";
import { Note, noteDisplayDate } from "./core";

export function noteTreeItem(note: Note): vscode.TreeItem {
  const item = new vscode.TreeItem(note.title);
  item.id = note.id;
  const { date, source } = noteDisplayDate(note);
  item.resourceUri = vscode.Uri.parse(note.uri);
  item.description = date;
  item.command = {
    command: "howm.openNote",
    title: vscode.l10n.t("Open"),
    arguments: [note],
  };
  item.tooltip = `${note.uri}:${note.startLine + 1}\n${modelText(source)}: ${date}`;
  return item;
}
