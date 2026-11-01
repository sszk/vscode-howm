import * as vscode from "vscode";
import { Note, dateString } from "./core";
import { Store } from "./storage";
import { noteTreeItem } from "./notes";
import { LocalDayClock } from "./local-day";
import { AnniversaryYear, onThisDay } from "./on-this-day-model";

export type AnniversaryNode = AnniversaryYear | Note;

export class OnThisDayProvider
  implements vscode.TreeDataProvider<AnniversaryNode>, vscode.Disposable
{
  private events = new vscode.EventEmitter<AnniversaryNode | undefined>();
  readonly onDidChangeTreeData = this.events.event;
  private groups: AnniversaryYear[] = [];
  private view?: vscode.TreeView<AnniversaryNode>;
  private subscriptions: vscode.Disposable[] = [];
  private dayWatch?: vscode.Disposable;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private store: Store,
    private dayClock: LocalDayClock,
    private clock: () => string = dateString,
  ) {
    this.subscriptions.push(
      store.onChange(() => {
        if (!this.view?.visible) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.update(), 200);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("howm.onThisDay")) {
          if (!this.enabled) this.groups = [];
          this.watchDay();
          this.update();
        }
      }),
    );
  }

  private get enabled() {
    return vscode.workspace
      .getConfiguration("howm")
      .get("onThisDay.enabled", true);
  }

  attach(view: vscode.TreeView<AnniversaryNode>) {
    this.view = view;
    this.subscriptions.push(
      view.onDidChangeVisibility(() => {
        this.watchDay();
        if (view.visible) void this.refresh();
      }),
    );
    this.watchDay();
    this.update();
  }

  private watchDay() {
    this.dayWatch?.dispose();
    this.dayWatch =
      this.view?.visible && this.enabled
        ? this.dayClock.watch(() => this.update())
        : undefined;
  }

  update() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || !this.view?.visible) return;
    this.groups = this.enabled ? onThisDay(this.store.all(), this.clock()) : [];
    this.view.description = `${this.groups.reduce((sum, group) => sum + group.notes.length, 0)}件`;
    this.view.message = !this.enabled
      ? "過去の今日は無効です。"
      : this.store.error ||
        (this.store.loading
          ? "読み込み中…"
          : !this.store.root
            ? "メモの保存先を選択してください。"
            : !this.groups.length
              ? "過去の今日のメモはありません。"
              : undefined);
    this.events.fire(undefined);
  }

  async refresh() {
    try {
      await this.store.initialize();
    } catch {
      /* Store exposes the error. */
    }
    this.update();
  }

  getChildren(node?: AnniversaryNode): AnniversaryNode[] {
    return node ? ("year" in node ? node.notes : []) : this.groups;
  }

  getTreeItem(node: AnniversaryNode): vscode.TreeItem {
    if ("year" in node) {
      const item = new vscode.TreeItem(
        `${node.year}年（${node.yearsAgo}年前）`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = String(node.year);
      item.description = `${node.notes.length}件`;
      return item;
    }
    const item = noteTreeItem(node);
    item.command = {
      command: "howm.openDiscoveryNote",
      title: "開く",
      arguments: [node],
    };
    return item;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.dayWatch?.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.events.dispose();
    this.groups = [];
  }
}
