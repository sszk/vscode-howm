const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const window = {};
const clipboard = {};
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "vscode") return { window, env: { clipboard } };
  return original.call(this, name, ...args);
};
const { insertWindowsPathLink } = require("../dist/windows-path-link-command");
Module._load = original;

function fixture(selected = "", copied = String.raw`C:\資料\設計 書.pdf`) {
  const edits = [],
    errors = [];
  const state = { reads: 0, writable: true, duringRead: () => {} };
  const selection = {
    isEmpty: selected === "",
    isEqual: (other) => other === selection,
  };
  const document = {
    version: 1,
    getText: (range) => {
      assert.equal(range, selection);
      return selected;
    },
    save: () => assert.fail("must not save"),
  };
  const editor = {
    document,
    selection,
    edit: async (callback) => {
      callback({ replace: (range, text) => edits.push({ range, text }) });
      return state.writable;
    },
  };
  window.activeTextEditor = editor;
  window.showErrorMessage = (message) => errors.push(message);
  clipboard.readText = async () => {
    state.reads++;
    assert.equal(
      edits.length,
      0,
      "clipboard reads must not modify the document",
    );
    await state.duringRead();
    return copied;
  };
  return { editor, selection, document, edits, errors, state };
}

test("selected paths take precedence over the clipboard and replace the selected range", async () => {
  const f = fixture(String.raw`C:\資料\設計%20書.pdf`, "invalid clipboard");
  await insertWindowsPathLink();
  assert.equal(f.state.reads, 0);
  assert.deepEqual(f.edits, [
    {
      range: f.selection,
      text: "[設計%20書.pdf](file:///C:/資料/設計%2520書.pdf)",
    },
  ]);
  assert.deepEqual(f.errors, []);
});

test("an empty selection inserts the clipboard path at the captured cursor", async () => {
  const f = fixture();
  await insertWindowsPathLink();
  assert.equal(f.state.reads, 1);
  assert.deepEqual(f.edits, [
    {
      range: f.selection,
      text: "[設計 書.pdf](file:///C:/資料/設計%20書.pdf)",
    },
  ]);
  assert.deepEqual(f.errors, []);
});

test("invalid selected or copied text reports an error without editing or falling back", async () => {
  for (const [selected, copied] of [
    ["relative.txt", "C:/valid.txt"],
    [" ", "C:/valid.txt"],
    ["", ""],
    ["", "file:///C:/bad%ZZ.txt"],
  ]) {
    const f = fixture(selected, copied);
    await insertWindowsPathLink();
    assert.equal(f.edits.length, 0);
    assert.equal(f.errors.length, 1);
    assert.equal(f.state.reads, selected === "" ? 1 : 0);
  }
});

test("clipboard completion cannot edit after document, editor or cursor changes", async () => {
  for (const change of ["document", "editor", "selection"]) {
    const f = fixture();
    f.state.duringRead = () => {
      if (change === "document") f.document.version++;
      if (change === "editor") window.activeTextEditor = {};
      if (change === "selection") f.editor.selection = { isEqual: () => false };
    };
    await insertWindowsPathLink();
    assert.equal(f.edits.length, 0, change);
    assert.deepEqual(f.errors, []);
  }
});

test("missing editors skip clipboard access and failed edits are reported", async () => {
  const f = fixture();
  window.activeTextEditor = undefined;
  await insertWindowsPathLink();
  assert.equal(f.state.reads, 0);
  assert.equal(f.edits.length, 0);
  const readonly = fixture();
  readonly.state.writable = false;
  await insertWindowsPathLink();
  assert.equal(readonly.errors.length, 1);
  assert.match(readonly.errors[0], /リンクを挿入できませんでした/);
});

test("clipboard failures propagate to the extension's command error handler without editing", async () => {
  const f = fixture();
  f.state.duringRead = () => {
    throw new Error("clipboard unavailable");
  };
  await assert.rejects(insertWindowsPathLink(), /clipboard unavailable/);
  assert.equal(f.edits.length, 0);
});
