const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { parseNote, parseNotes, dateString } = require("../dist/core");
let weekStart = "sunday";
let configurationChanged;
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode")
    return {
      window: { showErrorMessage: () => {} },
      workspace: {
        getConfiguration: () => ({ get: () => weekStart }),
        onDidChangeConfiguration: (fn) => {
          configurationChanged = fn;
          return {
            dispose() {
              configurationChanged = undefined;
            },
          };
        },
      },
    };
  return original.call(this, name, ...args);
};
const { CalendarProvider } = require("../dist/calendar");
Module._load = original;

test("calendar view renders escaped content, navigates and opens only selected notes", async () => {
  const today = dateString();
  let changed, receive;
  let opened;
  const disposable = { dispose() {} };
  const note = parseNote(
    "file:///task.md",
    `# <script>title</script>\n[${today}]\n[${today}]+ <img src=x>\n`,
  );
  let notes = [note];
  const store = {
    root: {},
    all: () => notes,
    onChange: (fn) => {
      changed = fn;
      return disposable;
    },
    initialize: async () => {},
  };
  const view = {
    visible: false,
    webview: {
      html: "",
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return disposable;
      },
    },
    onDidChangeVisibility: () => disposable,
    onDidDispose: () => disposable,
  };
  const renderId = () => /style-src 'nonce-([^']+)'/.exec(view.webview.html)[1];
  const open = (id) => receive({ type: "open", id, renderId: renderId() });
  const provider = new CalendarProvider(store, async (n) => {
    opened = n;
  });
  try {
    provider.resolveWebviewView(view);
    assert.match(view.webview.html, /role="tooltip"/);
    assert.match(view.webview.html, /&lt;img src=x&gt;/);
    assert.ok(!view.webview.html.includes("<script>title</script>"));
    assert.match(view.webview.html, /default-src 'none'/);
    await open("outside");
    assert.equal(opened, undefined);
    await receive({ type: "select", date: today });
    await open(note.id);
    assert.equal(opened, note);
    const headers = () =>
      [...view.webview.html.matchAll(/class="weekday">([^<]+)</g)].map(
        (m) => m[1],
      );
    assert.deepEqual(headers(), ["日", "月", "火", "水", "木", "金", "土"]);
    await receive({ type: "select", date: `${today.slice(0, 7)}-01` });
    weekStart = "monday";
    configurationChanged({
      affectsConfiguration: (key) => key === "howm.calendarWeekStart",
    });
    assert.deepEqual(headers(), ["月", "火", "水", "木", "金", "土", "日"]);
    assert.ok(
      view.webview.html.includes(
        `data-date="${today.slice(0, 7)}-01" aria-pressed="true"`,
      ),
    );
    const grid = view.webview.html.slice(
      view.webview.html.indexOf('<div class="grid">'),
    );
    const blanks =
      grid
        .slice(0, grid.indexOf("data-date="))
        .match(/<span aria-hidden="true"><\/span>/g)?.length || 0;
    const firstWeekday = new Date(
      `${today.slice(0, 7)}-01T00:00:00Z`,
    ).getUTCDay();
    assert.equal(blanks, (firstWeekday - 1 + 7) % 7);
    weekStart = "sunday";
    configurationChanged({
      affectsConfiguration: (key) => key === "howm.calendarWeekStart",
    });
    assert.deepEqual(headers(), ["日", "月", "火", "水", "木", "金", "土"]);
    await receive({ type: "today" });
    const originalHtml = view.webview.html;
    await receive({ type: "month", delta: 1 });
    assert.notEqual(view.webview.html, originalHtml);
    opened = undefined;
    await open(note.id);
    assert.equal(opened, undefined);
    await receive({ type: "today" });
    assert.match(view.webview.html, /のメモ \(1\)/);
    // Two sections with identical titles and file URIs must remain separate.
    notes = parseNotes(note.uri, `# Same\n[${today}]\n# Same\n[${today}]\n`);
    changed();
    assert.match(view.webview.html, /のメモ \(2\)/);
    assert.equal([...view.webview.html.matchAll(/data-note-id=/g)].length, 2);
    await open(notes[1].id);
    assert.equal(opened, notes[1]);
    await open(notes[0].id);
    assert.equal(opened, notes[0]);
    opened = undefined;
    await receive({ type: "open", uri: note.uri });
    assert.equal(opened, undefined);
    const oldRenderId = renderId();
    const oldId = notes[0].id;
    notes = parseNotes(note.uri, `# Replacement\n[${today}]\n`);
    changed();
    await receive({ type: "open", id: oldId, renderId: oldRenderId });
    assert.equal(
      opened,
      undefined,
      "old markup must not open a replacement section with the same ID",
    );
    await open(notes[0].id);
    assert.equal(opened, notes[0]);
    notes = [];
    changed();
    assert.match(view.webview.html, /のメモ \(0\)/);
    assert.ok(!view.webview.html.includes('role="tooltip"'));
  } finally {
    provider.dispose();
  }
});
