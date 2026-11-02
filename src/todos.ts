import * as vscode from "vscode";
import { dateString, reminderList } from "./core";
import { Store } from "./storage";
import { LocalDayClock } from "./local-day";

import {
  TodoGroup,
  TodoNode,
  ReminderHighlight,
  todoGroups,
  emptyTodoReason,
  reminderHighlight,
} from "./todo-model";
export { TodoEntry, TodoNode } from "./todo-model";

const highlightColors: Record<ReminderHighlight, string> = {
  dueSoon: "howm.todoDueSoonForeground",
  overdue: "howm.todoOverdueForeground",
  today: "howm.scheduleTodayForeground",
};

function reminderUri(id: string): vscode.Uri {
  // Separate resources for each reminder avoid coloring the note in Explorer.
  return vscode.Uri.from({ scheme: "howm-todo", path: `/${id}` });
}

export class TodoProvider
  implements
    vscode.TreeDataProvider<TodoNode>,
    vscode.FileDecorationProvider,
    vscode.Disposable
{
  private events = new vscode.EventEmitter<TodoNode | undefined>();
  readonly onDidChangeTreeData = this.events.event;
  private decorationEvents = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationEvents.event;
  private highlights = new Map<string, ReminderHighlight>();
  private groups: TodoGroup[] = [];
  private subscriptions: vscode.Disposable[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  private dayTimer?: vscode.Disposable;
  private view?: vscode.TreeView<TodoNode>;
  private today: string;
  private disposed = false;

  constructor(
    private store: Store,
    private clock: () => string = dateString,
    private dayClock = new LocalDayClock(clock),
  ) {
    this.today = clock();
    this.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("howm.todos.dueSoonDays")) this.update();
      }),
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
    this.dayTimer = this.dayClock.watch(() => this.checkDate());
  }
  private stopDayTimer() {
    this.dayTimer?.dispose();
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
    const dueSoonDays = vscode.workspace
      .getConfiguration("howm")
      .get<number>("todos.dueSoonDays", 3);
    this.highlights.clear();
    for (const group of this.groups) {
      for (const entry of group.entries) {
        const highlight = reminderHighlight(
          entry.reminder,
          this.today,
          dueSoonDays,
        );
        if (highlight)
          this.highlights.set(reminderUri(entry.id).toString(), highlight);
      }
    }
    this.updateMessage();
    this.decorationEvents.fire(undefined);
    this.events.fire(undefined);
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const highlight = this.highlights.get(uri.toString());
    return highlight
      ? { color: new vscode.ThemeColor(highlightColors[highlight]) }
      : undefined;
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
    item.resourceUri = reminderUri(node.id);
    item.iconPath = new vscode.ThemeIcon(
      r.kind === "!"
        ? "warning"
        : r.kind === "@"
          ? "calendar"
          : "circle-outline",
      this.provideFileDecoration(item.resourceUri)?.color,
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
    this.highlights.clear();
    this.decorationEvents.dispose();
    this.events.dispose();
  }
}
