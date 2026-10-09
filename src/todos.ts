import * as vscode from "vscode";
import { dateString, reminderList } from "./core";
import { Store } from "./storage";

import { TodoGroup, TodoNode, todoGroups, emptyTodoReason } from "./todo-model";
export { TodoEntry, TodoNode } from "./todo-model";

export class TodoProvider
  implements vscode.TreeDataProvider<TodoNode>, vscode.Disposable
{
  private events = new vscode.EventEmitter<TodoNode | undefined>();
  readonly onDidChangeTreeData = this.events.event;
  private groups: TodoGroup[] = [];
  private subscriptions: vscode.Disposable[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  private dayTimer?: ReturnType<typeof setInterval>;
  private view?: vscode.TreeView<TodoNode>;
  private today: string;
  private disposed = false;

  constructor(
    private store: Store,
    private clock: () => string = dateString,
  ) {
    this.today = clock();
    this.subscriptions.push(
      store.onChange(() => {
        this.updateMessage();
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.update(), 200);
      }),
    );
    this.update();
  }

  attach(view: vscode.TreeView<TodoNode>) {
    this.view = view;
    this.subscriptions.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.startDayTimer();
          void this.refresh().catch((error) => this.showError(error));
        } else this.stopDayTimer();
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && view.visible)
          void this.refresh().catch((error) => this.showError(error));
      }),
    );
    this.updateMessage();
    if (view.visible) {
      this.startDayTimer();
      void this.refresh().catch((error) => this.showError(error));
    }
  }

  private startDayTimer() {
    this.stopDayTimer();
    this.checkDate();
    this.dayTimer = setInterval(() => this.checkDate(), 60_000);
  }
  private stopDayTimer() {
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.dayTimer = undefined;
  }
  checkDate() {
    if (this.clock() !== this.today) this.update();
  }
  update() {
    if (this.disposed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.today = this.clock();
    if (!this.store.loading)
      this.groups = todoGroups(this.store.all(), this.today);
    this.updateMessage();
    this.events.fire(undefined);
  }
  private updateMessage() {
    if (!this.view || this.disposed) return;
    const notes = this.store.all();
    this.view.description = `${reminderList(notes, this.today).unfinished.length}件`;
    const root = this.store.root?.fsPath || "未設定";
    this.view.message = this.store.loading
      ? "Todoと予定を読み込み中…"
      : this.store.error
        ? `${this.store.error}\n保存先: ${root}\n更新ボタンで再試行するか、保存先を選び直してください。`
        : !this.groups.length
          ? `${emptyTodoReason(notes)}\n保存先: ${root}`
          : this.store.skipped
            ? `サイズ上限を超える${this.store.skipped}件は読み込み対象外です。`
            : undefined;
  }
  private showError(error: unknown) {
    if (this.view && !this.disposed)
      this.view.message = `読み込みに失敗しました: ${String(error)}\n更新ボタンで再試行してください。`;
  }
  async refresh() {
    await this.store.initialize();
    this.update();
  }
  getChildren(node?: TodoNode): TodoNode[] {
    return node?.type === "group" ? node.entries : node ? [] : this.groups;
  }
  getTreeItem(node: TodoNode): vscode.TreeItem {
    if (node.type === "group") {
      const item = new vscode.TreeItem(
        node.label,
        node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = node.id;
      item.description = `${node.entries.length}件`;
      return item;
    }
    const r = node.reminder;
    const item = new vscode.TreeItem(r.text || "本文なし");
    item.id = node.id;
    item.description = `${r.date} ${r.kind}`;
    item.tooltip = `${node.note.title}\n${vscode.Uri.parse(node.note.uri).fsPath}:${r.line + 1}\n${r.date} ${r.kind}${r.days} ${r.text}`;
    item.contextValue = "howm.reminder";
    item.iconPath = new vscode.ThemeIcon(
      r.kind === "!"
        ? "warning"
        : r.kind === "@"
          ? "calendar"
          : "circle-outline",
    );
    item.command = {
      command: "howm.openReminder",
      title: "元のメモを開く",
      arguments: [node],
    };
    return item;
  }
  dispose() {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.stopDayTimer();
    this.subscriptions.forEach((d) => d.dispose());
    this.events.dispose();
  }
}
