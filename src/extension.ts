import * as vscode from "vscode";
import { Store } from "./storage";
import { noteTreeItem } from "./notes";
import { TodoProvider, TodoEntry, TodoNode } from "./todos";
import { completeReminder } from "./reminders";
import { Worker } from "node:worker_threads";
import {
  Note,
  search,
  keywordLinks,
  parseNote,
  dateString,
  dayNumber,
  reminderList,
  renderTemplate,
  filename,
} from "./core";
export async function activate(context: vscode.ExtensionContext) {
  const store = new Store();
  context.subscriptions.push(store);
  const output = vscode.window.createOutputChannel("Markdown howm");
  context.subscriptions.push(output);
  let lastResults: Note[] = [];
  let createQueue = Promise.resolve();
  const register = (name: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `howm.${name}`,
        async (...args: any[]) => {
          try {
            return await fn(...args);
          } catch (error) {
            output.appendLine(String(error));
            void vscode.window.showErrorMessage(
              `howm: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      ),
    );
  const open = async (note: Note, line = 0, preview = false) =>
    vscode.window.showTextDocument(vscode.Uri.parse(note.uri), {
      preview,
      selection: new vscode.Range(line, 0, line, 0),
    });
  const configure = async () => {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "howmの保存先",
    });
    if (chosen) {
      await vscode.workspace
        .getConfiguration("howm")
        .update(
          "notesDirectory",
          chosen[0].fsPath,
          vscode.ConfigurationTarget.Global,
        );
      await store.initialize();
    }
  };
  const ensureRoot = async () => {
    if (!store.root) await configure();
    if (!store.root) throw new Error("メモの保存先を選択してください");
    return store.root;
  };
  async function create(title: string, body = "") {
    const work = async () => {
      const root = await ensureRoot(),
        config = vscode.workspace.getConfiguration("howm");
      const now = new Date();
      const name = filename(config.get<string>("filenamePattern")!, now);
      let uri = vscode.Uri.joinPath(root, name),
        count = 0;
      while (true) {
        try {
          await vscode.workspace.fs.stat(uri);
        } catch (e) {
          if (e instanceof vscode.FileSystemError && e.code === "FileNotFound")
            break;
          throw e;
        }
        uri = vscode.Uri.joinPath(
          root,
          name.replace(/\.md$/i, `-${++count}.md`),
        );
      }
      const text = renderTemplate(
        config.get<string>("template")!,
        title,
        body,
        now,
      );
      await vscode.workspace.fs.createDirectory(
        uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf("/")) }),
      );
      // WorkspaceEdit refuses an existing destination and preserves undo support.
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { overwrite: false });
      edit.insert(uri, new vscode.Position(0, 0), text);
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error("メモを作成できませんでした");
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
      await store.read(uri);
      await vscode.window.showTextDocument(doc);
    };
    const next = createQueue.then(work);
    createQueue = next.catch(() => {});
    await next;
  }
  async function pickNotes(notes: Note[], title: string) {
    lastResults = notes;
    if (!notes.length) {
      void vscode.window.showInformationMessage("一致するメモがありません");
      return;
    }
    const picker = vscode.window.createQuickPick<
      vscode.QuickPickItem & { note?: Note; concat?: boolean }
    >();
    picker.title = title;
    picker.placeholder = "タイトルで絞り込み · 選択中のメモをプレビュー";
    picker.matchOnDescription = true;
    picker.items = [
      { label: "$(book) すべて連結して読む", concat: true },
      ...notes.map((note) => ({
        label: note.title,
        description: vscode.Uri.parse(note.uri).path,
        detail: note.lines
          .find((l) => l.trim() && !l.startsWith("#"))
          ?.slice(0, 180),
        note,
      })),
    ];
    const original = vscode.window.activeTextEditor;
    let accepted = false;
    let previewQueue = Promise.resolve();
    const listeners = [
      picker.onDidChangeActive((items) => {
        const note = items[0]?.note;
        if (note)
          previewQueue = previewQueue
            .then(async () => {
              await open(note, 0, true);
            })
            .catch(() => {});
      }),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0];
        if (!selected) return;
        accepted = true;
        picker.hide();
        void previewQueue
          .then(async () => {
            if (selected.concat) await concatenate(notes);
            else if (selected.note) await open(selected.note);
          })
          .catch((error) => output.appendLine(String(error)));
      }),
      picker.onDidHide(() => {
        listeners.forEach((x) => x.dispose());
        picker.dispose();
        if (!accepted && original)
          void previewQueue.then(() =>
            vscode.window.showTextDocument(original.document, {
              viewColumn: original.viewColumn,
              selection: original.selection,
              preview: false,
            }),
          );
      }),
    ];
    picker.show();
  }
  const virtual = new Map<
    string,
    { text: string; links: { range: vscode.Range; uri: vscode.Uri }[] }
  >();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("howm", {
      provideTextDocumentContent: (uri) =>
        virtual.get(uri.toString())?.text || "",
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === "howm") virtual.delete(doc.uri.toString());
    }),
  );
  let virtualId = 0;
  async function concatenate(notes = lastResults) {
    if (!notes.length) {
      void vscode.window.showInformationMessage(
        "先に検索または一覧を開いてください",
      );
      return;
    }
    const lines = ["# howm — 連結表示", ""];
    const links: { range: vscode.Range; uri: vscode.Uri }[] = [];
    for (const note of notes) {
      const uri = vscode.Uri.parse(note.uri);
      const line = lines.length;
      lines.push(`元のメモを開く: ${note.title}`, "", note.text, "", "---", "");
      links.push({
        range: new vscode.Range(line, 0, line, lines[line].length),
        uri,
      });
    }
    // Count embedded newlines when computing source navigation ranges.
    let offset = 2;
    for (let i = 0; i < notes.length; i++) {
      links[i].range = new vscode.Range(
        offset,
        0,
        offset,
        `元のメモを開く: ${notes[i].title}`.length,
      );
      offset += 6 + notes[i].text.split("\n").length - 1;
    }
    const uri = vscode.Uri.parse(`howm:/reading-${++virtualId}.md`);
    virtual.set(uri.toString(), { text: lines.join("\n"), links });
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
      { preview: false },
    );
  }
  async function regexSearch(notes: Note[], query: string): Promise<Note[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        `const {parentPort,workerData}=require('node:worker_threads');try{const {search}=require(workerData.core);parentPort.postMessage({uris:search(workerData.notes,workerData.query,true).map(n=>n.uri)});}catch(e){parentPort.postMessage({error:e.message});}`,
        {
          eval: true,
          workerData: { core: require.resolve("./core"), notes, query },
        },
      );
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error("正規表現検索が時間制限（2秒）を超えました"));
      }, 2000);
      worker.once("message", (message) => {
        clearTimeout(timer);
        void worker.terminate();
        if (message.error) reject(new Error(message.error));
        else {
          const map = new Map(notes.map((n) => [n.uri, n]));
          resolve(message.uris.map((uri: string) => map.get(uri)!));
        }
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  async function doSearch(query?: string, regex = false) {
    query =
      query ??
      (await vscode.window.showInputBox({
        prompt: regex ? "正規表現で全文検索（JavaScript構文）" : "全文検索",
        placeHolder: "検索する言葉",
      }));
    if (query === undefined) return;
    const results = regex
      ? await regexSearch(store.all(), query)
      : search(store.all(), query);
    if (query)
      await context.globalState.update(
        "history",
        [
          { query, regex },
          ...context.globalState
            .get<{ query: string; regex: boolean }[]>("history", [])
            .filter((x) => x.query !== query || x.regex !== regex),
        ].slice(0, 50),
      );
    await pickNotes(results, `howm: ${query || "すべて"} (${results.length})`);
  }
  async function follow(target: string, note?: Note) {
    if (
      note &&
      (target.startsWith("./") ||
        target.startsWith("../") ||
        target.startsWith("/") ||
        target.startsWith("~/") ||
        /\.[a-z0-9]{1,8}$/i.test(target))
    ) {
      const base = vscode.Uri.parse(note.uri);
      const uri = target.startsWith("~/")
        ? vscode.Uri.file(require("os").homedir() + "/" + target.slice(2))
        : target.startsWith("/")
          ? base.with({ path: target })
          : vscode.Uri.joinPath(
              base.with({
                path: base.path.slice(0, base.path.lastIndexOf("/")),
              }),
              target,
            );
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.commands.executeCommand("vscode.open", uri);
        return;
      } catch {
        /* A missing file name is still a searchable phrase. */
      }
    }
    await doSearch(target);
  }
  const selector = [
    { language: "markdown", scheme: "file" },
    { language: "markdown", scheme: "vscode-remote" },
  ];
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks(doc) {
        if (!store.contains(doc.uri)) return [];
        const note = parseNote(doc.uri.toString(), doc.getText());
        return keywordLinks(note, store.keywords()).map((link) => {
          const uri = vscode.Uri.parse(
            `command:howm.openLink?${encodeURIComponent(JSON.stringify([link.target, note.uri]))}`,
          );
          const result = new vscode.DocumentLink(
            new vscode.Range(link.line, link.start, link.line, link.end),
            uri,
          );
          result.tooltip = `howm: ${link.target}`;
          return result;
        });
      },
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { scheme: "howm" },
      {
        provideDocumentLinks: (doc) =>
          (virtual.get(doc.uri.toString())?.links || []).map(
            (l) => new vscode.DocumentLink(l.range, l.uri),
          ),
      },
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(doc, pos) {
          if (
            !store.contains(doc.uri) ||
            !/^\s*(>>>|<<<)\s/.test(doc.lineAt(pos).text)
          )
            return [];
          const prefix = doc.lineAt(pos).text.slice(0, pos.character);
          const start = prefix.search(/\S/) + 3;
          return store.keywords().map((k) => {
            const c = new vscode.CompletionItem(
              k,
              vscode.CompletionItemKind.Reference,
            );
            c.range = new vscode.Range(
              pos.line,
              start + 1,
              pos.line,
              pos.character,
            );
            return c;
          });
        },
      },
      " ",
    ),
  );
  const treeChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    treeChange,
    store.onChange(() => treeChange.fire()),
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider<Note>("howm.notes", {
      onDidChangeTreeData: treeChange.event,
      getChildren: () => store.all().slice(0, 200),
      getTreeItem: noteTreeItem,
    }),
  );
  const todos = new TodoProvider(store);
  context.subscriptions.push(todos);
  let todoView: vscode.TreeView<TodoNode> | undefined;
  let registration: Promise<vscode.TreeView<TodoNode> | undefined> | undefined;
  const ensureTodoView = async () => {
    if (todoView) return todoView;
    if (registration) return registration;
    registration = (async () => {
      // An extension-host restart can load new code while the workbench still
      // has the previous manifest. Register only after the native view exists.
      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes("howm.todos.focus")) return undefined;
      todoView = vscode.window.createTreeView<TodoNode>("howm.todos", {
        treeDataProvider: todos,
        showCollapseAll: true,
      });
      todos.attach(todoView);
      context.subscriptions.push(todoView);
      return todoView;
    })();
    try {
      return await registration;
    } finally {
      registration = undefined;
    }
  };
  const offerWindowReload = () => {
    void vscode.window
      .showInformationMessage(
        "howm: Todoビューの登録がまだ反映されていません。Developer: Reload Window（ウィンドウの再読み込み）を実行してください。",
        "ウィンドウを再読み込み",
      )
      .then((choice) =>
        choice
          ? vscode.commands.executeCommand("workbench.action.reloadWindow")
          : undefined,
      )
      .then(undefined, (error) => output.appendLine(String(error)));
  };
  await ensureTodoView();
  register("showTodos", async () => {
    const view = await ensureTodoView();
    if (!view) {
      offerWindowReload();
      return false;
    }
    let listener: vscode.Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = view.visible
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          listener = view.onDidChangeVisibility((e) => {
            if (e.visible) resolve(true);
          });
          timer = setTimeout(() => resolve(view.visible), 1000);
        });
    try {
      await vscode.commands.executeCommand("howm.todos.focus");
      if (!(await visible)) {
        offerWindowReload();
        return false;
      }
      await todos.refresh();
      return true;
    } finally {
      listener?.dispose();
      if (timer) clearTimeout(timer);
    }
  });
  register("openReminder", async (entry: TodoEntry) => {
    if (entry?.type !== "reminder") return;
    const uri = vscode.Uri.parse(entry.note.uri);
    if (!store.contains(uri)) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.getText() !== entry.note.text) {
      await store.read(uri);
      todos.update();
      void vscode.window.showInformationMessage(
        "メモが変更されています。一覧の更新後にもう一度選択してください。",
      );
      return;
    }
    await open(entry.note, entry.reminder.line);
  });
  register("completeReminder", async (entry: TodoEntry) => {
    if (entry?.type !== "reminder") return;
    await completeReminder(store, entry.note, entry.reminder);
    todos.update();
  });
  register("configure", configure);
  register("create", async (providedTitle?: string) => {
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.document.getText(editor.selection) || "";
    const title =
      providedTitle ??
      (await vscode.window.showInputBox({
        prompt: "タイトル（空でも作成できます）",
        value: selection.split("\n")[0],
      }));
    if (title !== undefined) await create(title);
  });
  register("capture", async () => {
    const body = await vscode.window.showInputBox({ prompt: "速記する内容" });
    if (body) await create("", body);
  });
  register("search", (q?: string) => doSearch(q));
  register("searchRegex", () => doSearch(undefined, true));
  register("list", () => pickNotes(store.all(), "howm: メモ一覧"));
  register("recent", () =>
    pickNotes(store.all().slice(0, 50), "howm: 最近の50件"),
  );
  register("openLink", (target: string, uri: string) =>
    follow(target, store.notes.get(uri)),
  );
  register("follow", async () => {
    const e = vscode.window.activeTextEditor;
    if (!e || !store.contains(e.document.uri)) return;
    const n = parseNote(e.document.uri.toString(), e.document.getText());
    const link = keywordLinks(n, store.keywords()).find(
      (l) =>
        l.line === e.selection.active.line &&
        l.start <= e.selection.active.character &&
        l.end >= e.selection.active.character,
    );
    if (link) await follow(link.target, n);
    else
      void vscode.window.showInformationMessage(
        "カーソル位置にhowmリンクがありません",
      );
  });
  register("related", async () => {
    const e = vscode.window.activeTextEditor;
    if (!e || !store.contains(e.document.uri)) return;
    const n = parseNote(e.document.uri.toString(), e.document.getText());
    const terms = [
      ...n.keywords,
      ...keywordLinks(n, store.keywords()).map((l) => l.target),
    ];
    const candidates = store
      .all()
      .filter(
        (other) =>
          other.uri !== n.uri && terms.some((k) => other.text.includes(k)),
      );
    await pickNotes(candidates, "howm: 関連メモ");
  });
  register("concatenate", () => concatenate());
  register("random", async () => {
    const all = store.all();
    if (all.length) await open(all[Math.floor(Math.random() * all.length)]);
  });
  register("history", async () => {
    const items = context.globalState
      .get<{ query: string; regex: boolean }[]>("history", [])
      .map((h) => ({
        ...h,
        label: h.query,
        description: h.regex ? "正規表現" : "固定文字列",
      }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "検索履歴",
    });
    if (selected) await doSearch(selected.query, selected.regex);
  });
  register("insertDate", async () => {
    const e = vscode.window.activeTextEditor;
    if (e) await e.edit((b) => b.replace(e.selection, `[${dateString()}]`));
  });
  register("insertKeyword", async () => {
    const e = vscode.window.activeTextEditor;
    const keyword = await vscode.window.showQuickPick(store.keywords());
    if (e && keyword) await e.edit((b) => b.replace(e.selection, keyword));
  });
  register("reminders", async () => {
    // Reconcile before opening: filesystem notifications can be missed when
    // a watched directory did not exist yet or a sync client replaces it.
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "howm: Todoと予定を読み込み中",
      },
      () => store.initialize(),
    );
    const today = dateString();
    const { all, unfinished, schedule, todos, hidden } = reminderList(
      store.all(),
      today,
    );
    const row = (x: (typeof all)[number]) => ({
      label: `${x.r.date} ${x.r.kind} ${x.r.text}`,
      description: x.note.title,
      note: x.note,
      line: x.r.line,
    });
    const items: (vscode.QuickPickItem & {
      note?: Note;
      line?: number;
      action?: string;
    })[] = [];
    if (todos.length)
      items.push(
        { label: "Todo（優先度順）", kind: vscode.QuickPickItemKind.Separator },
        ...todos.map(row),
      );
    if (schedule.length)
      items.push(
        {
          label: "これからの予定・締切",
          kind: vscode.QuickPickItemKind.Separator,
        },
        ...schedule.map(row),
      );
    if (!items.length) {
      const reason = !store.notes.size
        ? "対象のMarkdownメモが読み込まれていません。保存先を確認してください。"
        : !all.length
          ? "リマインダが見つかりません。本文に [YYYY-MM-DD]+ 内容 のように記述してください（コードブロック内は対象外）。"
          : !unfinished.length
            ? "リマインダはすべて完了済みです。"
            : "開始前のTodo、または過去の予定だけが見つかりました。";
      items.push({ label: reason, alwaysShow: true });
    }
    if (hidden.length)
      items.push(
        {
          label: "開始前のTodo・過去の予定を確認",
          kind: vscode.QuickPickItemKind.Separator,
        },
        ...hidden.map(row),
      );
    items.push(
      { label: "設定と更新", kind: vscode.QuickPickItemKind.Separator },
      {
        label: "$(folder-opened) メモの保存先を選択",
        description: store.root?.fsPath || "未設定",
        action: "configure",
        alwaysShow: true,
      },
      {
        label: "$(refresh) 索引を再構築して再表示",
        action: "refresh",
        alwaysShow: true,
      },
    );
    const chosen = await vscode.window.showQuickPick(items, {
      title: `howm: Todoと予定 — ${today} / メモ${store.notes.size}件 / リマインダ${all.length}件`,
      matchOnDescription: true,
      placeHolder:
        "選択すると元の行へ移動。完了は howm: この行のリマインダを完了",
    });
    if (chosen?.note) await open(chosen.note, chosen.line);
    else if (chosen?.action) {
      await vscode.commands.executeCommand(`howm.${chosen.action}`);
      await vscode.commands.executeCommand("howm.reminders");
    }
  });
  register("complete", async () => {
    const e = vscode.window.activeTextEditor;
    if (!e || !store.contains(e.document.uri)) return;
    const n = parseNote(e.document.uri.toString(), e.document.getText());
    const r = n.reminders.find(
      (r) => r.line === e.selection.active.line && r.kind !== ".",
    );
    if (!r) {
      void vscode.window.showInformationMessage(
        "この行に未完了のリマインダがありません",
      );
      return;
    }
    await completeReminder(store, n, r);
    todos.update();
  });
  register("changeDate", async () => {
    const e = vscode.window.activeTextEditor;
    if (!e || !store.contains(e.document.uri)) return;
    const line = e.selection.active.line;
    const n = parseNote(e.document.uri.toString(), e.document.getText());
    const m = /\[(\d{4}-\d{2}-\d{2})/.exec(n.active[line]);
    if (!m) return;
    const version = e.document.version;
    const value = await vscode.window.showInputBox({
      value: m[1],
      prompt: "日付 YYYY-MM-DD",
      validateInput: (s) =>
        Number.isFinite(dayNumber(s))
          ? undefined
          : "有効な日付を入力してください",
    });
    if (value && version === e.document.version)
      await e.edit((b) =>
        b.replace(
          new vscode.Range(line, m.index + 1, line, m.index + 11),
          value,
        ),
      );
  });
  register("refresh", async () => {
    await store.initialize();
    void vscode.window.showInformationMessage(
      `howm: ${store.notes.size}件を索引化${store.skipped ? `（サイズ超過 ${store.skipped}件）` : ""}`,
    );
  });
  register("home", async () => {
    const choices = [
      ["新しいメモ", "create"],
      ["速記", "capture"],
      ["全文検索", "search"],
      ["最近のメモ", "recent"],
      ["メモ一覧", "list"],
      ["Todoと予定（サイドバー）", "showTodos"],
      ["Todoと予定（パレット）", "reminders"],
      ["検索履歴", "history"],
      ["ランダムなメモ", "random"],
      ["保存先を選択", "configure"],
    ];
    const chosen = await vscode.window.showQuickPick(
      choices.map(([label, command]) => ({ label, command })),
      { title: `howm — ${store.notes.size} notes` },
    );
    if (chosen) await vscode.commands.executeCommand(`howm.${chosen.command}`);
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("howm"))
        void store
          .initialize()
          .catch((error) => output.appendLine(String(error)));
    }),
  );
  await store.initialize();
}
export function deactivate() {}
