const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { parseNote, dateString } = require("../dist/core");
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
  const provider = new CalendarProvider(store, async (n) => {
    opened = n;
  });
  try {
    provider.resolveWebviewView(view);
    assert.match(view.webview.html, /role="tooltip"/);
    assert.match(view.webview.html, /&lt;img src=x&gt;/);
    assert.ok(!view.webview.html.includes("<script>title</script>"));
    assert.match(view.webview.html, /default-src 'none'/);
    await receive({ type: "open", uri: "file:///outside.md" });
    assert.equal(opened, undefined);
    await receive({ type: "select", date: today });
    await receive({ type: "open", uri: note.uri });
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
    await receive({ type: "open", uri: note.uri });
    assert.equal(opened, undefined);
    await receive({ type: "today" });
    assert.match(view.webview.html, /のメモ \(1\)/);
    notes = [];
    changed();
    assert.match(view.webview.html, /のメモ \(0\)/);
    assert.ok(!view.webview.html.includes('role="tooltip"'));
  } finally {
    provider.dispose();
  }
});
