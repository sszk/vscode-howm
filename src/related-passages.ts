import { uiLanguage } from "./localization";
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { noteAtLine, noteDisplayDate } from "./core";
import { Store } from "./storage";
import { openNote } from "./navigation";
import {
  extractPassageQuery,
  PassageIndex,
  PassageQuery,
  RelatedPassage,
} from "./related-passages-model";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export class RelatedPassagesProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private viewSubscriptions: vscode.Disposable[] = [];
  private index = new PassageIndex();
  private results: RelatedPassage[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private lastTarget = "";
  private renderId = "";
  private ready = false;
  private disposed = false;
  private message = "";

  constructor(private store: Store) {
    this.subscriptions.push(
      store.onChange(() => this.changed()),
      vscode.window.onDidChangeActiveTextEditor(() => this.targetChanged()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor)
          this.targetChanged();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("howm.relatedPassages")) return;
        this.cancel();
        if (!this.settings.enabled) this.index.dispose();
        void this.update();
      }),
    );
  }

  private get settings() {
    const config = vscode.workspace.getConfiguration("howm");
    const integer = (key: string, fallback: number, minimum: number) => {
      const value = config.get<number>(`relatedPassages.${key}`, fallback);
      return Number.isFinite(value)
        ? Math.max(minimum, Math.floor(value))
        : fallback;
    };
    const windowLines = integer("windowLines", 5, 1);
    const min = config.get<number>("relatedPassages.minSimilarity", 0.15);
    return {
      enabled: config.get("relatedPassages.enabled", true),
      autoRefresh: config.get("relatedPassages.autoRefresh", true),
      maxResults: integer("maxResults", 10, 1),
      minSimilarity: Number.isFinite(min)
        ? Math.max(0, Math.min(1, min))
        : 0.15,
      contextLines: integer("contextLines", 5, 0),
      minQueryLength: integer("minQueryLength", 30, 1),
      windowLines,
      windowStep: Math.min(windowLines, integer("windowStep", 2, 1)),
    };
  }

  private target(): PassageQuery | undefined {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      editor.document.languageId !== "markdown" ||
      !this.store.contains(editor.document.uri)
    )
      return;
    const note = noteAtLine(
      this.store.files.get(editor.document.uri.toString()) || [],
      editor.selection.active.line,
    );
    if (!note) return;
    const settings = this.settings;
    return extractPassageQuery(
      note,
      editor.selection.active.line,
      settings.contextLines,
      settings.minQueryLength,
    );
  }

  private targetKey(query?: PassageQuery) {
    return query ? JSON.stringify([query.note.id, query.text]) : "";
  }

  private targetChanged() {
    if (!this.view?.visible || !this.settings.enabled) return;
    const target = this.target();
    const key = this.targetKey(target);
    if (key === this.lastTarget) return;
    this.lastTarget = key;
    this.changed();
  }

  private changed() {
    this.cancel();
    if (!this.settings.enabled || !this.view?.visible) return;
    // Invalidate rows immediately, including during the debounce interval.
    this.publish(
      [],
      this.settings.autoRefresh
        ? vscode.l10n.t("Updating related passages…")
        : vscode.l10n.t("Auto refresh is disabled. Click Refresh to update."),
    );
    if (this.settings.autoRefresh) this.schedule();
  }

  private cancel() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule() {
    if (this.disposed || !this.view?.visible) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update();
    }, 500);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.cancel();
    this.viewSubscriptions.forEach((s) => s.dispose());
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage(async (message) => {
        try {
          if (message?.type === "ready") {
            this.ready = true;
            this.render();
          } else if (
            message?.type === "open" &&
            message.renderId === this.renderId &&
            typeof message.id === "string"
          ) {
            const result = this.results.find(
              (r) => r.passage.id === message.id,
            );
            if (result) await this.open(result);
          }
        } catch (error) {
          void vscode.window.showErrorMessage(`howm: ${String(error)}`);
        }
      }),
      view.onDidChangeVisibility(() => {
        this.cancel();
        if (view.visible) void this.update();
      }),
      view.onDidDispose(() => {
        this.cancel();
        this.view = undefined;
        this.ready = false;
        this.results = [];
      }),
    ];
    view.webview.html = this.html();
    if (view.visible) void this.update();
  }

  async refresh() {
    this.cancel();
    // Store's initial scan and file watcher own discovery. Opening or refreshing
    // this view never rescans all files; synchronize the current in-memory index.
    await this.update();
  }

  async update() {
    this.cancel();
    if (this.disposed || !this.view?.visible) return;
    const settings = this.settings;
    if (!settings.enabled) {
      this.publish([], vscode.l10n.t("Related Passages is disabled."));
      return;
    }
    const query = this.target();
    this.lastTarget = this.targetKey(query);
    if (!query) {
      this.publish(
        [],
        this.store.error ||
          (this.store.loading
            ? vscode.l10n.t("Loading notes…")
            : vscode.l10n.t(
                "Place the cursor in a longer passage in a Markdown howm note in the notes folder.",
              )),
      );
      return;
    }
    const generation = this.generation;
    const cancelled = () =>
      this.disposed || generation !== this.generation || !this.view?.visible;
    this.publish([], vscode.l10n.t("Finding related passages…"));
    if (
      !(await this.index.sync(
        this.store.all(),
        settings.windowLines,
        settings.windowStep,
        cancelled,
      ))
    )
      return;
    const results = await this.index.search(
      query,
      settings.maxResults,
      settings.minSimilarity,
      cancelled,
    );
    if (cancelled()) return;
    this.publish(
      results,
      this.store.error ||
        (!results.length ? vscode.l10n.t("No related passages.") : ""),
    );
  }

  private async open(result: RelatedPassage) {
    const snapshot = result.passage;
    const current = this.store.files
      .get(snapshot.note.uri)
      ?.find((n) => n.id === snapshot.note.id);
    if (!current || current.source.text !== snapshot.note.source.text) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "The note has changed. Refresh related passages and select it again.",
        ),
      );
      await this.update();
      return;
    }
    const end = snapshot.endLine - 1;
    const range = new vscode.Range(
      snapshot.startLine,
      0,
      end,
      current.lines[end - current.startLine].length,
    );
    // openNote checks the current editor/disk text again before using the range.
    const editor = await openNote(
      this.store,
      current,
      snapshot.startLine,
      false,
      range,
    );
    if (editor && editor.document.getText() === current.source.text) {
      editor.selection = new vscode.Selection(range.end, range.start);
    } else await this.update();
  }

  private publish(results: RelatedPassage[], message: string) {
    if (this.disposed || !this.view?.visible) return;
    this.results = results;
    this.message = message;
    this.view.description = vscode.l10n.t("{0} items", results.length);
    this.render();
  }

  private render() {
    if (!this.view?.visible || !this.ready) return;
    this.renderId = randomBytes(16).toString("hex");
    const html = this.results
      .map(({ passage: p, score, excerpt }) => {
        const { date } = noteDisplayDate(p.note);
        const tooltip = vscode.l10n.t(
          "{0}:{1}\nRelevance: {2}",
          vscode.Uri.parse(p.note.uri).fsPath,
          p.startLine + 1,
          score.toFixed(3),
        );
        return `<button class="passage" data-id="${escape(p.id)}" title="${escape(tooltip)}"><span class="title">${escape(p.note.title)}</span><span class="meta">${escape(vscode.l10n.t("{0} · Line {1}", date, p.startLine + 1))}</span><span class="excerpt">${escape(excerpt)}</span></button>`;
      })
      .join("");
    void this.view.webview.postMessage({
      type: "results",
      html,
      status: this.message,
      renderId: this.renderId,
    });
  }

  private html() {
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html><html lang="${uiLanguage()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
    body{margin:0;padding:0 10px 6px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
    .passage{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:0;border-radius:2px;padding:6px;cursor:pointer}
    .passage:hover{background:var(--vscode-list-hoverBackground)}.passage:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .title{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:11px;color:var(--vscode-descriptionForeground)}
    .excerpt{white-space:pre-line;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    #status{white-space:pre-wrap;color:var(--vscode-descriptionForeground)}#status:empty{display:none}
    </style></head><body><p id="status" role="status"></p><main id="results" aria-label="${escape(vscode.l10n.t("Related Passages"))}"></main>
    <script nonce="${nonce}">
    const vscode=acquireVsCodeApi(),results=document.getElementById('results');let renderId='';
    results.addEventListener('click',event=>{const button=event.target.closest('button[data-id]');if(button)vscode.postMessage({type:'open',id:button.dataset.id,renderId});});
    window.addEventListener('message',event=>{const message=event.data;if(message.type!=='results')return;
      const id=document.activeElement?.dataset?.id,scroll=document.documentElement.scrollTop;
      results.innerHTML=message.html;renderId=message.renderId;document.getElementById('status').textContent=message.status;
      document.documentElement.scrollTop=scroll;
      if(id)Array.from(results.querySelectorAll('button')).find(button=>button.dataset.id===id)?.focus({preventScroll:true});
    });vscode.postMessage({type:'ready'});
    </script></body></html>`;
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.viewSubscriptions.forEach((s) => s.dispose());
    this.subscriptions.forEach((s) => s.dispose());
    this.index.dispose();
    this.view = undefined;
    this.results = [];
  }
}
