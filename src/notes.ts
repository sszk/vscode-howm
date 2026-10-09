import * as vscode from "vscode";
import { Note, noteDisplayDate } from "./core";

export function noteTreeItem(note: Note): vscode.TreeItem {
  const item = new vscode.TreeItem(note.title);
  const { date, source } = noteDisplayDate(note);
  item.resourceUri = vscode.Uri.parse(note.uri);
  item.description = date;
  item.command = {
    command: "vscode.open",
    title: "開く",
    arguments: [item.resourceUri],
  };
  item.tooltip = `${note.uri}\n${source}: ${date}`;
  return item;
}
