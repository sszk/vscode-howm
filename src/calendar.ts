import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { Store } from "./storage";
import { Note, dateString, dayNumber } from "./core";
import { CalendarWeekStart, calendarDays, monthDates } from "./calendar-model";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

export class CalendarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private today = dateString();
  private month = this.today.slice(0, 7);
  private selected = this.today;

  constructor(
    private store: Store,
    private open: (note: Note) => Promise<unknown>,
  ) {
    this.subscriptions.push(
      store.onChange(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("howm.calendarWeekStart")) this.render();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.subscriptions.push(
      view.webview.onDidReceiveMessage(async (message) => {
        try {
          if (
            message?.type === "select" &&
            typeof message.date === "string" &&
            message.date.startsWith(`${this.month}-`) &&
            Number.isFinite(dayNumber(message.date))
          ) {
            this.selected = message.date;
            this.render();
          } else if (
            message?.type === "month" &&
            (message.delta === -1 || message.delta === 1)
          ) {
            const date = new Date(dayNumber(`${this.month}-01`) * 86400000);
            date.setUTCMonth(date.getUTCMonth() + message.delta);
            const year = date.getUTCFullYear();
            if (year < 1 || year > 9999) return;
            this.month = `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
            this.selected = `${this.month}-01`;
            this.render();
          } else if (message?.type === "today") {
            this.today = dateString();
            this.selected = this.today;
            this.month = this.today.slice(0, 7);
            this.render();
          } else if (
            message?.type === "open" &&
            typeof message.uri === "string"
          ) {
            const note = calendarDays(this.store.all())
              .get(this.selected)
              ?.notes.find((n) => n.uri === message.uri);
            if (note) await this.open(note);
          }
        } catch (error) {
          void vscode.window.showErrorMessage(`howm: ${String(error)}`);
        }
      }),
      view.onDidChangeVisibility(() => {
        this.updateTimer();
        if (view.visible)
          void this.store.initialize().catch(() => this.render());
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.updateTimer();
      }),
    );
    this.updateTimer();
    this.render();
    void this.store.initialize().catch(() => this.render());
  }

  private updateTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.view?.visible)
      this.timer = setInterval(() => {
        const today = dateString();
        if (today !== this.today) {
          this.today = today;
          this.render();
        }
      }, 60000);
  }

  private render() {
    if (!this.view) return;
    const weekStart: CalendarWeekStart =
      vscode.workspace
        .getConfiguration("howm")
        .get<string>("calendarWeekStart", "sunday") === "monday"
        ? "monday"
        : "sunday";
    const weekdays =
      weekStart === "monday"
        ? ["月", "火", "水", "木", "金", "土", "日"]
        : ["日", "月", "火", "水", "木", "金", "土"];
    const days = calendarDays(this.store.all());
    const nonce = randomBytes(16).toString("hex");
    const cells = monthDates(this.month, weekStart)
      .map((date) => {
        if (!date) return '<span aria-hidden="true"></span>';
        const day = days.get(date);
        const tooltip = day?.reminders
          .map(
            ({ note, reminder }) =>
              `${reminder.kind} ${reminder.text || "本文なし"} — ${note.title}`,
          )
          .join("\n");
        return `<button class="day ${day?.reminders.length ? "todo" : ""} ${date === this.today ? "today" : ""} ${date === this.selected ? "selected" : ""}"
        data-date="${date}" aria-pressed="${date === this.selected}" aria-label="${date}${tooltip ? `: ${escape(tooltip)}` : ""}" ${tooltip ? `aria-describedby="tip-${date}"` : ""}>
        ${Number(date.slice(-2))}<span class="dot">${day?.notes.length ? "•" : "&nbsp;"}</span>
        ${tooltip ? `<span role="tooltip" id="tip-${date}" class="tooltip">${escape(tooltip)}</span>` : ""}</button>`;
      })
      .join("");
    const notes = days.get(this.selected)?.notes || [];
    const status =
      this.store.error ||
      (this.store.loading
        ? "読み込み中…"
        : !this.store.root
          ? "メモの保存先を選択してください。"
          : "");
    this.view.webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <style nonce="${nonce}">
      body{padding:10px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
      button{font:inherit;color:inherit;background:transparent;border:1px solid transparent;cursor:pointer;border-radius:3px}
      button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}
      header{display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:12px}
      .grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;text-align:center}
      .weekday{font-size:11px;color:var(--vscode-descriptionForeground)}
      .day{position:relative;padding:5px 0;min-width:0}.dot{display:block;font-size:10px;line-height:10px}
      .todo{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
      .today{border-color:var(--vscode-focusBorder)}.selected{outline:2px solid var(--vscode-focusBorder);outline-offset:0}
      .tooltip{display:none;position:absolute;z-index:10;top:100%;left:0;width:max-content;max-width:200px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground);border:1px solid var(--vscode-editorHoverWidget-border);box-shadow:0 2px 8px var(--vscode-widget-shadow);pointer-events:none}
      .day:nth-child(7n+5) .tooltip,.day:nth-child(7n+6) .tooltip,.day:nth-child(7n) .tooltip{left:auto;right:0}
      .day:hover .tooltip,.day:focus-visible .tooltip{display:block}
      h2{font-size:inherit;margin:18px 0 8px}.note{display:block;text-align:left;width:100%;padding:6px;overflow-wrap:anywhere}.note:hover{background:var(--vscode-list-hoverBackground)}
      p{color:var(--vscode-descriptionForeground)}
      </style></head><body>
      <header><button data-delta="-1" aria-label="前月">‹</button><strong>${this.month.replace("-", "年")}月</strong><button data-delta="1" aria-label="翌月">›</button><button id="today">今日</button></header>
      <div class="grid">${weekdays.map((d) => `<span class="weekday">${d}</span>`).join("")}${cells}</div>
      <p>● メモあり · 反転：未完了のTodo・予定</p>
      ${status ? `<p role="status">${escape(status)}</p>` : ""}
      <h2>${this.selected} のメモ (${notes.length})</h2>
      ${notes.length ? notes.map((note) => `<button class="note" data-uri="${escape(note.uri)}">${escape(note.title)}</button>`).join("") : "<p>該当するメモはありません。</p>"}
      <script nonce="${nonce}">
      const vscode=acquireVsCodeApi();
      const state=vscode.getState();
      if(state?.focus){
        const button=Array.from(document.querySelectorAll('button')).find(b=>b.dataset.date===state.focus);
        button?.focus({preventScroll:true});
        vscode.setState({});
      }
      document.addEventListener('keydown',event=>{
        if(event.key==='Escape')document.querySelectorAll('.tooltip').forEach(t=>t.style.display='none');
      });
      document.addEventListener('focusin',()=>document.querySelectorAll('.tooltip').forEach(t=>t.style.display=''));
      document.addEventListener('mouseover',()=>document.querySelectorAll('.tooltip').forEach(t=>t.style.display=''));
      document.addEventListener('click',event=>{
        const button=event.target.closest('button');if(!button)return;
        if(button.dataset.date){vscode.setState({focus:button.dataset.date});vscode.postMessage({type:'select',date:button.dataset.date});}
        else if(button.dataset.delta)vscode.postMessage({type:'month',delta:Number(button.dataset.delta)});
        else if(button.dataset.uri)vscode.postMessage({type:'open',uri:button.dataset.uri});
        else if(button.id==='today')vscode.postMessage({type:'today'});
      });
      </script></body></html>`;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}
