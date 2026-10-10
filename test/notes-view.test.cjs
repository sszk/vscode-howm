const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const vm = require("node:vm");
const { parseNotes } = require("../dist/core");
class Emitter {
  listeners = new Set();
  event = (fn) => {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  };
  fire = (value) => {
    for (const fn of this.listeners) fn(value);
  };
  dispose = () => this.listeners.clear();
}
const messages = [];
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode")
    return {
      EventEmitter: Emitter,
      Range: class {
        constructor(sl, sc, el, ec) {
          this.start = { line: sl, character: sc };
          this.end = { line: el, character: ec };
        }
      },
      Uri: { parse: (value) => ({ fsPath: value.replace("file://", "") }) },
      window: {
        onDidChangeWindowState: () => ({ dispose() {} }),
        showErrorMessage: (message) => messages.push(message),
        showInformationMessage: (message) => messages.push(message),
      },
      commands: { executeCommand: async () => {} },
    };
  return original.call(this, name, ...args);
};
const { NotesViewProvider } = require("../dist/notes-view");
Module._load = original;

function fixture(notes) {
  const changed = new Emitter(),
    visible = new Emitter(),
    disposed = new Emitter();
  let receive,
    html = "",
    writes = 0,
    opened;
  const posted = [];
  const store = {
    root: { fsPath: "/notes" },
    all: () => notes,
    onChange: changed.event,
    initialize: async () => {},
  };
  const view = {
    visible: false,
    onDidChangeVisibility: visible.event,
    onDidDispose: disposed.event,
    webview: {
      get html() {
        return html;
      },
      set html(value) {
        html = value;
        writes++;
      },
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return { dispose() {} };
      },
    },
  };
  const provider = new NotesViewProvider(store, async (note, selection) => {
    opened = { note, selection };
  });
  provider.resolveWebviewView(view);
  return {
    provider,
    view,
    store,
    posted,
    changed,
    visible,
    disposed,
    receive: (message) => receive(message),
    setNotes: (value) => {
      notes = value;
    },
    get writes() {
      return writes;
    },
    get opened() {
      return opened;
    },
  };
}
const latest = (f) => f.posted.filter((m) => m.type === "results").at(-1);
const click = (f, result, id) =>
  f.receive({
    type: "open",
    query: result.query,
    renderId: result.renderId,
    id,
  });

test("notes view groups escaped matching rows, opens original ranges and retains its input document", async () => {
  const notes = parseNotes(
    "file:///notes.md",
    "Preamble target\n# <script>\n[2026-10-10]\nTarget & target\n# <script>\n[2026-10-11]\n😀 target <img>\n",
  );
  const f = fixture(notes);
  try {
    assert.match(f.view.webview.html, /type="search"/);
    assert.match(f.view.webview.html, /default-src 'none'/);
    await f.receive({ type: "ready", query: "target" });
    const result = latest(f);
    assert.equal(result.count, "2行 · 2メモ");
    assert.ok(!result.html.includes("Preamble"));
    assert.ok(!result.html.includes("<script>"));
    assert.match(result.html, /&lt;script&gt;/);
    assert.match(
      result.html,
      /<mark>Target<\/mark> &amp; <mark>target<\/mark>/,
    );
    assert.match(result.html, /&lt;img&gt;/);
    const id = JSON.stringify([notes[1].id, 6]);
    await click(f, result, id);
    assert.equal(f.opened.note, notes[1]);
    assert.deepEqual(f.opened.selection.start, { line: 6, character: 3 });
    assert.deepEqual(f.opened.selection.end, { line: 6, character: 9 });
    await f.receive({ type: "search", query: "" });
    assert.equal(latest(f).count, "2 / 2メモ");
    assert.ok(!latest(f).html.includes('class="match"'));
    await click(f, latest(f), JSON.stringify(["note", notes[0].id]));
    assert.equal(f.opened.note, notes[0]);
    assert.equal(f.opened.selection, undefined);
    await f.receive({ type: "search", query: "absent" });
    assert.match(latest(f).html, /一致する行がありません/);
    assert.equal(
      f.writes,
      1,
      "result updates must not rebuild the document containing the input",
    );
    assert.equal(await f.provider.focusSearch(), true);
    assert.equal(f.posted.at(-1).type, "focus");
  } finally {
    f.provider.dispose();
  }
});

