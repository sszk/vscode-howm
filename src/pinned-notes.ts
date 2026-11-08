import * as vscode from "vscode";
import { Store } from "./storage";

export const PINNED_NOTES_KEY = "howm.pinnedNotes";

// Reuse Store's serialized URI keys. Pinning is file based, so all sections in
// one Markdown file share a pin, including when headings or line numbers change.
export class PinnedNotes implements vscode.Disposable {
  private pinned: Set<string>;
  private queue: Promise<void> = Promise.resolve();
  private events = new vscode.EventEmitter<void>();
  readonly onDidChangePinnedNotes = this.events.event;
  private subscriptions: vscode.Disposable[];
  private deleted = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private state: vscode.Memento,
    private store: Store,
  ) {
    const saved = state.get<string[]>(PINNED_NOTES_KEY, []);
    this.pinned = new Set(
      (Array.isArray(saved) ? saved : [])
        .filter((key) => typeof key === "string")
        .flatMap((key) => {
          try {
            return [vscode.Uri.parse(key).toString()];
          } catch {
            return [];
          }
        }),
    );
    this.subscriptions = [
      vscode.workspace.onDidRenameFiles((event) => {
        void this.rename(event.files).catch(this.reportError);
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        void this.remove(event.files).catch(this.reportError);
      }),
      store.onDidDeleteUri((uri) => {
        // Rename notifications can follow watcher deletions. Verify absence
        // after that notification, and never prune a temporarily offline root.
        const key = uri.toString();
        clearTimeout(this.deleted.get(key));
        this.deleted.set(
          key,
          setTimeout(() => {
            this.deleted.delete(key);
            void this.removeMissing(uri).catch(this.reportError);
          }, 250),
        );
      }),
    ];
  }

  private reportError = (error: unknown) => {
    void vscode.window.showErrorMessage(`howm: ${String(error)}`);
  };

  isPinned(uri: vscode.Uri): boolean {
    return this.store.contains(uri) && this.pinned.has(uri.toString());
  }

  pin(uri: vscode.Uri): Promise<void> {
    return this.change((next) => {
      if (this.store.contains(uri)) next.add(uri.toString());
    });
  }

  unpin(uri: vscode.Uri): Promise<void> {
    return this.change((next) => {
      next.delete(uri.toString());
    });
  }

  togglePin(uri: vscode.Uri): Promise<void> {
    return this.change((next) => {
      if (!this.store.contains(uri)) return;
      const key = uri.toString();
      if (!next.delete(key)) next.add(key);
    });
  }

  private change(edit: (next: Set<string>) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = new Set(this.pinned);
      edit(next);
      if (
        next.size === this.pinned.size &&
        [...next].every((key) => this.pinned.has(key))
      )
        return;
      await this.state.update(PINNED_NOTES_KEY, [...next]);
      this.pinned = next;
      this.events.fire();
    });
    // A failed write must not prevent subsequent actions or publish unsaved UI.
    this.queue = operation.catch(() => {});
    return operation;
  }

  private within(uri: vscode.Uri, parent: vscode.Uri): boolean {
    // Match Store.contains: serialized URIs normalize Windows drive letters
    // and authorities, including URIs received from rename/delete events.
    uri = vscode.Uri.parse(uri.toString());
    parent = vscode.Uri.parse(parent.toString());
    return (
      uri.scheme === parent.scheme &&
      uri.authority === parent.authority &&
      (uri.path === parent.path ||
        uri.path.startsWith(parent.path.replace(/\/+$/, "") + "/"))
    );
  }

  rename(
    files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
  ): Promise<void> {
    return this.change((next) => {
      const moved = new Map<string, string | undefined>();
      for (const key of next) {
        const uri = vscode.Uri.parse(key);
        const file = files.find(({ oldUri }) => this.within(uri, oldUri));
        if (!file) continue;
        const destination = file.newUri.with({
          path: file.newUri.path + uri.path.slice(file.oldUri.path.length),
        });
        // Preserve keys when the whole configured root (or its parent) moves.
        // They become active again after notesDirectory follows that move.
        const rootMoved =
          this.store.root && this.within(this.store.root, file.oldUri);
        moved.set(
          key,
          this.store.contains(destination) || rootMoved
            ? destination.toString()
            : undefined,
        );
      }
      for (const key of moved.keys()) next.delete(key);
      for (const key of moved.values()) if (key) next.add(key);
    });
  }

  remove(uris: readonly vscode.Uri[]): Promise<void> {
    return this.change((next) => {
      for (const key of next)
        if (uris.some((uri) => this.within(vscode.Uri.parse(key), uri)))
          next.delete(key);
    });
  }

  private async removeMissing(uri: vscode.Uri) {
    const root = this.store.root;
    if (!root || uri.toString() === root.toString()) return;
    try {
      await vscode.workspace.fs.stat(uri);
      return;
    } catch (error) {
      if (
        !(error instanceof vscode.FileSystemError) ||
        error.code !== "FileNotFound"
      )
        return;
    }
    try {
      await vscode.workspace.fs.stat(root);
    } catch {
      return;
    }
    await this.remove([uri]);
  }

  dispose() {
    for (const timer of this.deleted.values()) clearTimeout(timer);
    this.deleted.clear();
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.events.dispose();
  }
}
