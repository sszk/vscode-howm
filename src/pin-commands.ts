import * as vscode from "vscode";
import { PinnedNotes } from "./pinned-notes";
import { Store } from "./storage";

type Register = (name: string, callback: (target?: unknown) => unknown) => void;

export class PinCommands implements vscode.Disposable {
  private subscriptions: vscode.Disposable[];
  private signature = "";
  private resourcesSignature = "";

  constructor(
    private store: Store,
    private pins: PinnedNotes,
    register: Register,
  ) {
    for (const [name, operation] of [
      ["pinNote", (uri: vscode.Uri) => pins.pin(uri)],
      ["unpinNote", (uri: vscode.Uri) => pins.unpin(uri)],
      ["togglePin", (uri: vscode.Uri) => pins.togglePin(uri)],
    ] as const) {
      register(name, async (target) => {
        const uri = this.target(target);
        if (uri && store.contains(uri)) await operation(uri);
      });
    }
    this.subscriptions = [
      store.onChange(() => this.update()),
      pins.onDidChangePinnedNotes(() => this.update(true)),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidOpenTextDocument(() => this.update()),
      vscode.workspace.onDidCloseTextDocument(() => this.update()),
      vscode.workspace.onDidRenameFiles(() => this.update()),
      vscode.workspace.onDidDeleteFiles(() => this.update()),
    ];
    this.update();
  }

  private target(value?: unknown): vscode.Uri | undefined {
    if (value === undefined)
      return vscode.window.activeTextEditor?.document.uri;
    if (value instanceof vscode.Uri) return value;
    if (value && typeof value === "object") {
      const target = value as { uri?: unknown; resourceUri?: unknown };
      const uri = target.resourceUri ?? target.uri;
      if (uri instanceof vscode.Uri) return uri;
      if (typeof uri === "string") return vscode.Uri.parse(uri);
    }
    return undefined;
  }

  private update(force = false) {
    // `resource in …` is evaluated for each editor's URI. Active-editor-only
    // booleans give incorrect buttons in split editors and on inactive tabs.
    const candidates = new Set([
      ...this.store.files.keys(),
      ...vscode.workspace.textDocuments.map((document) =>
        document.uri.toString(),
      ),
      ...vscode.window.visibleTextEditors.map((editor) =>
        editor.document.uri.toString(),
      ),
    ]);
    const keys = [...candidates].sort();
    const resourcesSignature = JSON.stringify([
      this.store.root?.toString(),
      keys,
    ]);
    if (!force && resourcesSignature === this.resourcesSignature) return;
    this.resourcesSignature = resourcesSignature;
    const notes = keys.filter((key) =>
      this.store.contains(vscode.Uri.parse(key)),
    );
    const pinned = notes.filter((key) =>
      this.pins.isPinned(vscode.Uri.parse(key)),
    );
    const signature = JSON.stringify([notes, pinned]);
    if (this.signature === signature) return;
    this.signature = signature;
    void vscode.commands.executeCommand(
      "setContext",
      "howm.noteResources",
      notes,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "howm.pinnedNoteResources",
      pinned,
    );
  }

  dispose() {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    void vscode.commands.executeCommand("setContext", "howm.noteResources", []);
    void vscode.commands.executeCommand(
      "setContext",
      "howm.pinnedNoteResources",
      [],
    );
  }
}