test("notes view paginates matching lines, restores queries, and rejects obsolete result IDs", async () => {
  const notes = parseNotes(
    "file:///many.md",
    "# Many\n" +
      Array.from({ length: 450 }, (_, i) => `target ${i}`).join("\n"),
  );
  const f = fixture(notes);
  try {
    await f.receive({ type: "ready", query: "target" });
    let result = latest(f);
    assert.equal(result.count, "450行 · 1メモ（200行表示）");
    assert.equal((result.html.match(/class="match"/g) || []).length, 200);
    assert.equal(result.more, true);
    await f.receive({
      type: "more",
      query: result.query,
      renderId: result.renderId,
    });
    result = latest(f);
    assert.equal((result.html.match(/class="match"/g) || []).length, 400);
    await f.receive({
      type: "more",
      query: result.query,
      renderId: result.renderId,
    });
    result = latest(f);
    assert.equal(result.count, "450行 · 1メモ");
    assert.equal(result.more, false);
    const old = result;
    f.setNotes(parseNotes("file:///many.md", "# Replacement\ntarget\n"));
    f.changed.fire();
    await new Promise((resolve) => setTimeout(resolve, 230));
    await click(f, old, JSON.stringify([notes[0].id, 1]));
    assert.equal(f.opened, undefined);
    await click(f, latest(f), "unknown");
    assert.equal(f.opened, undefined);
    f.store.error = "Read failed";
    await f.receive({ type: "search", query: "new" });
    assert.match(latest(f).status, /Read failed/);
    delete f.store.error;
    f.store.loading = true;
    await f.receive({ type: "search", query: "new" });
    assert.equal(latest(f).status, "読み込み中…");
    f.store.loading = false;
    f.disposed.fire();
    f.provider.resolveWebviewView(f.view);
    await f.receive({ type: "ready", query: "target" });
    assert.equal(latest(f).query, "target");
    assert.equal(f.writes, 2);
  } finally {
    f.provider.dispose();
  }
});

test("browser input debounces IME, clears, restores state and keeps its caret during result updates", async () => {
  const f = fixture([]);
  const sent = [],
    timers = new Map();
  let nextTimer = 0,
    state = { query: "saved" };
  const listeners = new Map();
  const document = {
    activeElement: undefined,
    addEventListener(type, fn) {
      listeners.set("document:" + type, fn);
    },
    getElementById(id) {
      return elements[id];
    },
  };
  const element = () => ({
    value: "",
    disabled: false,
    hidden: false,
    dataset: {},
    listeners: new Map(),
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
    focus() {
      document.activeElement = this;
    },
    select() {
      this.selected = true;
    },
  });
  const elements = {
    query: element(),
    clear: element(),
    results: element(),
    main: element(),
    more: element(),
    count: element(),
    status: element(),
  };
  elements.results.contains = () => false;
  elements.results.querySelector = () => undefined;
  elements.results.querySelectorAll = () => [];
  elements.main.scrollTop = 40;
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(
    f.view.webview.html,
  )[1];
  try {
    vm.runInNewContext(script, {
      document,
      window: {
        addEventListener(type, fn) {
          listeners.set("window:" + type, fn);
        },
      },
      acquireVsCodeApi: () => ({
        getState: () => state,
        setState: (value) => {
          state = value;
        },
        postMessage: (message) => sent.push(message),
      }),
      setTimeout: (fn) => {
        timers.set(++nextTimer, fn);
        return nextTimer;
      },
      clearTimeout: (id) => timers.delete(id),
    });
    const input = elements.query;
    assert.equal(input.value, "saved");
    assert.equal(sent[0].type, "ready");
    input.focus();
    input.selectionStart = input.selectionEnd = 2;
    listeners.get("window:message")({
      data: {
        type: "results",
        query: "saved",
        html: "<p>Result</p>",
        renderId: "1",
        count: "1行",
        status: "",
        more: false,
        resetScroll: false,
      },
    });
    assert.equal(document.activeElement, input);
    assert.equal(input.selectionStart, 2);
    assert.equal(elements.main.scrollTop, 40);
    input.listeners.get("compositionstart")();
    input.value = "牛乳";
    input.listeners.get("input")();
    assert.equal(timers.size, 0);
    input.listeners.get("compositionend")();
    assert.equal(timers.size, 1);
    for (const fn of timers.values()) fn();
    timers.clear();
    assert.equal(sent.at(-1).query, "牛乳");
    const originalHtml = elements.results.innerHTML;
    listeners.get("window:message")({
      data: { type: "results", query: "saved", html: "old" },
    });
    assert.equal(
      elements.results.innerHTML,
      originalHtml,
      "outdated searches must not overwrite new results",
    );
    elements.clear.listeners.get("click")();
    assert.equal(input.value, "");
    assert.equal(sent.at(-1).query, "");
    input.value = "new";
    input.listeners.get("input")();
    listeners.get("document:keydown")({
      key: "Escape",
      target: input,
      preventDefault() {},
    });
    assert.equal(state.query, "");
    assert.equal(timers.size, 0);
    listeners.get("window:message")({ data: { type: "focus" } });
    assert.equal(document.activeElement, input);
    assert.equal(input.selected, true);
    let clicked;
    const match = element(),
      heading = element();
    match.click = () => {
      clicked = "match";
    };
    heading.click = () => {
      clicked = "heading";
    };
    elements.results.querySelector = (selector) =>
      selector === ".match" ? match : heading;
    listeners.get("document:keydown")({
      key: "ArrowDown",
      target: input,
      preventDefault() {},
    });
    assert.equal(document.activeElement, match);
    input.focus();
    listeners.get("document:keydown")({
      key: "Enter",
      target: input,
      preventDefault() {},
    });
    assert.equal(
      clicked,
      "match",
      "Enter should select a matched line ahead of the group heading",
    );
  } finally {
    f.provider.dispose();
  }
});
