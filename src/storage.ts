import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { Note, parseNotes } from "./core";
export class Store implements vscode.Disposable {
  files = new Map<string, Note[]>();
  root?: vscode.Uri;
  private watcher?: vscode.FileSystemWatcher;
  private generation = 0;
  private versions = new Map<string, number>();
  private events = new vscode.EventEmitter<void>();
  readonly onChange = this.events.event;
  private subscriptions: vscode.Disposable[] = [];
  skipped = 0;
  loading = false;
  error?: string;
  private pending?: Promise<void>;
  private refreshSignature = "";
  private refreshRequested = false;
  private disposed = false;
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
    if (!this.root) return false;
    // URI serialization normalizes drive letters and host names. The index
    // stores serialized URIs, so compare both sides in that same form.
    const root = vscode.Uri.parse(this.root.toString());
    const candidate = vscode.Uri.parse(uri.toString());
    return (
      candidate.scheme === root.scheme &&
      candidate.authority === root.authority &&
      candidate.path.startsWith(root.path.replace(/\/+$/, "") + "/") &&
      /\.md$/i.test(candidate.path)
    );
  }
  private overlay(doc: vscode.TextDocument) {
    this.versions.set(
      doc.uri.toString(),
      (this.versions.get(doc.uri.toString()) || 0) + 1,
    );
    this.files.set(
      doc.uri.toString(),
      parseNotes(doc.uri.toString(), doc.getText()),
    );
    this.events.fire();
  }
  private configurationSignature() {
    const config = vscode.workspace.getConfiguration("howm");
    return JSON.stringify([
      config.get("notesDirectory"),
      config.get("maxFileSizeKB"),
      vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
    ]);
  }
  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) {
      if (this.configurationSignature() !== this.refreshSignature)
        this.refreshRequested = true;
      return this.pending;
    }
    this.loading = true;
    this.events.fire();
    this.pending = (async () => {
      try {
        do {
          this.refreshRequested = false;
          this.refreshSignature = this.configurationSignature();
          await this.scan();
        } while (
          !this.disposed &&
          (this.refreshRequested ||
            this.configurationSignature() !== this.refreshSignature)
        );
      } catch (error) {
        this.error = `読み込みに失敗しました: ${String(error)}`;
        throw error;
      } finally {
        this.loading = false;
        this.pending = undefined;
        if (!this.disposed) this.events.fire();
      }
    })();
    return this.pending;
  }
  private async scan() {
    const generation = ++this.generation;
    const previousRoot = this.root?.toString();
    const startingVersions = new Map(this.versions);
    const seen = new Set<string>();
    this.error = undefined;
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
    if (previousRoot !== this.root?.toString()) {
      this.watcher?.dispose();
      this.watcher = undefined;
      this.files.clear();
      this.versions.clear();
    }
    if (!this.root) return;
    const root = this.root;
    this.watcher?.dispose();
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
      for (const key of this.files.keys())
        if (key === uri.toString() || key.startsWith(uri.toString() + "/")) {
          this.versions.set(key, (this.versions.get(key) || 0) + 1);
          this.files.delete(key);
        }
      this.events.fire();
    });
    const walk = async (dir: vscode.Uri): Promise<void> => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch (error) {
        if (generation === this.generation)
          this.error = `保存先を読み込めません: ${String(error)}`;
        return;
      }
      for (const [name, type] of entries) {
        if (generation !== this.generation) return;
        if (name.startsWith(".") || name === "node_modules") continue;
        const uri = vscode.Uri.joinPath(dir, name);
        if (type === vscode.FileType.Directory) await walk(uri);
        else if (type === vscode.FileType.File && /\.md$/i.test(name)) {
          seen.add(uri.toString());
          await this.read(uri, false);
        }
      }
    };
    await walk(root);
    if (generation !== this.generation) return;
    if (!this.error) {
      for (const key of this.files.keys()) {
        if (
          !seen.has(key) &&
          this.versions.get(key) === startingVersions.get(key)
        )
          this.files.delete(key);
      }
    }
    for (const doc of vscode.workspace.textDocuments)
      if (this.contains(doc.uri) && doc.isDirty) this.overlay(doc);
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
        if (
          generation === this.generation &&
          this.versions.get(key) === version
        ) {
          this.files.delete(key);
          this.skipped++;
        }
        return;
      }
      const data = await vscode.workspace.fs.readFile(uri);
      if (generation !== this.generation || this.versions.get(key) !== version)
        return;
      this.files.set(
        key,
        parseNotes(key, new TextDecoder().decode(data), stat.mtime),
      );
    } catch (error) {
      if (
        generation === this.generation &&
        this.versions.get(key) === version
      ) {
        if (
          error instanceof vscode.FileSystemError &&
          error.code === "FileNotFound"
        )
          this.files.delete(key);
        else this.error = `メモを読み込めません: ${String(error)}`;
      }
    } finally {
      if (notify) this.events.fire();
    }
  }
  all() {
    return [...this.files.values()]
      .flat()
      .sort(
        (a, b) =>
          b.modified - a.modified ||
          a.uri.localeCompare(b.uri) ||
          a.startLine - b.startLine,
      );
  }
  get noteCount() {
    return [...this.files.values()].reduce(
      (count, notes) => count + notes.length,
      0,
    );
  }
  keywords() {
    return [...new Set(this.all().flatMap((n) => n.keywords))];
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.watcher?.dispose();
    this.events.dispose();
    this.subscriptions.forEach((d) => d.dispose());
  }
}
