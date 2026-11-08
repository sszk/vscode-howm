import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { Note, noteDisplayDate } from "./core";
import { Store } from "./storage";
import { SimilarNotesProvider } from "./similar-notes";
import { PinnedNotes } from "./pinned-notes";
import { pinButton, pinStyles, pinUpdateScript } from "./pin-ui";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

// Keep the existing provider's similarity, settings, cancellation and refresh
// logic. A small webview adapter provides persistent, right-aligned pin buttons.
export class SimilarNotesViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private model: SimilarNotesProvider;
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private viewSubscriptions: vscode.Disposable[] = [];
  private displayed: Note[] = [];
  private renderId = "";
  private message?: string;
  private ready = false;

  constructor(
    store: Store,
    private pins: PinnedNotes,
    private open: (note: Note) => Promise<unknown>,
  ) {
    this.model = new SimilarNotesProvider(store);
    this.subscriptions.push(
      this.model,
      this.model.onDidChangeTreeData(() => this.render()),
      pins.onDidChangePinnedNotes(() => this.updatePins()),
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
          if (message?.type === "ready") {
            this.ready = true;
            this.render();
          } else if (
            (message?.type === "open" || message?.type === "pin") &&
            message.renderId === this.renderId &&
            typeof message.id === "string"
          ) {
            const note = this.displayed.find((note) => note.id === message.id);
            if (!note) return;
            if (message.type === "pin")
              await this.pins.togglePin(vscode.Uri.parse(note.uri));
            else await this.open(note);
          }
        } catch (error) {
          void vscode.window.showErrorMessage(`howm: ${String(error)}`);
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
        this.displayed = [];
      }),
    ];
    view.webview.html = this.html();
    const provider = this;
    this.model.attach({
      get visible() {
        return view.visible && provider.view === view;
      },
      get description() {
        return view.description;
      },
      set description(value) {
        view.description = value;
      },
      get message() {
        return provider.message;
      },
      set message(value) {
        provider.message = value;
      },
      onDidChangeVisibility: view.onDidChangeVisibility,
    });
    if (view.visible) void this.refresh();
  }

  refresh() {
    return this.model.refresh();
  }

  private render() {
    if (!this.view || !this.ready) return;
    this.displayed = this.model.getChildren();
    this.renderId = randomBytes(16).toString("hex");
    const html = this.displayed
      .map((note) => {
        const item = this.model.getTreeItem(note);
        const { date } = noteDisplayDate(note);
        return `<div class="note-row"><button class="note" data-id="${escape(note.id)}" title="${escape(String(item.tooltip || ""))}"><span class="title">${escape(note.title)}</span><span class="date">${date}</span></button>${pinButton(escape(note.id), this.pins.isPinned(vscode.Uri.parse(note.uri)))}</div>`;
      })
      .join("");
    void this.view.webview.postMessage({
      type: "results",
      html,
      status: this.message || "",
      renderId: this.renderId,
    });
  }

  private updatePins() {
    if (!this.view || !this.ready) return;
    void this.view.webview.postMessage({
      type: "pins",
      ids: this.displayed
        .filter((note) => this.pins.isPinned(vscode.Uri.parse(note.uri)))
        .map((note) => note.id),
    });
  }

  private html() {
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
    body{margin:0;padding:0 10px 6px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
    button{font:inherit;color:inherit;background:transparent;border:0;border-radius:2px;cursor:pointer}
    button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .note{display:flex;align-items:center;gap:8px;text-align:left;padding:4px 6px}.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.date{flex-shrink:0;font-size:11px;color:var(--vscode-descriptionForeground)}
    #status{white-space:pre-wrap;color:var(--vscode-descriptionForeground)}#status:empty{display:none}
    ${pinStyles}
    </style></head><body><p id="status" role="status"></p><main id="results"></main>
    <script nonce="${nonce}">
    const vscode=acquireVsCodeApi(),results=document.getElementById('results');let renderId='';
    ${pinUpdateScript}
    results.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      const pin=button.dataset.pinId;event.stopPropagation();
      if(pin&&event.detail>0)button.blur();
      vscode.postMessage({type:pin?'pin':'open',id:pin||button.dataset.id,renderId});
    });
    window.addEventListener('message',event=>{
      const message=event.data;if(message.type!=='results')return;
      const focused=document.activeElement,wasPin=!!focused?.dataset?.pinId,id=wasPin?focused.dataset.pinId:focused?.dataset?.id,scroll=document.documentElement.scrollTop;
      results.innerHTML=message.html;renderId=message.renderId;document.getElementById('status').textContent=message.status;
      document.documentElement.scrollTop=scroll;
      if(id)Array.from(results.querySelectorAll('button')).find(button=>(wasPin?button.dataset.pinId:button.dataset.id)===id)?.focus({preventScroll:true});
    });
    vscode.postMessage({type:'ready'});
    </script></body></html>`;
  }

  dispose() {
    this.viewSubscriptions.forEach((subscription) => subscription.dispose());
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.view = undefined;
    this.displayed = [];
  }
}
