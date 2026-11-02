const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { parseNote } = require("../dist/core");

class Emitter {
  listeners = new Set();
  event = (fn) => {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  };
  fire(value) {
    for (const fn of this.listeners) fn(value);
  }
  dispose() {
    this.listeners.clear();
  }
}
const configurationChanged = new Emitter();
let dueSoonDays = 3;
const registered = new Set();
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode")
    return {
      EventEmitter: Emitter,
      TreeItem: class {
        constructor(label) {
          this.label = label;
        }
      },
      TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1 },
      ThemeColor: class {
        constructor(id) {
          this.id = id;
        }
      },
      ThemeIcon: class {
        constructor(id, color) {
          this.id = id;
          this.color = color;
        }
      },
      Uri: {
        from: ({ scheme, path }) => ({
          scheme,
          toString: () => `${scheme}:${encodeURIComponent(path)}`,
        }),
        parse: (value) => ({ fsPath: value, toString: () => value }),
      },
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) =>
            key === "todos.dueSoonDays" ? dueSoonDays : fallback,
        }),
        onDidChangeConfiguration: configurationChanged.event,
      },
      window: {
        registerFileDecorationProvider(provider) {
          registered.add(provider);
          return { dispose: () => registered.delete(provider) };
        },
      },
    };
  return original.call(this, name, ...args);
};
const { TodoProvider } = require("../dist/todos");
Module._load = original;

test("Todo labels and icons update on settings, midnight and edits without coloring the source file", () => {
  let today = "2026-10-10";
  let notes = [
    parseNote(
      "file:///notes/a.md",
      "# A\n[2026-10-14]!1 Later\n[2026-10-09]! Overdue\n[2026-10-10]! Due\n[2026-10-10]@ Today\n[2026-10-11]@ Tomorrow\n[2026-10-09]+ Started\n[2026-10-10]. Done\n",
    ),
  ];
  const storeChanges = new Emitter();
  let scans = 0;
  const store = {
    all: () => notes,
    onChange: storeChanges.event,
    initialize: async () => scans++,
  };
  const provider = new TodoProvider(store, () => today);
  const entries = () => provider.getChildren().flatMap((g) => g.entries);
  const item = (text) =>
    provider.getTreeItem(entries().find((e) => e.reminder.text === text));
  const color = (text) => {
    const row = item(text);
    const decoration = provider.provideFileDecoration(row.resourceUri);
    assert.equal(row.iconPath.color?.id, decoration?.color.id);
    return decoration?.color.id;
  };
  let treeUpdates = 0;
  let decorationUpdates = 0;
  provider.onDidChangeTreeData(() => treeUpdates++);
  provider.onDidChangeFileDecorations(() => decorationUpdates++);
  try {
    assert.ok(registered.has(provider));
    assert.equal(color("Later"), undefined);
    assert.equal(color("Overdue"), "howm.todoOverdueForeground");
    assert.equal(color("Due"), "howm.todoDueSoonForeground");
    assert.equal(color("Today"), "howm.scheduleTodayForeground");
    assert.equal(color("Tomorrow"), undefined);
    assert.equal(color("Started"), undefined);
    assert.ok(!entries().some((e) => e.reminder.text === "Done"));
    assert.equal(item("Overdue").iconPath.id, "warning");
    assert.equal(item("Today").iconPath.id, "calendar");
    assert.equal(item("Today").command.command, "howm.openReminder");
    const resources = entries().map((e) => provider.getTreeItem(e).resourceUri);
    assert.equal(
      new Set(resources.map((u) => u.toString())).size,
      resources.length,
    );
    assert.ok(resources.every((u) => u.scheme === "howm-todo"));
    assert.equal(
      provider.provideFileDecoration({ toString: () => notes[0].uri }),
      undefined,
    );
    assert.equal(
      provider.getTreeItem(provider.getChildren()[0]).resourceUri,
      undefined,
    );

    dueSoonDays = 4;
    configurationChanged.fire({ affectsConfiguration: () => false });
    assert.equal(color("Later"), undefined);
    configurationChanged.fire({
      affectsConfiguration: (key) => key === "howm.todos.dueSoonDays",
    });
    assert.equal(color("Later"), "howm.todoDueSoonForeground");
    assert.equal(scans, 0);
    assert.equal(treeUpdates, 1);
    assert.equal(decorationUpdates, 1);

    today = "2026-10-11";
    provider.checkDate();
    assert.equal(color("Due"), "howm.todoOverdueForeground");
    assert.equal(color("Today"), undefined);
    assert.equal(color("Tomorrow"), "howm.scheduleTodayForeground");
    assert.equal(treeUpdates, 2);
    assert.equal(decorationUpdates, 2);
    provider.checkDate();
    assert.equal(treeUpdates, 2);

    notes = [parseNote("file:///notes/a.md", "# A\n[2026-10-10]. Completed")];
    provider.update();
    assert.deepEqual(provider.getChildren(), []);
    for (const resource of resources)
      assert.equal(provider.provideFileDecoration(resource), undefined);
    assert.equal(decorationUpdates, 3);
  } finally {
    provider.dispose();
    dueSoonDays = 3;
  }
  assert.equal(registered.size, 0);
  assert.equal(configurationChanged.listeners.size, 0);
  assert.equal(storeChanges.listeners.size, 0);
});
