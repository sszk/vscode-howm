import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { Note, parseNote } from "./core";
export class Store implements vscode.Disposable {
  notes = new Map<string, Note>();
  root?: vscode.Uri;
  private watcher?: vscode.FileSystemWatcher;
  private generation = 0;
  private versions = new Map<string, number>();
  private events = new vscode.EventEmitter<void>();
  readonly onChange = this.events.event;
  private subscriptions: vscode.Disposable[] = [];
  skipped = 0;
  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.contains(e.document.uri)) this.overlay(e.document);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.contains(d.uri)) void this.read(d.uri);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (this.contains(d.uri)) void this.read(d.uri);
      }),
    );
  }
  contains(uri: vscode.Uri) {
    return (
      !!this.root &&
      uri.scheme === this.root.scheme &&
      uri.authority === this.root.authority &&
      uri.path.startsWith(this.root.path.replace(/\/$/, "") + "/") &&
      /\.md$/i.test(uri.path)
    );
  }
  private overlay(doc: vscode.TextDocument) {
    this.versions.set(
      doc.uri.toString(),
      (this.versions.get(doc.uri.toString()) || 0) + 1,
    );
    this.notes.set(
      doc.uri.toString(),
      parseNote(doc.uri.toString(), doc.getText()),
    );
    this.events.fire();
  }
  async initialize() {
    const generation = ++this.generation;
    this.watcher?.dispose();
    this.notes.clear();
    this.versions.clear();
    this.skipped = 0;
    const setting = vscode.workspace
      .getConfiguration("howm")
      .get<string>("notesDirectory", "");
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!setting)
      this.root = workspace
        ? vscode.Uri.joinPath(workspace, "howm")
        : undefined;
    else if (setting.startsWith("~/"))
      this.root = vscode.Uri.file(path.join(os.homedir(), setting.slice(2)));
    else if (path.isAbsolute(setting))
      this.root =
        workspace?.scheme === "vscode-remote"
          ? workspace.with({ path: setting })
          : vscode.Uri.file(setting);
    else
      this.root = workspace
        ? vscode.Uri.joinPath(workspace, setting)
        : undefined;
    if (!this.root) {
      this.events.fire();
      return;
    }
    const root = this.root;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*"),
    );
    this.watcher.onDidCreate((uri) => {
      if (this.contains(uri)) void this.read(uri);
    });
    this.watcher.onDidChange((uri) => {
      if (this.contains(uri)) void this.read(uri);
    });
    this.watcher.onDidDelete((uri) => {
      for (const key of this.notes.keys())
        if (key === uri.toString() || key.startsWith(uri.toString() + "/")) {
          this.versions.set(key, (this.versions.get(key) || 0) + 1);
          this.notes.delete(key);
        }
      this.events.fire();
    });
    const walk = async (dir: vscode.Uri): Promise<void> => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        return;
      }
      for (const [name, type] of entries) {
        if (generation !== this.generation) return;
        if (name.startsWith(".") || name === "node_modules") continue;
        const uri = vscode.Uri.joinPath(dir, name);
        if (type === vscode.FileType.Directory) await walk(uri);
        else if (type === vscode.FileType.File && /\.md$/i.test(name))
          await this.read(uri, false);
      }
    };
    await walk(root);
    if (generation !== this.generation) return;
    for (const doc of vscode.workspace.textDocuments)
      if (this.contains(doc.uri) && doc.isDirty) this.overlay(doc);
    this.events.fire();
  }
  async read(uri: vscode.Uri, notify = true) {
    const generation = this.generation,
      key = uri.toString(),
      version = (this.versions.get(key) || 0) + 1;
    this.versions.set(key, version);
    try {
      const dirty = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === key && d.isDirty,
      );
      if (dirty) {
        this.overlay(dirty);
        return;
      }
      const stat = await vscode.workspace.fs.stat(uri);
      if (
        stat.size >
        vscode.workspace
          .getConfiguration("howm")
          .get<number>("maxFileSizeKB", 1024) *
          1024
      ) {
        this.notes.delete(key);
        this.skipped++;
        return;
      }
      const data = await vscode.workspace.fs.readFile(uri);
      if (generation !== this.generation || this.versions.get(key) !== version)
        return;
      this.notes.set(
        key,
        parseNote(key, new TextDecoder().decode(data), stat.mtime),
      );
    } catch {
      if (generation === this.generation && this.versions.get(key) === version)
        this.notes.delete(key);
    } finally {
      if (notify) this.events.fire();
    }
  }
  all() {
    return [...this.notes.values()].sort((a, b) => b.modified - a.modified);
  }
  keywords() {
    return [...new Set(this.all().flatMap((n) => n.keywords))];
  }
  dispose() {
    this.generation++;
    this.watcher?.dispose();
    this.events.dispose();
    this.subscriptions.forEach((d) => d.dispose());
  }
}
