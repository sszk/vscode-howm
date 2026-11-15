const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
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
const config = {},
  active = new Emitter(),
  selection = new Emitter(),
  configuration = new Emitter();
const window = {
  onDidChangeActiveTextEditor: active.event,
  onDidChangeTextEditorSelection: selection.event,
};
const messages = [],
  opened = [];
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode")
    return {
      window: {
        ...window,
        showErrorMessage: (m) => messages.push(m),
        showInformationMessage: (m) => messages.push(m),
        get activeTextEditor() {
          return window.activeTextEditor;
        },
      },
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) => config[key] ?? fallback,
        }),
        onDidChangeConfiguration: configuration.event,
      },
      Uri: { parse: (uri) => ({ fsPath: uri.replace("file://", "") }) },
      Range: class {
        constructor(sl, sc, el, ec) {
          this.start = { line: sl, character: sc };
          this.end = { line: el, character: ec };
        }
      },
      Selection: class {
        constructor(anchor, active) {
          this.anchor = anchor;
          this.active = active;
        }
      },
    };
  if (name === "./navigation")
    return {
      openNote: async (store, note, line, preview, range) => {
        opened.push({ note, line, preview, range });
        return window.activeTextEditor;
      },
    };
  return original.call(this, name, ...args);
};
const { RelatedPassagesProvider } = require("../dist/related-passages");
Module._load = original;
const phrase =
  "TypeScript compiler configuration supports strict type checking and incremental builds.";
const text =
  "# Query\n" +
  phrase +
  "\n# Candidate <script>\n[2025-11-04]\n" +
  phrase +
  "\n# Gardening\nVegetables flowers gardening compost fertiliser for planting in the garden.";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  for (const key of Object.keys(config)) delete config[key];
  messages.length = opened.length = 0;
  const uri = "file:///notes/a.md",
    changed = new Emitter(),
    visible = new Emitter(),
    disposed = new Emitter();
  const posted = [];
  let receive,
    scans = 0;
  const store = {
    files: new Map([[uri, parseNotes(uri, text)]]),
    all() {
      return [...this.files.values()].flat();
    },
    contains: (u) => u.toString().startsWith("file:///notes/"),
    onChange: changed.event,
    initialize: async () => {
      scans++;
    },
  };
  window.activeTextEditor = {
    document: {
      languageId: "markdown",
      uri: { toString: () => uri },
      getText: () => store.files.get(uri)[0].source.text,
    },
    selection: { active: { line: 1 } },
  };
  const view = {
    visible: true,
    onDidChangeVisibility: visible.event,
    onDidDispose: disposed.event,
    webview: {
      html: "",
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return { dispose() {} };
      },
      postMessage: async (m) => posted.push(m),
    },
  };
  const provider = new RelatedPassagesProvider(store);
  provider.resolveWebviewView(view);
  await receive({ type: "ready" });
  await provider.update();
  return {
    provider,
    store,
    view,
    uri,
    changed,
    visible,
    disposed,
    posted,
    receive: (m) => receive(m),
    get scans() {
      return scans;
    },
    move: (line) => {
      window.activeTextEditor.selection = { active: { line } };
      selection.fire({ textEditor: window.activeTextEditor });
    },
    setText: (value) => {
      store.files.set(uri, parseNotes(uri, value));
      changed.fire();
    },
  };
}

test("related view renders title/date/line/excerpt, escapes HTML, and navigates using original range", async () => {
  const f = await fixture();
  try {
    assert.equal(f.provider.results.length, 1);
    const p = f.provider.results[0].passage;
    const last = f.posted.at(-1);
    assert.match(last.html, /Candidate &lt;script&gt;/);
    assert.match(last.html, /2025-11-04 · 5行目/);
    assert.match(last.html, /TypeScript compiler/);
    assert.match(f.view.webview.html, /default-src 'none'/);
    assert.match(f.view.webview.html, /-webkit-line-clamp:3/);
    await f.receive({ type: "open", id: p.id, renderId: "old" });
    assert.equal(opened.length, 0);
    await f.receive({ type: "open", id: p.id, renderId: last.renderId });
    assert.equal(opened[0].line, p.startLine);
    assert.equal(opened[0].range.end.line, p.endLine - 1);
    assert.equal(
      window.activeTextEditor.selection.active.line,
      p.startLine,
      "selection active end stays at passage start",
    );
    assert.equal(
      f.scans,
      0,
      "opening and searching never initiate a full scan",
    );
    const old = f.provider.results[0];
    f.store.files.set(f.uri, parseNotes(f.uri, "\nprefix\n" + text));
    await f.provider.open(old);
    assert.equal(
      opened.length,
      1,
      "obsolete row cannot jump after memo shifts",
    );
    assert.match(messages.at(-1), /変更/);
  } finally {
    f.provider.dispose();
  }
});

