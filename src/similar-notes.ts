import * as vscode from "vscode";
import { Note, noteAtLine } from "./core";
import { Store } from "./storage";
import { noteTreeItem } from "./notes";
import { SimilarNote, SimilarityIndex } from "./similar-notes-model";

export class SimilarNotesProvider
  implements vscode.TreeDataProvider<Note>, vscode.Disposable
{
  private events = new vscode.EventEmitter<Note | undefined>();
  readonly onDidChangeTreeData = this.events.event;
  private view?: vscode.TreeView<Note>;
  private subscriptions: vscode.Disposable[] = [];
  private index = new SimilarityIndex();
  private results: SimilarNote[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private lastTarget?: string;
  private disposed = false;

  constructor(private store: Store) {
    this.subscriptions.push(
      store.onChange(() => {
        this.cancel();
        const settings = this.settings;
        if (!settings.enabled) return;
        if (settings.autoRefresh) this.schedule(500);
        else
          this.publish(
            [],
            "内容が変更されました。更新ボタンで更新してください。",
          );
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.targetChanged()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (
          event.textEditor === vscode.window.activeTextEditor &&
          this.target()?.id !== this.lastTarget
        )
          this.targetChanged();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("howm.similarNotes")) return;
        this.cancel();
        if (!this.settings.enabled) {
          this.index.dispose();
          this.results = [];
        }
        void this.update();
      }),
    );
  }

  private get settings() {
    const config = vscode.workspace.getConfiguration("howm");
    const max = config.get<number>("similarNotes.maxResults", 10);
    const min = config.get<number>("similarNotes.minSimilarity", 0.1);
    return {
      enabled: config.get("similarNotes.enabled", true),
      autoRefresh: config.get("similarNotes.autoRefresh", true),
      maxResults: Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 10,
      minSimilarity: Number.isFinite(min) ? Math.max(0, Math.min(1, min)) : 0.1,
    };
  }

  private target(): Note | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.store.contains(editor.document.uri)) return;
    return noteAtLine(
      this.store.files.get(editor.document.uri.toString()) || [],
      editor.selection.active.line,
    );
  }

  private targetChanged() {
    this.cancel();
    if (!this.settings.enabled) {
      this.publish([], "類似メモは無効です。");
      return;
    }
    this.lastTarget = this.target()?.id;
    if (!this.lastTarget) {
      this.publish(
        [],
        "保存先内のMarkdown howmメモにカーソルを置いてください。",
      );
      return;
    }
    if (this.settings.autoRefresh) this.schedule(0);
    else this.publish([], "自動更新は無効です。更新ボタンで更新してください。");
  }

  attach(view: vscode.TreeView<Note>) {
    this.view = view;
    this.subscriptions.push(
      view.onDidChangeVisibility(() => {
        this.cancel();
        if (view.visible) void this.refresh();
      }),
    );
    if (view.visible) void this.update();
  }

  private cancel() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number) {
    if (this.disposed || !this.view?.visible || !this.settings.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update();
    }, delay);
  }

  async refresh() {
    this.cancel();
    try {
      await this.store.initialize();
    } catch {
      /* Store exposes the error. */
    }
    await this.update();
  }

  async update() {
    this.cancel();
    if (this.disposed || !this.view?.visible) return;
    const settings = this.settings;
    if (!settings.enabled) {
      this.publish([], "類似メモは無効です。");
      return;
    }
    const target = this.target();
    this.lastTarget = target?.id;
    if (!target) {
      this.publish(
        [],
        "保存先内のMarkdown howmメモにカーソルを置いてください。",
      );
      return;
    }
    const generation = this.generation;
    const cancelled = () => this.disposed || generation !== this.generation;
    this.publish([], "類似メモを計算中…");
    if (!(await this.index.sync(this.store.all(), cancelled))) return;
    const results = await this.index.search(
      target.id,
      settings.maxResults,
      settings.minSimilarity,
      cancelled,
    );
    if (cancelled()) return;
    this.publish(
      results,
      this.store.error ||
        (!results.length ? "類似メモはありません。" : undefined),
    );
  }

  private publish(results: SimilarNote[], message?: string) {
    if (this.disposed || !this.view?.visible) return;
    this.results = results;
    this.view.description = `${results.length}件`;
    this.view.message = message;
    this.events.fire(undefined);
  }

  getChildren(node?: Note): Note[] {
    return node ? [] : this.results.map((result) => result.note);
  }

  getTreeItem(note: Note): vscode.TreeItem {
    const item = noteTreeItem(note);
    const score = this.results.find((result) => result.note === note)?.score;
    item.tooltip = `${item.tooltip}\n類似度: ${score?.toFixed(3) || "0"}`;
    item.command = {
      command: "howm.openDiscoveryNote",
      title: "開く",
      arguments: [note],
    };
    return item;
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.index.dispose();
    this.results = [];
    this.events.dispose();
  }
}
