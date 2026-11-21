import { errorMessage } from "./localization";
import * as vscode from "vscode";
import { Store } from "./storage";
import { CalendarProvider } from "./calendar";
import { noteTreeItem } from "./notes";
import { NotesViewProvider } from "./notes-view";
import { TodoProvider, TodoEntry, TodoNode } from "./todos";
import { completeReminder } from "./reminders";
import { openNote } from "./navigation";
import { LocalDayClock } from "./local-day";
import { parseHowmDate } from "./date-input";
import { insertWindowsPathLink } from "./windows-path-link-command";
import { OnThisDayProvider, AnniversaryNode } from "./on-this-day";
import { SimilarNotesProvider } from "./similar-notes";
import { SimilarNotesViewProvider } from "./similar-notes-view";
import { RelatedPassagesProvider } from "./related-passages";
import { PinnedNotes } from "./pinned-notes";
import { PinCommands } from "./pin-commands";
import { regexSearch } from "./search";
import { registerUrlPaste } from "./url-paste";
import {
  Note,
  search,
  keywordLinks,
  parseNotes,
  noteAtLine,
  relatedNotes,
  dateString,
  reminderList,
  renderTemplate,
  filename,
  howmFilenameDateTime,
  selectDailyMemo,
} from "./core";
export async function activate(context: vscode.ExtensionContext) {
  registerUrlPaste(context);
  const store = new Store();
  context.subscriptions.push(store);
  const output = vscode.window.createOutputChannel("Markdown howm");
  context.subscriptions.push(output);
  let lastResults: Note[] = [];
  let createQueue = Promise.resolve();
  let dailyQueue = Promise.resolve();
  const register = (name: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `howm.${name}`,
        async (...args: any[]) => {
          try {
            return await fn(...args);
          } catch (error) {
            output.appendLine(String(error));
            void vscode.window.showErrorMessage(`howm: ${errorMessage(error)}`);
          }
        },
      ),
    );
  const pins = new PinnedNotes(context.globalState, store);
  context.subscriptions.push(pins, new PinCommands(store, pins, register));
  const open = (note: Note, line = note.startLine, preview = false) =>
    openNote(store, note, line, preview);
  register("openNote", (note: Note) => (note?.id ? open(note) : undefined));
  register("openDiscoveryNote", (snapshot: Note) => {
    if (!snapshot?.id) return;
    const current = store.files
      .get(snapshot.uri)
      ?.find((note) => note.id === snapshot.id);
    // Section IDs contain a line number and can be reused after edits. Never
    // resolve an old row to a different section at that line.
    if (!current || current.source.text !== snapshot.source.text) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("The note list has changed. Select a note again."),
      );
      return;
    }
    return open(current);
  });
  const configure = async () => {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: vscode.l10n.t("Select howm Notes Folder"),
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
    if (!store.root) throw new Error(vscode.l10n.t("Select a notes folder"));
    return store.root;
  };
  async function create(title: string, body = "") {
    let editor: vscode.TextEditor | undefined;
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
        throw new Error(vscode.l10n.t("Could not create the note"));
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
      await store.read(uri);
      editor = await vscode.window.showTextDocument(doc);
    };
    const next = createQueue.then(work);
    createQueue = next.catch(() => {});
    await next;
    return editor;
  }
  const moveCursorToEnd = (editor: vscode.TextEditor) => {
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(
      new vscode.Range(end, end),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  };
  async function pickNotes(notes: Note[], title: string) {
    lastResults = notes;
    if (!notes.length) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("No matching notes"),
      );
      return;
    }
    const picker = vscode.window.createQuickPick<
      vscode.QuickPickItem & { note?: Note; concat?: boolean }
    >();
    picker.title = title;
    picker.placeholder = vscode.l10n.t(
      "Filter by title · Preview the selected note",
    );
    picker.matchOnDescription = true;
    picker.items = [
      { label: vscode.l10n.t("$(book) Read All Notes Together"), concat: true },
      ...notes.map((note) => ({
        label: note.title,
        description: `${vscode.Uri.parse(note.uri).path}:${note.startLine + 1}`,
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
              await open(note, note.startLine, true);
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
    {
      text: string;
      links: { range: vscode.Range; uri: vscode.Uri }[];
      notes: Note[];
    }
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
  register("openVirtualNote", (uri: string, index: number) => {
    if (!Number.isInteger(index)) return;
    const note = virtual.get(uri)?.notes[index];
    return note ? open(note) : undefined;
  });
  let virtualId = 0;
  async function concatenate(notes = lastResults) {
    if (!notes.length) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Open a search or note list first"),
      );
      return;
    }
    const lines = [`# ${vscode.l10n.t("howm — Combined Notes")}`, ""];
    const links: { range: vscode.Range; uri: vscode.Uri }[] = [];
    const uri = vscode.Uri.parse(`howm:/reading-${++virtualId}.md`);
    for (const [index, note] of notes.entries()) {
      const target = vscode.Uri.parse(
        `command:howm.openVirtualNote?${encodeURIComponent(JSON.stringify([uri.toString(), index]))}`,
      );
      const line = lines.length;
      lines.push(
        vscode.l10n.t("Open source note: {0}", note.title),
        "",
        note.text,
        "",
        "---",
        "",
      );
      links.push({
        range: new vscode.Range(line, 0, line, lines[line].length),
        uri: target,
      });
    }
    // Count embedded newlines when computing source navigation ranges.
    let offset = 2;
    for (let i = 0; i < notes.length; i++) {
      links[i].range = new vscode.Range(
        offset,
        0,
        offset,
        vscode.l10n.t("Open source note: {0}", notes[i].title).length,
      );
      offset += 6 + notes[i].text.split("\n").length - 1;
    }
    virtual.set(uri.toString(), { text: lines.join("\n"), links, notes });
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
      { preview: false },
    );
  }
  async function doSearch(query?: string, regex = false) {
    query =
      query ??
      (await vscode.window.showInputBox({
        prompt: regex
          ? vscode.l10n.t(
              "Search all text with a regular expression (JavaScript syntax)",
            )
          : vscode.l10n.t("Search All Text"),
        placeHolder: vscode.l10n.t("Search terms"),
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
    await pickNotes(
      results,
      vscode.l10n.t(
        "howm: {0} ({1})",
        query || vscode.l10n.t("All"),
        results.length,
      ),
    );
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
        return parseNotes(doc.uri.toString(), doc.getText()).flatMap((note) =>
          keywordLinks(note, store.keywords()).map((link) => {
            const uri = vscode.Uri.parse(
              `command:howm.openLink?${encodeURIComponent(JSON.stringify([link.target, note.uri]))}`,
            );
            const result = new vscode.DocumentLink(
              new vscode.Range(link.line, link.start, link.line, link.end),
              uri,
            );
            result.tooltip = `howm: ${link.target}`;
            return result;
          }),
        );
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
          const note = noteAtLine(
            parseNotes(doc.uri.toString(), doc.getText()),
            pos.line,
          );
          if (
            !note ||
            !/^\s*(>>>|<<<)\s/.test(note.active[pos.line - note.startLine])
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
  let notesView: NotesViewProvider | undefined;
  const contributedViews = context.extension.packageJSON.contributes?.views as
    Record<string, { id: string; type?: string }[]> | undefined;
  const notesWebview = Object.values(contributedViews || {})
    .flat()
    .some((view) => view.id === "howm.notes" && view.type === "webview");
  if (notesWebview) {
    notesView = new NotesViewProvider(
      store,
      (note, selection) =>
        openNote(store, note, note.startLine, false, selection),
      pins,
    );
    context.subscriptions.push(
      notesView,
      vscode.window.registerWebviewViewProvider("howm.notes", notesView),
    );
  } else {
    // Retain the tree when testing/running against an older manifest.
    const treeChange = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      treeChange,
      store.onChange(() => treeChange.fire()),
      vscode.window.registerTreeDataProvider<Note>("howm.notes", {
        onDidChangeTreeData: treeChange.event,
        getChildren: () => store.all().slice(0, 200),
        getTreeItem: noteTreeItem,
      }),
    );
  }
  register("focusNotesSearch", async () => {
    if (notesView && (await notesView.focusSearch())) return true;
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t(
          "howm: Run Developer: Reload Window to load the new notes view.",
        ),
        vscode.l10n.t("Reload Window"),
      )
      .then((choice) =>
        choice
          ? vscode.commands.executeCommand("workbench.action.reloadWindow")
          : undefined,
      );
    return false;
  });
  const calendar = new CalendarProvider(store, (note) => open(note), pins);
  context.subscriptions.push(
    calendar,
    vscode.window.registerWebviewViewProvider("howm.calendar", calendar),
  );
  const dayClock = new LocalDayClock();
  const todos = new TodoProvider(store, dateString, dayClock);
  context.subscriptions.push(todos, dayClock);
  const anniversary = new OnThisDayProvider(store, dayClock);
  context.subscriptions.push(anniversary);
  const viewCommands = await vscode.commands.getCommands(true);
  if (viewCommands.includes("howm.onThisDay.focus")) {
    const view = vscode.window.createTreeView<AnniversaryNode>(
      "howm.onThisDay",
      {
        treeDataProvider: anniversary,
        showCollapseAll: true,
      },
    );
    anniversary.attach(view);
    context.subscriptions.push(view);
  }
  register("refreshOnThisDay", () => anniversary.refresh());
  const similarWebview = Object.values(contributedViews || {})
    .flat()
    .some((view) => view.id === "howm.similarNotes" && view.type === "webview");
  const similar = similarWebview
    ? new SimilarNotesViewProvider(store, pins, async (note) =>
        vscode.commands.executeCommand("howm.openDiscoveryNote", note),
      )
    : new SimilarNotesProvider(store, pins);
  context.subscriptions.push(similar);
  if (similar instanceof SimilarNotesViewProvider) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("howm.similarNotes", similar),
    );
  } else if (viewCommands.includes("howm.similarNotes.focus")) {
    const view = vscode.window.createTreeView<Note>("howm.similarNotes", {
      treeDataProvider: similar,
    });
    similar.attach(view);
    context.subscriptions.push(view);
  }
  register("refreshSimilarNotes", () => similar.refresh());
  const passages = new RelatedPassagesProvider(store);
  context.subscriptions.push(passages);
  if (
    Object.values(contributedViews || {})
      .flat()
      .some((view) => view.id === "howm.relatedPassages")
  ) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "howm.relatedPassages",
        passages,
      ),
    );
  }
  register("refreshRelatedPassages", () => passages.refresh());
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
        vscode.l10n.t(
          "howm: The Todo view is not registered yet. Run Developer: Reload Window.",
        ),
        vscode.l10n.t("Reload Window"),
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
        prompt: vscode.l10n.t("Title (can be empty)"),
        value:
          selection.split("\n")[0] ||
          vscode.workspace
            .getConfiguration("howm")
            .get<string>("defaultTitle", "メモ"),
      }));
    if (title !== undefined) await create(title);
  });
  register("openDailyMemo", async () => {
    const work = async () => {
      // Reconcile on every invocation so a long-running extension host uses
      // today's date and sees files created outside VS Code.
      await store.initialize();
      if (store.scanFailed)
        throw new Error(
          store.error || vscode.l10n.t("Could not search the notes folder."),
        );
      const today = dateString();
      const knownFiles = new Map<string, Note | undefined>(
        [...store.files.entries()].map(([uri, notes]) => [uri, notes[0]]),
      );
      for (const uri of store.unavailableUris())
        if (!knownFiles.has(uri)) knownFiles.set(uri, undefined);
      const datedFiles = [...knownFiles.entries()]
        .map(([uri, note]) => ({
          uri,
          note,
          filename: howmFilenameDateTime(uri),
        }))
        .filter((file) => file.filename?.date === today);
      const candidates: {
        uri: string;
        path: string;
        modified: number;
        note: Note;
      }[] = [];
      let inaccessible = 0;
      for (const file of datedFiles) {
        try {
          const stat = await vscode.workspace.fs.stat(
            vscode.Uri.parse(file.uri),
          );
          if (!file.note) {
            inaccessible++;
            continue;
          }
          candidates.push({
            uri: file.uri,
            path: vscode.Uri.parse(file.uri).path,
            modified: stat.mtime,
            note: file.note,
          });
        } catch (error) {
          inaccessible++;
          output.appendLine(
            `Daily memo candidate skipped: ${file.uri}: ${String(error)}`,
          );
        }
      }
      const selected = selectDailyMemo(candidates, today);
      if (selected) {
        const editor = await open(selected.note);
        if (editor) moveCursorToEnd(editor);
        return;
      }
      if (inaccessible)
        throw new Error(
          vscode.l10n.t(
            "Could not check today’s memo. No new memo was created.",
          ),
        );
      const editor = await create(
        vscode.workspace
          .getConfiguration("howm")
          .get<string>("defaultTitle", "メモ"),
      );
      if (editor) moveCursorToEnd(editor);
    };
    const next = dailyQueue.then(work);
    dailyQueue = next.catch(() => {});
    await next;
  });
  register("capture", async () => {
    const body = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Quick capture text"),
    });
    if (body) await create("", body);
  });
  register("search", (q?: string) => doSearch(q));
  register("searchRegex", (q?: string) => doSearch(q, true));
  register("list", () =>
    pickNotes(store.all(), vscode.l10n.t("howm: List Notes")),
  );
  register("recent", () =>
    pickNotes(store.all().slice(0, 50), vscode.l10n.t("howm: 50 Recent Notes")),
  );
  register("openLink", (target: string, uri: string) =>
    follow(target, store.files.get(uri)?.[0]),
  );
  register("follow", async () => {
    const e = vscode.window.activeTextEditor;
    if (!e || !store.contains(e.document.uri)) return;
    const n = noteAtLine(
      parseNotes(e.document.uri.toString(), e.document.getText()),
      e.selection.active.line,
    );
    if (!n) return;
    const link = keywordLinks(n, store.keywords()).find(
      (l) =>
        l.line === e.selection.active.line &&
        l.start <= e.selection.active.character &&
        l.end >= e.selection.active.character,
    );
    if (link) await follow(link.target, n);
    else
      void vscode.window.showInformationMessage(
        vscode.l10n.t("No howm link at the cursor"),
      );
  });
  register("related", async () => {
    const e = vscode.window.activeTextEditor;
    if (!e || !store.contains(e.document.uri)) return;
    const n = noteAtLine(
      parseNotes(e.document.uri.toString(), e.document.getText()),
      e.selection.active.line,
    );
    if (!n) return;
    const candidates = relatedNotes(n, store.all(), store.keywords());
    await pickNotes(candidates, vscode.l10n.t("howm: Related Notes"));
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
        description: h.regex
          ? vscode.l10n.t("Regular expression")
          : vscode.l10n.t("Literal text"),
      }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t("Search History"),
    });
    if (selected) await doSearch(selected.query, selected.regex);
  });
  register("insertDate", async () => {
    const e = vscode.window.activeTextEditor;
    if (e) await e.edit((b) => b.replace(e.selection, `[${dateString()}]`));
  });
  async function promptHowmDate(value?: string) {
    const today = new Date();
    const input = await vscode.window.showInputBox({
      value,
      prompt: vscode.l10n.t("Enter a date"),
      placeHolder: vscode.l10n.t("Examples: +7, 15, 12/5, 2027/2/20, mon"),
      validateInput: (s) =>
        parseHowmDate(s, today) === undefined
          ? vscode.l10n.t("Enter a valid date")
          : undefined,
    });
    return input === undefined ? undefined : parseHowmDate(input, today);
  }
  register("inputDate", async () => {
    const e = vscode.window.activeTextEditor;
    if (!e) return;
    const version = e.document.version;
    const selections = [...e.selections];
    const date = await promptHowmDate();
    if (
      date === undefined ||
      vscode.window.activeTextEditor !== e ||
      e.document.version !== version
    )
      return;
    if (
      !(await e.edit((b) => {
        for (const selection of selections) b.replace(selection, `[${date}]`);
      }))
    )
      void vscode.window.showErrorMessage(
        vscode.l10n.t("howm: Could not insert the date"),
      );
  });
  register("insertKeyword", async () => {
    const e = vscode.window.activeTextEditor;
    const keyword = await vscode.window.showQuickPick(store.keywords());
    if (e && keyword) await e.edit((b) => b.replace(e.selection, keyword));
  });
  register("insertWindowsPathLink", insertWindowsPathLink);
  register("reminders", async () => {
    // Reconcile before opening: filesystem notifications can be missed when
    // a watched directory did not exist yet or a sync client replaces it.
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("howm: Loading Todos and Schedule"),
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
        {
          label: vscode.l10n.t("Todos (by Priority)"),
          kind: vscode.QuickPickItemKind.Separator,
        },
        ...todos.map(row),
      );
    if (schedule.length)
      items.push(
        {
          label: vscode.l10n.t("Upcoming Events and Deadlines"),
          kind: vscode.QuickPickItemKind.Separator,
        },
        ...schedule.map(row),
      );
    if (!items.length) {
      const reason = !store.noteCount
        ? vscode.l10n.t("No Markdown notes are loaded. Check the notes folder.")
        : !all.length
          ? vscode.l10n.t(
              "No reminders found. Add [YYYY-MM-DD]+ text to a note outside code blocks.",
            )
          : !unfinished.length
            ? vscode.l10n.t("All reminders are complete.")
            : vscode.l10n.t("Only future Todos or past events were found.");
      items.push({ label: reason, alwaysShow: true });
    }
    if (hidden.length)
      items.push(
        {
          label: vscode.l10n.t("Review Future Todos and Past Events"),
          kind: vscode.QuickPickItemKind.Separator,
        },
        ...hidden.map(row),
      );
    items.push(
      {
        label: vscode.l10n.t("Settings and Refresh"),
        kind: vscode.QuickPickItemKind.Separator,
      },
      {
        label: vscode.l10n.t("$(folder-opened) Select Notes Folder"),
        description: store.root?.fsPath || vscode.l10n.t("Not set"),
        action: "configure",
        alwaysShow: true,
      },
      {
        label: vscode.l10n.t("$(refresh) Rebuild Index and Refresh"),
        action: "refresh",
        alwaysShow: true,
      },
    );
    const chosen = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t(
        "howm: Todos and Schedule — {0} / {1} notes / {2} reminders",
        today,
        store.noteCount,
        all.length,
      ),
      matchOnDescription: true,
      placeHolder: vscode.l10n.t(
        "Select an item to open its source line. To complete it, run howm: Complete Reminder on This Line.",
      ),
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
    const n = noteAtLine(
      parseNotes(e.document.uri.toString(), e.document.getText()),
      e.selection.active.line,
    );
    if (!n) return;
    const r = n.reminders.find(
      (r) => r.line === e.selection.active.line && r.kind !== ".",
    );
    if (!r) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("No unfinished reminder on this line"),
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
    const n = noteAtLine(
      parseNotes(e.document.uri.toString(), e.document.getText()),
      e.selection.active.line,
    );
    if (!n) return;
    const m = /\[(\d{4}-\d{2}-\d{2})/.exec(n.active[line - n.startLine]);
    if (!m) return;
    const version = e.document.version;
    const value = await promptHowmDate(m[1]);
    if (
      value !== undefined &&
      vscode.window.activeTextEditor === e &&
      version === e.document.version
    ) {
      const applied = await e.edit((b) =>
        b.replace(
          new vscode.Range(line, m.index + 1, line, m.index + 11),
          value,
        ),
      );
      if (!applied)
        void vscode.window.showErrorMessage(
          vscode.l10n.t("howm: Could not change the date"),
        );
    }
  });
  register("refresh", async () => {
    await store.initialize();
    void vscode.window.showInformationMessage(
      store.skipped
        ? vscode.l10n.t(
            "howm: Indexed {0} notes ({1} files skipped due to size)",
            store.noteCount,
            store.skipped,
          )
        : vscode.l10n.t("howm: Indexed {0} notes", store.noteCount),
    );
  });
  register("home", async () => {
    const choices = [
      [vscode.l10n.t("Create Note"), "create"],
      [vscode.l10n.t("Capture Note"), "capture"],
      [vscode.l10n.t("Search All Text"), "search"],
      [vscode.l10n.t("Show Recent Notes"), "recent"],
      [vscode.l10n.t("List Notes"), "list"],
      [vscode.l10n.t("Open Todos and Schedule Sidebar"), "showTodos"],
      [vscode.l10n.t("Show Todos and Schedule Picker"), "reminders"],
      [vscode.l10n.t("Search History"), "history"],
      [vscode.l10n.t("Open Random Note"), "random"],
      [vscode.l10n.t("Select Notes Folder"), "configure"],
    ];
    const chosen = await vscode.window.showQuickPick(
      choices.map(([label, command]) => ({ label, command })),
      { title: vscode.l10n.t("howm — {0} notes", store.noteCount) },
    );
    if (chosen) await vscode.commands.executeCommand(`howm.${chosen.command}`);
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void store
        .initialize()
        .catch((error) => output.appendLine(String(error)));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Keep the existing settings' reconciliation behavior. The new view-only
      // settings are handled by their providers and do not require a disk scan.
      if (
        [
          "notesDirectory",
          "maxFileSizeKB",
          "filenamePattern",
          "defaultTitle",
          "template",
          "calendarWeekStart",
        ].some((key) => e.affectsConfiguration(`howm.${key}`))
      )
        void store
          .initialize()
          .catch((error) => output.appendLine(String(error)));
    }),
  );
  await store.initialize();
}
export function deactivate() {}
