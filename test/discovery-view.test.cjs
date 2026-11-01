const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { parseNotes } = require("../dist/core");
const { LocalDayClock } = require("../dist/local-day");
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
  changedConfig = new Emitter(),
  active = new Emitter(),
  selection = new Emitter();
const window = {
  onDidChangeActiveTextEditor: active.event,
  onDidChangeTextEditorSelection: selection.event,
};
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode")
    return {
      EventEmitter: Emitter,
      TreeItem: class {
        constructor(label, collapsibleState) {
          this.label = label;
          this.collapsibleState = collapsibleState;
        }
      },
      TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1 },
      Uri: { parse: (value) => ({ fsPath: value }) },
      window,
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) => config[key] ?? fallback,
        }),
        onDidChangeConfiguration: changedConfig.event,
      },
    };
  return original.call(this, name, ...args);
};
const { OnThisDayProvider } = require("../dist/on-this-day");
const { SimilarNotesProvider } = require("../dist/similar-notes");
Module._load = original;

function fixture() {
  for (const key of Object.keys(config)) delete config[key];
  const change = new Emitter(),
    visibility = new Emitter();
  const uri = "file:///notes/test.md";
  const notes = parseNotes(
    uri,
    "# 台北旅行の計画\n[2025-11-01]\n台湾旅行のホテル予約\n# 台北旅行の計画\n[2023-11-01]\n台湾旅行のホテル予約について\n# Rust\n[2025-11-02]\ncompiler ownership borrowing\n",
  );
  const store = {
    files: new Map([[uri, notes]]),
    all() {
      return [...this.files.values()].flat();
    },
    root: {},
    onChange: change.event,
    contains: (u) => u.toString().startsWith("file:///notes/"),
    initialize: async () => {},
  };
  window.activeTextEditor = {
    document: { uri: { toString: () => uri } },
    selection: { active: { line: 0 } },
  };
  const view = { visible: true, onDidChangeVisibility: visibility.event };
  return { store, view, notes, change, visibility, uri };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("anniversary tree groups/counts notes, exposes the shared navigation command, refreshes dates and skips hidden rendering", async () => {
  const f = fixture();
  let today = "2026-11-01";
  const clock = new LocalDayClock(() => today);
  const provider = new OnThisDayProvider(f.store, clock, () => today);
  try {
    provider.attach(f.view);
    assert.deepEqual(
      provider.getChildren().map((g) => g.year),
      [2025, 2023],
    );
    const group = provider.getChildren()[1];
    const item = provider.getTreeItem(provider.getChildren(group)[0]);
    assert.equal(item.command.command, "howm.openDiscoveryNote");
    assert.equal(item.command.arguments[0].startLine, 3);
    assert.equal(provider.getTreeItem(group).label, "2023年（3年前）");
    today = "2026-11-02";
    clock.checkDate();
    assert.equal(provider.getChildren()[0].notes[0].title, "Rust");
    f.store.files.clear();
    f.change.fire();
    await wait(220);
    assert.match(f.view.message, /過去の今日のメモはありません/);
    config["onThisDay.enabled"] = false;
    changedConfig.fire({ affectsConfiguration: (k) => k === "howm.onThisDay" });
    assert.match(f.view.message, /無効/);
    assert.equal(clock.timer, undefined);
    f.view.visible = false;
    f.visibility.fire();
    let renders = 0;
    provider.onDidChangeTreeData(() => renders++);
    f.change.fire();
    await wait(220);
    assert.equal(renders, 0);
  } finally {
    provider.dispose();
    clock.dispose();
  }
});

test("similar tree follows cursor sections, debounces edits, respects settings and suppresses old calculations", async () => {
  const f = fixture();
  const provider = new SimilarNotesProvider(f.store);
  try {
    provider.attach(f.view);
    await provider.update();
    assert.deepEqual(provider.getChildren(), [f.notes[1]]);
    const item = provider.getTreeItem(f.notes[1]);
    assert.equal(item.description, "2023-11-01");
    assert.equal(item.command.command, "howm.openDiscoveryNote");
    window.activeTextEditor.selection.active.line = 3;
    selection.fire({ textEditor: window.activeTextEditor });
    await wait(20);
    assert.deepEqual(provider.getChildren(), [f.notes[0]]);
    const version = provider.generation;
    window.activeTextEditor.selection.active.line = 4;
    selection.fire({ textEditor: window.activeTextEditor });
    assert.equal(
      provider.generation,
      version,
      "movement inside a note does not recalculate",
    );
    const revised = parseNotes(
      f.uri,
      "# 台北旅行の計画\n[2025-11-01]\n台湾旅行のホテル予約\n# Rust\ncompiler ownership borrowing\n",
    );
    f.store.files.set(f.uri, revised);
    f.change.fire();
    assert.ok(provider.timer);
    await wait(530);
    assert.deepEqual(provider.getChildren(), []);
    f.store.files.set(f.uri, f.notes); // Undo.
    f.change.fire();
    await wait(530);
    assert.deepEqual(provider.getChildren(), [f.notes[0]]);
    config["similarNotes.minSimilarity"] = 1;
    changedConfig.fire({
      affectsConfiguration: (k) => k === "howm.similarNotes",
    });
    await wait(20);
    assert.deepEqual(provider.getChildren(), []);
    config["similarNotes.minSimilarity"] = 0.1;
    config["similarNotes.autoRefresh"] = false;
    changedConfig.fire({
      affectsConfiguration: (k) => k === "howm.similarNotes",
    });
    await wait(20);
    window.activeTextEditor.selection.active.line = 6;
    selection.fire({ textEditor: window.activeTextEditor });
    assert.match(f.view.message, /自動更新は無効/);
    await provider.refresh();
    assert.deepEqual(provider.getChildren(), []);
    config["similarNotes.autoRefresh"] = true;
    config["similarNotes.enabled"] = false;
    changedConfig.fire({
      affectsConfiguration: (k) => k === "howm.similarNotes",
    });
    assert.match(f.view.message, /類似メモは無効/);
    assert.equal(provider.index.documents.size, 0);
    config["similarNotes.enabled"] = true;
    const big = parseNotes(
      f.uri,
      "# TypeScript\n" + "TypeScript compiler ".repeat(30000),
    );
    f.store.files.set(f.uri, big);
    window.activeTextEditor.selection.active.line = 0;
    const old = provider.update();
    window.activeTextEditor = undefined;
    active.fire();
    await old;
    assert.deepEqual(provider.getChildren(), []);
    assert.match(f.view.message, /Markdown howm/);
    f.view.visible = false;
    f.visibility.fire();
    let renders = 0;
    provider.onDidChangeTreeData(() => renders++);
    f.change.fire();
    await wait(530);
    assert.equal(renders, 0);
  } finally {
    provider.dispose();
  }
});
