const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const vm = require("node:vm");
const { parseNotes, dateString } = require("../dist/core");
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
class Uri {
  constructor(value) {
    this.url = new URL(value);
  }
  static parse(value) {
    return new Uri(value);
  }
  get path() {
    return decodeURI(this.url.pathname);
  }
  get scheme() {
    return this.url.protocol.slice(0, -1);
  }
  get authority() {
    return this.url.host;
  }
  get fsPath() {
    return this.path;
  }
  with({ path }) {
    const copy = new Uri(this.toString());
    copy.url.pathname = path;
    return copy;
  }
  toString() {
    return this.url.href;
  }
}
class FileSystemError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const rename = new Emitter(),
  deleted = new Emitter(),
  active = new Emitter(),
  visible = new Emitter();
const opened = new Emitter(),
  closed = new Emitter(),
  configuration = new Emitter(),
  selection = new Emitter();
const contexts = new Map(),
  errors = [];
let stat = async () => ({});
const api = {
  Uri,
  EventEmitter: Emitter,
  FileSystemError,
  TreeItem: class {
    constructor(label) {
      this.label = label;
    }
  },
  Range: class {},
  commands: {
    executeCommand: async (command, key, value) => {
      if (command === "setContext") contexts.set(key, value);
    },
  },
  window: {
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: active.event,
    onDidChangeVisibleTextEditors: visible.event,
    onDidChangeTextEditorSelection: selection.event,
    onDidChangeWindowState: () => ({ dispose() {} }),
    showErrorMessage: (error) => errors.push(error),
  },
  workspace: {
    textDocuments: [],
    onDidRenameFiles: rename.event,
    onDidDeleteFiles: deleted.event,
    onDidOpenTextDocument: opened.event,
    onDidCloseTextDocument: closed.event,
    onDidChangeConfiguration: configuration.event,
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    fs: { stat: (...args) => stat(...args) },
  },
};
const original = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? api : original.call(this, name, ...args);
};
const { PinnedNotes, PINNED_NOTES_KEY } = require("../dist/pinned-notes");
const { PinCommands } = require("../dist/pin-commands");
const { NotesViewProvider } = require("../dist/notes-view");
const { CalendarProvider } = require("../dist/calendar");
const { SimilarNotesViewProvider } = require("../dist/similar-notes-view");
Module._load = original;
const u = (path) => Uri.parse(`file:///notes/${path}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(saved = []) {
  const changed = new Emitter(),
    watcherDelete = new Emitter();
  let value = saved,
    fail = false;
  const writes = [];
  const state = {
    get: (key) => {
      assert.equal(key, PINNED_NOTES_KEY);
      return value;
    },
    update: async (key, next) => {
      assert.equal(key, "howm.pinnedNotes");
      await wait(1);
      if (fail) {
        fail = false;
        throw new Error("write failed");
      }
      writes.push(next);
      value = next;
    },
  };
  const store = {
    root: Uri.parse("file:///notes"),
    files: new Map(),
    onChange: changed.event,
    onDidDeleteUri: watcherDelete.event,
    contains(uri) {
      return (
        uri.scheme === "file" &&
        uri.path.startsWith(this.root.path + "/") &&
        /\.md$/i.test(uri.path)
      );
    },
    all() {
      return [...this.files.values()].flat();
    },
    initialize: async () => {},
  };
  const pins = new PinnedNotes(state, store);
  return {
    pins,
    state,
    store,
    writes,
    watcherDelete,
    changed,
    failNext: () => {
      fail = true;
    },
    get saved() {
      return value;
    },
  };
}
function viewFixture() {
  const receive = new Emitter(),
    visibility = new Emitter(),
    dispose = new Emitter();
  const posted = [];
  let receiver,
    html = "",
    writes = 0;
  const view = {
    visible: false,
    onDidChangeVisibility: visibility.event,
    onDidDispose: dispose.event,
    webview: {
      onDidReceiveMessage(fn) {
        receiver = fn;
        return receive.event(fn);
      },
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
      get html() {
        return html;
      },
      set html(value) {
        html = value;
        writes++;
      },
    },
  };
  return {
    view,
    posted,
    visibility,
    receive: (message) => receiver(message),
    get writes() {
      return writes;
    },
  };
}
const latest = (v) =>
  v.posted.filter((message) => message.type === "results").at(-1);

// Execute the actual webview script: pointer clicks must release focus so an
// unpinned icon can hide after hover ends, while keyboard clicks retain focus.
function checkPinInteraction(html, id) {
  const listeners = new Map(),
    messages = [],
    attributes = new Map([["aria-pressed", "true"]]);
  let focused = true;
  const button = {
    dataset: { pinId: id },
    blur: () => {
      focused = false;
    },
    setAttribute: (key, value) => attributes.set(key, value),
  };
  const results = {
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const context = vm.createContext({
    acquireVsCodeApi: () => ({
      getState: () => ({}),
      postMessage: (message) => messages.push(message),
    }),
    document: {
      getElementById: () => results,
      querySelectorAll: (selector) =>
        selector === "button[data-pin-id]" ? [button] : [],
      addEventListener: (type, fn) => listeners.set(type, fn),
    },
    window: {
      addEventListener: (type, fn) => {
        const handlers = listeners.get(`window:${type}`) || [];
        handlers.push(fn);
        listeners.set(`window:${type}`, handlers);
      },
    },
  });
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
    vm.runInContext(script, context);
  for (const detail of [1, 0]) {
    focused = true;
    listeners.get("click")({
      detail,
      target: { closest: () => button },
      stopPropagation() {},
    });
    assert.equal(focused, detail === 0);
    assert.equal(messages.at(-1).type, "pin");
    assert.equal(messages.at(-1).id, id);
  }
  for (const ids of [[], [id], []]) {
    for (const handler of listeners.get("window:message"))
      handler({ data: { type: "pins", ids } });
    const pinned = ids.includes(id);
    assert.equal(attributes.get("aria-pressed"), String(pinned));
    assert.equal(
      attributes.get("aria-label"),
      pinned ? "ピン留めを解除" : "メモをピン留め",
    );
  }
}

test("pins persist distinct URI keys, restore after restart, and never accept non-howm files", async () => {
  const f = fixture();
  try {
    await f.pins.pin(u("a/same name.md"));
    await f.pins.pin(u("b/same name.md"));
    await f.pins.pin(u("a/same name.md"));
    await f.pins.pin(Uri.parse("file:///outside.md"));
    await f.pins.pin(u("image.png"));
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.saved, [
      u("a/same name.md").toString(),
      u("b/same name.md").toString(),
    ]);
    const restarted = new PinnedNotes(f.state, f.store);
    assert.ok(restarted.isPinned(u("a/same name.md")));
    assert.ok(restarted.isPinned(u("b/same name.md")));
    restarted.dispose();
    f.store.root = Uri.parse("file:///other");
    assert.equal(f.pins.isPinned(u("a/same name.md")), false);
    f.store.root = Uri.parse("file:///notes");
    assert.ok(f.pins.isPinned(u("a/same name.md")));
  } finally {
    f.pins.dispose();
  }
});

test("rapid operations serialize persistence and failed writes do not publish state or block later operations", async () => {
  const f = fixture();
  let events = 0;
  f.pins.onDidChangePinnedNotes(() => events++);
  try {
    await Promise.all([
      f.pins.togglePin(u("a.md")),
      f.pins.togglePin(u("b.md")),
      f.pins.togglePin(u("a.md")),
    ]);
    assert.deepEqual(f.saved, [u("b.md").toString()]);
    assert.equal(events, 3);
    f.failNext();
    await assert.rejects(f.pins.pin(u("a.md")), /write failed/);
    assert.equal(f.pins.isPinned(u("a.md")), false);
    assert.equal(events, 3);
    await f.pins.pin(u("a.md"));
    assert.equal(events, 4);
    assert.ok(f.pins.isPinned(u("a.md")));
  } finally {
    f.pins.dispose();
  }
});

test("renames transfer file/folder pins, moves outside remove them, and root moves retain keys", async () => {
  const f = fixture([
    u("dir/a.md").toString(),
    u("dir/b.md").toString(),
    u("keep.md").toString(),
  ]);
  try {
    await f.pins.rename([{ oldUri: u("dir"), newUri: u("renamed") }]);
    assert.ok(f.pins.isPinned(u("renamed/a.md")));
    assert.ok(f.pins.isPinned(u("renamed/b.md")));
    assert.equal(f.pins.isPinned(u("dir/a.md")), false);
    await f.pins.rename([
      { oldUri: u("renamed/a.md"), newUri: Uri.parse("file:///outside/a.md") },
    ]);
    assert.equal(f.saved.length, 2);
    await f.pins.rename([
      { oldUri: f.store.root, newUri: Uri.parse("file:///moved") },
    ]);
    f.store.root = Uri.parse("file:///moved");
    assert.ok(f.pins.isPinned(Uri.parse("file:///moved/renamed/b.md")));
    assert.ok(f.pins.isPinned(Uri.parse("file:///moved/keep.md")));
    await f.pins.remove([Uri.parse("file:///moved/renamed")]);
    assert.deepEqual(f.saved, ["file:///moved/keep.md"]);
  } finally {
    f.pins.dispose();
  }
});

test("watcher deletion cleans missing pins, preserves inaccessible roots, and tolerates rename/delete ordering", async () => {
  const f = fixture([u("a.md").toString(), u("dir/b.md").toString()]);
  try {
    // No eager startup pruning, even if every stat would fail.
    stat = async () => {
      throw new FileSystemError("FileNotFound");
    };
    await wait(5);
    assert.equal(f.writes.length, 0);
    f.watcherDelete.fire(u("a.md"));
    await wait(300);
    assert.ok(f.pins.isPinned(u("a.md")), "offline root must retain pins");
    stat = async (uri) => {
      if (uri.toString() !== f.store.root.toString())
        throw new FileSystemError("FileNotFound");
      return {};
    };
    f.watcherDelete.fire(u("a.md"));
    await wait(300);
    assert.equal(f.pins.isPinned(u("a.md")), false);
    f.watcherDelete.fire(u("dir"));
    rename.fire({ files: [{ oldUri: u("dir"), newUri: u("new") }] });
    await wait(300);
    assert.ok(f.pins.isPinned(u("new/b.md")));
    deleted.fire({ files: [u("new")] });
    await wait(10);
    assert.deepEqual(f.saved, []);
  } finally {
    stat = async () => ({});
    f.pins.dispose();
  }
});

test("commands honor explicit editor/tree URIs and publish resource-based contexts for split editors", async () => {
  const f = fixture(),
    commands = new Map();
  const a = u("a.md"),
    b = u("b.md"),
    outside = Uri.parse("file:///outside.md");
  api.window.activeTextEditor = { document: { uri: a } };
  api.window.visibleTextEditors = [
    { document: { uri: a } },
    { document: { uri: b } },
  ];
  api.workspace.textDocuments = [{ uri: a }, { uri: b }, { uri: outside }];
  const component = new PinCommands(f.store, f.pins, (name, fn) =>
    commands.set(name, fn),
  );
  try {
    await commands.get("pinNote")(b);
    assert.ok(f.pins.isPinned(b));
    assert.equal(f.pins.isPinned(a), false);
    assert.deepEqual(contexts.get("howm.noteResources"), [
      a.toString(),
      b.toString(),
    ]);
    assert.deepEqual(contexts.get("howm.pinnedNoteResources"), [b.toString()]);
    await commands.get("togglePin")();
    assert.ok(f.pins.isPinned(a));
    await commands.get("unpinNote")({ uri: b.toString() });
    await commands.get("pinNote")(outside);
    await commands.get("pinNote")({ invalid: true });
    assert.deepEqual(f.saved, [a.toString()]);
    api.window.activeTextEditor = { document: { uri: outside } };
    active.fire();
    await commands.get("togglePin")();
    assert.deepEqual(f.saved, [a.toString()]);
  } finally {
    component.dispose();
    f.pins.dispose();
    api.window.activeTextEditor = undefined;
    api.window.visibleTextEditors = [];
    api.workspace.textDocuments = [];
  }
});

test("shared pin operations reorder only the notes view, retain filters and patch calendar/similar icons without opening notes", async () => {
  const f = fixture(),
    today = dateString();
  const a = parseNotes(
    u("a.md").toString(),
    `# A\n[${today}]\nshared target\n`,
  )[0];
  const b = parseNotes(
    u("b.md").toString(),
    `# B\n[${today}]\nshared target\n`,
  )[0];
  const c = parseNotes(
    u("c.md").toString(),
    `# C\n[${today}]\nother text\n`,
  )[0];
  f.store.files = new Map([
    [a.uri, [a]],
    [b.uri, [b]],
    [c.uri, [c]],
  ]);
  const notes = viewFixture(),
    calendar = viewFixture(),
    similar = viewFixture();
  const opens = [];
  const n = new NotesViewProvider(
    f.store,
    async (note) => opens.push(note),
    f.pins,
  );
  const cal = new CalendarProvider(
    f.store,
    async (note) => opens.push(note),
    f.pins,
  );
  const sim = new SimilarNotesViewProvider(f.store, f.pins, async (note) =>
    opens.push(note),
  );
  api.window.activeTextEditor = {
    document: { uri: u("a.md") },
    selection: { active: { line: 0 } },
  };
  try {
    n.resolveWebviewView(notes.view);
    cal.resolveWebviewView(calendar.view);
    similar.view.visible = true;
    sim.resolveWebviewView(similar.view);
    await notes.receive({ type: "ready", query: "" });
    await similar.receive({ type: "ready" });
    await sim.refresh();
    const similarBefore = latest(similar);
    assert.match(similarBefore.html, />B</);
    const calendarHtml = calendar.view.webview.html;
    const calendarRenderId = /style-src 'nonce-([^']+)'/.exec(calendarHtml)[1];
    await calendar.receive({
      type: "pin",
      id: b.id,
      renderId: calendarRenderId,
    });
    assert.equal(opens.length, 0);
    const result = latest(notes);
    assert.ok(result.html.indexOf(">B<") < result.html.indexOf(">A<"));
    assert.equal(calendar.view.webview.html, calendarHtml);
    assert.equal(similar.posted.at(-1).type, "pins");
    assert.deepEqual(similar.posted.at(-1).ids, [b.id]);
    assert.equal(
      latest(similar),
      similarBefore,
      "pin must not recompute/reorder similarity",
    );
    assert.equal(calendar.posted.at(-1).type, "pins");
    await f.pins.pin(u("c.md"));
    assert.ok(
      latest(notes).html.indexOf(">B<") < latest(notes).html.indexOf(">C<"),
      "pinned group retains original ordering",
    );
    await notes.receive({ type: "search", query: "target" });
    assert.equal(latest(notes).count, "2行 · 2メモ");
    assert.ok(
      !latest(notes).html.includes(">C<"),
      "pin cannot bypass filtering",
    );
    await similar.receive({
      type: "pin",
      id: b.id,
      renderId: similarBefore.renderId,
    });
    assert.equal(opens.length, 0);
    assert.equal(f.pins.isPinned(u("b.md")), false);
    assert.ok(!calendar.posted.at(-1).ids.includes(b.id));
    assert.ok(!similar.posted.at(-1).ids.includes(b.id));
    assert.ok(
      latest(notes).html.indexOf(">A<") < latest(notes).html.indexOf(">B<"),
    );
    // Reject obsolete and fabricated targets from either webview.
    await calendar.receive({ type: "pin", id: a.id, renderId: "obsolete" });
    await similar.receive({
      type: "pin",
      id: "fabricated",
      renderId: similarBefore.renderId,
    });
    assert.equal(f.pins.isPinned(u("a.md")), false);
    const current = latest(notes);
    await notes.receive({
      type: "pin",
      id: JSON.stringify(["note", a.id]),
      query: "target",
      renderId: current.renderId,
    });
    assert.ok(f.pins.isPinned(u("a.md")));
    assert.equal(opens.length, 0);
    assert.equal(notes.writes, 1);
    assert.match(notes.view.webview.html, /\.pin\[aria-pressed="true"\]/);
    assert.match(notes.view.webview.html, /\.note-row:focus-within/);
    assert.match(latest(notes).html, /aria-label="ピン留めを解除"/);
    for (const v of [notes, calendar, similar]) {
      assert.match(v.view.webview.html, /default-src 'none'/);
      for (const [, script] of v.view.webview.html.matchAll(
        /<script[^>]*>([\s\S]*?)<\/script>/g,
      ))
        new vm.Script(script);
    }
    for (const v of [calendar, similar])
      checkPinInteraction(v.view.webview.html, b.id);
  } finally {
    n.dispose();
    cal.dispose();
    sim.dispose();
    f.pins.dispose();
    api.window.activeTextEditor = undefined;
  }
});
