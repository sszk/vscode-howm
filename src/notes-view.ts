import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { Note, noteDisplayDate } from "./core";
import { Store } from "./storage";
import { LineMatch, matchSnippet, searchLines } from "./notes-search";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function highlighted(match: LineMatch): string {
  const snippet = matchSnippet(match);
  let html = snippet.start ? "…" : "",
    offset = 0;
  for (const range of snippet.ranges) {
    html +=
      escape(snippet.text.slice(offset, range.start)) +
      `<mark>${escape(snippet.text.slice(range.start, range.end))}</mark>`;
    offset = range.end;
  }
  return (
    html +
    escape(snippet.text.slice(offset)) +
    (snippet.end < match.text.length ? "…" : "")
  );
}

export class NotesViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private viewSubscriptions: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private query = "";
  private limit = 200;
  private renderId = "";
  private displayed = new Map<
    string,
    { note: Note; selection?: vscode.Range }
  >();
  private ready = false;
  private focusRequested = false;
  private readyEvent = new vscode.EventEmitter<void>();

  constructor(
    private store: Store,
    private open: (note: Note, selection?: vscode.Range) => Promise<unknown>,
  ) {
    this.subscriptions.push(
      this.readyEvent,
      store.onChange(() => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.update();
        }, 200);
      }),
      vscode.window.onDidChangeWindowState((event) => {
        if (event.focused && this.view?.visible) void this.refresh();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.viewSubscriptions.forEach((subscription) => subscription.dispose());
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage(async (message) => {
        try {
          if (
            (message?.type === "ready" || message?.type === "search") &&
            typeof message.query === "string"
          ) {
            const changed = this.query !== message.query;
            this.query = message.query;
            if (changed) this.limit = 200;
            if (message.type === "ready") this.ready = true;
            this.update(changed);
            if (message.type === "ready") {
              this.readyEvent.fire();
              this.sendFocus();
            }
          } else if (
            message?.type === "more" &&
            message.renderId === this.renderId &&
            message.query === this.query &&
            this.query
          ) {
            this.limit += 200;
            this.update();
          } else if (
            message?.type === "open" &&
            typeof message.renderId === "string" &&
            message.query === this.query &&
            typeof message.id === "string"
          ) {
            if (message.renderId !== this.renderId) {
              this.update();
              void vscode.window.showInformationMessage(
                "検索結果が更新されています。もう一度選択してください。",
              );
              return;
            }
            const entry = this.displayed.get(message.id);
            if (entry) await this.open(entry.note, entry.selection);
          }
        } catch (error) {
          void vscode.window.showErrorMessage(`howm: ${String(error)}`);
        }
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.refresh();
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
        this.displayed.clear();
        this.viewSubscriptions.forEach((subscription) =>
          subscription.dispose(),
        );
        this.viewSubscriptions = [];
      }),
    ];
    view.webview.html = this.html();
    void this.refresh();
  }

  private async refresh() {
    try {
      await this.store.initialize();
    } catch {
      /* Store exposes the reason. */
    }
    this.update();
  }

  async focusSearch(): Promise<boolean> {
    this.focusRequested = true;
    let listener: vscode.Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<boolean>((resolve) => {
      listener = this.readyEvent.event(() => resolve(true));
      timer = setTimeout(() => resolve(false), 1500);
    });
    try {
      await vscode.commands.executeCommand("howm.notes.focus");
      if (!this.ready && !(await loaded)) return false;
      this.sendFocus();
      return true;
    } finally {
      listener?.dispose();
      if (timer) clearTimeout(timer);
    }
  }

  private sendFocus() {
    if (this.focusRequested && this.ready && this.view) {
      this.focusRequested = false;
      void this.view.webview.postMessage({ type: "focus" });
    }
  }

  private update(resetScroll = false) {
    if (!this.view || !this.ready) return;
    const notes = this.store.all();
    this.renderId = randomBytes(16).toString("hex");
    this.displayed.clear();
    let html = "",
      total = notes.length,
      shown = Math.min(200, total),
      noteCount = total;
    const heading = (note: Note) => {
      const { date, source } = noteDisplayDate(note);
      const id = JSON.stringify(["note", note.id]);
      this.displayed.set(id, { note });
      const tooltip = `${vscode.Uri.parse(note.uri).fsPath}:${note.startLine + 1}\n${source}: ${date}`;
      return `<button class="note" data-id="${escape(id)}" title="${escape(tooltip)}"><span class="title">${escape(note.title)}</span><span class="date">${date}</span></button>`;
    };
    if (this.query) {
      const results = searchLines(notes, this.query);
      total = results.length;
      shown = Math.min(this.limit, total);
      noteCount = new Set(results.map((result) => result.note.id)).size;
      let previous = "";
      for (const match of results.slice(0, shown)) {
        if (match.note.id !== previous) {
          html += heading(match.note);
          previous = match.note.id;
        }
        const first = match.ranges[0];
        this.displayed.set(match.id, {
          note: match.note,
          selection: new vscode.Range(
            match.line,
            first.start,
            match.line,
            first.end,
          ),
        });
        const tooltip = `${vscode.Uri.parse(match.note.uri).fsPath}:${match.line + 1}\n${match.text}`;
        html += `<button class="match" data-id="${escape(match.id)}" title="${escape(tooltip)}"><span class="line">${match.line + 1}</span><span class="text">${highlighted(match)}</span></button>`;
      }
    } else html = notes.slice(0, 200).map(heading).join("");
    if (!total)
      html = `<p>${this.query ? "一致する行がありません。" : "メモがありません。"}</p>`;
    const status = this.store.error
      ? `${this.store.error}\n保存先: ${this.store.root?.fsPath || "未設定"}\n更新ボタンで再試行してください。`
      : this.store.loading
        ? "読み込み中…"
        : !this.store.root
          ? "メモの保存先を選択してください。"
          : "";
    void this.view.webview.postMessage({
      type: "results",
      query: this.query,
      renderId: this.renderId,
      html,
      status,
      count: this.query
        ? `${total}行 · ${noteCount}メモ${shown < total ? `（${shown}行表示）` : ""}`
        : `${shown} / ${total}メモ`,
      more: !!this.query && shown < total,
      resetScroll,
    });
  }

  private html(): string {
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
    html,body{height:100%}body{margin:0;display:flex;flex-direction:column;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
    header{padding:6px 10px;flex-shrink:0}.search{display:flex;gap:4px}input{box-sizing:border-box;min-width:0;flex:1;font:inherit;padding:4px 6px;border:1px solid var(--vscode-input-border,transparent);border-radius:2px;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}input::placeholder{color:var(--vscode-input-placeholderForeground)}input::-webkit-search-cancel-button{display:none}
    button{font:inherit;color:inherit;background:transparent;border:0;border-radius:2px;cursor:pointer}button:focus-visible,input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.clear{padding:0 6px;font-size:18px}button:disabled{opacity:.4;cursor:default}
    #count{margin-top:4px;font-size:11px;color:var(--vscode-descriptionForeground)}#status{white-space:pre-wrap;color:var(--vscode-descriptionForeground)}#status:empty{display:none}
    main{flex:1;min-height:0;overflow:auto;padding:0 10px 6px}.note,.match{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:4px 6px}.note:hover,.match:hover{background:var(--vscode-list-hoverBackground)}.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.date,.line{font-size:11px;color:var(--vscode-descriptionForeground);flex-shrink:0}.line{min-width:2.5em;text-align:right}.text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.match{align-items:baseline}.match+.note{margin-top:6px}mark{background:var(--vscode-editor-findMatchHighlightBackground);color:inherit;border:1px solid var(--vscode-editor-findMatchHighlightBorder,transparent)}p{color:var(--vscode-descriptionForeground)}#more{display:block;margin:6px auto;padding:4px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}[hidden]{display:none!important}
    </style></head><body><header><div class="search"><input id="query" type="search" aria-label="メモの全文検索" placeholder="全文検索…" value="${escape(this.query)}"><button id="clear" class="clear" aria-label="検索をクリア" title="検索をクリア">×</button></div><div id="count" role="status"></div><div id="status" role="status"></div></header><main id="main"><div id="results"></div><button id="more" hidden>さらに表示</button></main>
    <script nonce="${nonce}">
    const vscode=acquireVsCodeApi(),input=document.getElementById('query'),clear=document.getElementById('clear'),results=document.getElementById('results'),main=document.getElementById('main'),more=document.getElementById('more');
    const state=vscode.getState();if(typeof state?.query==='string')input.value=state.query;
    let timer,composing=false,renderId='';
    function save(){vscode.setState({query:input.value});clear.disabled=!input.value;}
    function search(immediate=false){clearTimeout(timer);timer=undefined;save();if(composing)return;const send=()=>{timer=undefined;vscode.postMessage({type:'search',query:input.value});};if(immediate)send();else timer=setTimeout(send,200);}
    function firstResult(){return results.querySelector('.match')||results.querySelector('.note');}
    function reset(){input.value='';input.focus();search(true);}
    input.addEventListener('input',()=>search());
    input.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);timer=undefined;});
    input.addEventListener('compositionend',()=>{composing=false;search();});
    clear.addEventListener('click',reset);
    document.addEventListener('keydown',event=>{
      if(composing||event.isComposing)return;
      if(event.key==='Escape'){event.preventDefault();reset();}
      else if(event.target===input&&event.key==='ArrowDown'){event.preventDefault();firstResult()?.focus();}
      else if(event.target===input&&event.key==='Enter'){event.preventDefault();if(timer)search(true);else firstResult()?.click();}
    });
    results.addEventListener('click',event=>{const button=event.target.closest('button[data-id]');if(button)vscode.postMessage({type:'open',id:button.dataset.id,query:input.value,renderId});});
    more.addEventListener('click',()=>vscode.postMessage({type:'more',query:input.value,renderId}));
    window.addEventListener('message',event=>{
      const message=event.data;
      if(message.type==='focus'){input.focus();input.select();}
      else if(message.type==='results'&&message.query===input.value){
        const focused=document.activeElement,focusId=results.contains(focused)?focused.dataset.id:undefined,scroll=main.scrollTop;
        results.innerHTML=message.html;renderId=message.renderId;
        document.getElementById('count').textContent=message.count;document.getElementById('status').textContent=message.status;more.hidden=!message.more;
        main.scrollTop=message.resetScroll?0:scroll;
        if(focusId){const buttons=Array.from(results.querySelectorAll('button'));(buttons.find(button=>button.dataset.id===focusId)||buttons[0]||input).focus({preventScroll:true});}
      }
    });
    save();vscode.postMessage({type:'ready',query:input.value});
    </script></body></html>`;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.viewSubscriptions.forEach((subscription) => subscription.dispose());
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.view = undefined;
    this.displayed.clear();
  }
}