test("cursor-only changes debounce and identical search keys skip recalculation", async () => {
  const f = await fixture();
  try {
    let searches = 0;
    const search = f.provider.index.search.bind(f.provider.index);
    f.provider.index.search = (...args) => {
      searches++;
      return search(...args);
    };
    const generation = f.provider.generation;
    f.move(1);
    assert.equal(f.provider.generation, generation);
    f.move(6);
    assert.equal(searches, 0);
    await wait(100);
    assert.equal(searches, 0);
    f.move(4);
    await wait(530);
    assert.equal(searches, 1);
    assert.equal(f.provider.results[0].passage.note.title, "Query");
    f.move(3); // date-only cursor within same extracted text
    assert.equal(f.provider.timer, undefined);
  } finally {
    f.provider.dispose();
  }
});

test("unsaved edits and undo refresh results; manual mode, limits, disabled state and bounds apply", async () => {
  const f = await fixture();
  try {
    f.setText(
      text
        .replace(phrase, phrase)
        .replace(
          "# Candidate <script>\n[2025-11-04]\n" + phrase,
          "# Candidate\nvegetables flowers",
        ),
    );
    assert.equal(f.provider.results.length, 0, "rows invalidate immediately");
    assert.ok(f.provider.timer);
    await wait(530);
    assert.equal(f.provider.results.length, 0);
    f.setText(text);
    await wait(530);
    assert.equal(f.provider.results.length, 1);
    config["relatedPassages.autoRefresh"] = false;
    configuration.fire({
      affectsConfiguration: (k) => k === "howm.relatedPassages",
    });
    await f.provider.update();
    f.move(6);
    assert.equal(f.provider.timer, undefined);
    assert.match(f.posted.at(-1).status, /自動更新は無効/);
    f.move(1);
    await f.provider.refresh();
    assert.equal(f.provider.results.length, 1);
    config["relatedPassages.windowLines"] = 2;
    config["relatedPassages.windowStep"] = 99;
    assert.equal(f.provider.settings.windowStep, 2);
    config["relatedPassages.minSimilarity"] = -2;
    assert.equal(f.provider.settings.minSimilarity, 0);
    config["relatedPassages.minSimilarity"] = 2;
    await f.provider.update();
    assert.deepEqual(f.provider.results, []);
    config["relatedPassages.enabled"] = false;
    configuration.fire({
      affectsConfiguration: (k) => k === "howm.relatedPassages",
    });
    assert.equal(f.provider.index.notes.size, 0);
    assert.match(f.posted.at(-1).status, /無効/);
    assert.equal(f.scans, 0);
  } finally {
    f.provider.dispose();
  }
});

test("obsolete asynchronous results never render after cursor, corpus, settings or visibility changes", async () => {
  const f = await fixture();
  try {
    const previous = f.provider.results;
    let finish, started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    f.provider.index.search = () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const old = f.provider.update();
    await entered;
    f.move(6);
    finish(previous);
    await old;
    assert.equal(f.provider.results.length, 0);
    assert.ok(f.provider.timer);
    f.view.visible = false;
    f.visible.fire();
    assert.equal(f.provider.timer, undefined);
    const renders = f.posted.length;
    f.setText(text);
    f.move(1);
    await f.provider.refresh();
    await wait(530);
    assert.equal(f.posted.length, renders);
    assert.equal(f.scans, 0);
    let searches = 0;
    f.provider.index.search = async () => {
      searches++;
      return [];
    };
    f.view.visible = true;
    f.visible.fire();
    await wait(20);
    assert.equal(searches, 1, "re-show uses current cursor and index");
    f.disposed.fire();
    assert.equal(f.provider.timer, undefined);
  } finally {
    f.provider.dispose();
  }
});

test("non-Markdown files and code-only or short prose never start search", async () => {
  const f = await fixture();
  try {
    let searches = 0;
    f.provider.index.search = async () => {
      searches++;
      return [];
    };
    window.activeTextEditor.document.languageId = "plaintext";
    await f.provider.update();
    window.activeTextEditor.document.languageId = "markdown";
    f.setText("# Title\n```\n" + phrase + "\n```");
    await f.provider.update();
    assert.equal(searches, 0);
    assert.match(f.posted.at(-1).status, /十分な長さ/);
  } finally {
    f.provider.dispose();
  }
});

test("pending searches are invalidated by corpus, settings, editor switches and hiding the view", async () => {
  for (const cause of ["corpus", "settings", "editor", "hidden"]) {
    const f = await fixture();
    try {
      const stale = f.provider.results;
      let finish, entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      let first = true;
      f.provider.index.search = () => {
        if (!first) return Promise.resolve([]);
        first = false;
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      };
      const pending = f.provider.update();
      await started;
      if (cause === "corpus") f.setText(text + "\nExternal changes");
      if (cause === "settings") {
        config["relatedPassages.minSimilarity"] = 1;
        configuration.fire({
          affectsConfiguration: (key) => key === "howm.relatedPassages",
        });
      }
      if (cause === "editor") {
        window.activeTextEditor = undefined;
        active.fire();
      }
      if (cause === "hidden") {
        f.view.visible = false;
        f.visible.fire();
      }
      finish(stale);
      await pending;
      assert.deepEqual(f.provider.results, [], cause);
      assert.ok(f.provider.results !== stale, cause);
    } finally {
      f.provider.dispose();
    }
  }
});
