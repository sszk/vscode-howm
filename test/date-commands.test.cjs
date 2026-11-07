const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Exercise the registered commands with deterministic input and editor state.
// Real VS Code edit/undo behavior is covered by date-input-integration.cjs.
async function fixture(text = "# Note\n[2026-11-05]!7 deadline\n") {
  const commands = new Map(),
    errors = [],
    prompts = [];
  const noop = () => ({ dispose() {} });
  class Component {
    async initialize() {}
    contains() {
      return true;
    }
  }
  class Range {
    constructor(sl, sc, el, ec) {
      this.start = { line: sl, character: sc };
      this.end = { line: el, character: ec };
      this.active = this.end;
    }
  }
  const document = {
    version: 1,
    uri: { toString: () => "file:///notes/test.md" },
    getText: () => text,
    save: () => assert.fail("date commands must not save"),
  };
  const editor = {
    document,
    selections: [new Range(1, 0, 1, 0)],
    get selection() {
      return this.selections[0];
    },
    edits: 0,
    writable: true,
    async edit(fn) {
      this.edits++;
      const changes = [];
      fn({ replace: (range, value) => changes.push({ range, value }) });
      if (!this.writable) return false;
      const offset = (pos) =>
        text
          .split("\n")
          .slice(0, pos.line)
          .reduce((sum, line) => sum + line.length + 1, 0) + pos.character;
      for (const { range, value } of changes.sort(
        (a, b) => offset(b.range.start) - offset(a.range.start),
      )) {
        text =
          text.slice(0, offset(range.start)) +
          value +
          text.slice(offset(range.end));
      }
      document.version++;
      return true;
    },
  };
  const state = { response: "", duringInput: () => {} };
  const window = {
    activeTextEditor: editor,
    createOutputChannel: () => ({ appendLine: (s) => errors.push(s) }),
    registerWebviewViewProvider: noop,
    showErrorMessage: (s) => errors.push(s),
    showInputBox: async (options) => {
      prompts.push(options);
      await state.duringInput(options);
      return state.response;
    },
  };
  const api = {
    window,
    Range,
    commands: {
      registerCommand: (name, handler) => {
        commands.set(name, handler);
        return noop();
      },
      getCommands: async () => [],
    },
    workspace: {
      registerTextDocumentContentProvider: noop,
      onDidCloseTextDocument: noop,
      onDidChangeConfiguration: noop,
    },
    languages: {
      registerDocumentLinkProvider: noop,
      registerCompletionItemProvider: noop,
    },
  };
  const extensionPath = path.resolve(__dirname, "../dist/extension.js");
  const realRequire = createRequire(extensionPath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(extensionPath, "utf8"), {
    exports: module.exports,
    Date: class extends Date {
      constructor() {
        super(2026, 10, 5, 12);
      }
    },
    require: (name) => {
      if (name === "vscode") return api;
      if (name === "./url-paste") return { registerUrlPaste() {} };
      if (name === "./core" || name === "./date-input")
        return realRequire(name);
      return new Proxy({}, { get: () => Component });
    },
  });
  await module.exports.activate({
    subscriptions: [],
    extension: {
      packageJSON: {
        contributes: {
          views: { howm: [{ id: "howm.notes", type: "webview" }] },
        },
      },
    },
  });
  return {
    editor,
    document,
    window,
    state,
    prompts,
    errors,
    Range,
    run: (name) => commands.get(`howm.${name}`)(),
  };
}

test("date input replaces every selection in one edit with a shared validated date", async () => {
  const f = await fixture("# Note\nreplace\ninsert here\n");
  f.editor.selections = [new f.Range(1, 0, 1, 7), new f.Range(2, 7, 2, 7)];
  f.state.response = "+7";
  f.state.duringInput = (options) => {
    assert.equal(f.editor.edits, 0);
    assert.ok(options.validateInput("2/30"));
    assert.equal(options.validateInput("+7"), undefined);
  };
  await f.run("inputDate");
  assert.equal(
    f.document.getText(),
    "# Note\n[2026-11-12]\ninsert [2026-11-12]here\n",
  );
  assert.equal(f.editor.edits, 1);
  assert.equal(f.prompts[0].prompt, "日付を入力");
  assert.deepEqual(f.errors, []);
});

test("date changes share input rules and preserve reminder details and history", async () => {
  const text = "# Note\n[2026-11-05]. [2026-10-15]:!7 deadline\n";
  for (const [input, date] of [
    ["+7", "2026-11-12"],
    ["3", "2026-12-03"],
    ["", "2026-11-05"],
    ["2025/1/1", "2025-01-01"],
  ]) {
    const f = await fixture(text);
    f.state.response = input;
    await f.run("changeDate");
    assert.equal(f.prompts[0].value, "2026-11-05");
    assert.equal(
      f.document.getText(),
      `# Note\n[${date}]. [2026-10-15]:!7 deadline\n`,
    );
    assert.deepEqual(f.errors, []);
  }
});

test("cancellation, invalid input, switched editors and intervening edits never apply a date", async () => {
  for (const command of ["inputDate", "changeDate"]) {
    for (const scenario of ["cancel", "invalid", "switch", "edit"]) {
      const f = await fixture();
      f.state.response =
        scenario === "cancel"
          ? undefined
          : scenario === "invalid"
            ? "2026/2/29"
            : "+7";
      f.state.duringInput = () => {
        if (scenario === "switch") f.window.activeTextEditor = {};
        if (scenario === "edit") f.document.version++;
      };
      await f.run(command);
      assert.equal(f.editor.edits, 0, `${command}: ${scenario}`);
    }
  }
});

test("missing editors and lines without dates skip the prompt; failed edits are reported", async () => {
  for (const command of ["inputDate", "changeDate"]) {
    const f = await fixture();
    f.window.activeTextEditor = undefined;
    await f.run(command);
    assert.equal(f.prompts.length, 0);
    const readonly = await fixture();
    readonly.editor.writable = false;
    await readonly.run(command);
    assert.equal(readonly.errors.length, 1);
    assert.equal(
      readonly.document.getText(),
      "# Note\n[2026-11-05]!7 deadline\n",
    );
  }
  const f = await fixture("# Note\nno date\n");
  await f.run("changeDate");
  assert.equal(f.prompts.length, 0);
});
