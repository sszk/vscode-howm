const vscode = require("vscode");
const assert = require("node:assert/strict");
const { Store } = require("../dist/storage");
const { parseNotes } = require("../dist/core");
const { openNote } = require("../dist/navigation");
const { completeReminder } = require("../dist/reminders");

exports.run = async () => {
  const store = new Store();
  try {
    const root = vscode.Uri.from({
      scheme: "file",
      path: "/C:/Users/Work/howm",
    });
    const indexed = vscode.Uri.joinPath(
      root,
      "2026",
      "10",
      "2026-10-13-000000.md",
    );
    const opened = vscode.Uri.parse(indexed.toString());
    store.root = root;
    console.log(
      "WINDOWS PATH REPRODUCTION:",
      JSON.stringify({
        root: root.path,
        indexed: indexed.path,
        opened: opened.path,
        accepted: store.contains(opened),
      }),
    );
    assert.equal(
      store.contains(opened),
      true,
      "a note URI serialized by the index must still belong to its Windows root",
    );
    for (const path of [
      "/C:/Users/Work/howm",
      "/D:/Users/Work/OneDrive - Organization/howm",
      "/C:/Users/職場/OneDrive/howm/",
      "/C:/Users/Work/howm///",
    ]) {
      store.root = vscode.Uri.from({ scheme: "file", path });
      const note = vscode.Uri.joinPath(
        store.root,
        "2026",
        "10",
        "日本語 #100%.MD",
      );
      assert.equal(store.contains(note), true);
      assert.equal(store.contains(vscode.Uri.parse(note.toString())), true);
    }
    store.root = root;
    for (const uri of [
      vscode.Uri.from({ scheme: "file", path: "/D:/Users/Work/howm/note.md" }),
      vscode.Uri.from({
        scheme: "file",
        path: "/C:/Users/Work/howm-other/note.md",
      }),
      vscode.Uri.from({ scheme: "file", path: "/C:/Users/Work/outside.md" }),
      vscode.Uri.joinPath(root, "note.txt"),
      vscode.Uri.from({ scheme: "howm", path: "/C:/Users/Work/howm/note.md" }),
    ])
      assert.equal(
        store.contains(uri),
        false,
        "other drives, sibling directories and schemes must stay outside",
      );
    store.root = vscode.Uri.from({
      scheme: "file",
      authority: "SERVER",
      path: "/Share/howm",
    });
    assert.equal(
      store.contains(
        vscode.Uri.parse(vscode.Uri.joinPath(store.root, "note.md").toString()),
      ),
      true,
      "UNC host serialization must not reject an indexed note",
    );
    assert.equal(
      store.contains(
        vscode.Uri.from({
          scheme: "file",
          authority: "OTHER",
          path: "/Share/howm/note.md",
        }),
      ),
      false,
    );
    store.root = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+SERVER",
      path: "/home/Work/howm",
    });
    assert.equal(
      store.contains(
        vscode.Uri.parse(vscode.Uri.joinPath(store.root, "note.md").toString()),
      ),
      true,
    );
    assert.equal(
      store.contains(
        vscode.Uri.from({
          scheme: "vscode-remote",
          authority: "ssh-remote+server",
          path: "/home/Work/HOWM/note.md",
        }),
      ),
      false,
      "case-sensitive remote directory paths must stay case-sensitive",
    );
    store.root = vscode.Uri.from({ scheme: "file", path: "/Users/Work/howm" });
    assert.equal(
      store.contains(vscode.Uri.joinPath(store.root, "note.md")),
      true,
    );
    assert.equal(
      store.contains(
        vscode.Uri.from({ scheme: "file", path: "/Users/Work/HOWM/note.md" }),
      ),
      false,
      "POSIX directory names must not be case-folded",
    );
    store.root = undefined;
    assert.equal(store.contains(opened), false);
    // Exercise real VS Code open/edit operations without a physical C: drive.
    const events = new vscode.EventEmitter();
    const virtualRoot = vscode.Uri.from({
      scheme: "howm-windows-test",
      path: "/C:/Users/Work/OneDrive/howm",
    });
    const virtualUri = vscode.Uri.parse(
      vscode.Uri.joinPath(virtualRoot, "note.md").toString(),
    );
    const text =
      "# First\n[2000-01-01]+ First\n# Second\n[2000-01-01]+ Second\n";
    const bytes = new TextEncoder().encode(text);
    let writes = 0;
    const provider = vscode.workspace.registerFileSystemProvider(
      "howm-windows-test",
      {
        onDidChangeFile: events.event,
        watch: () => new vscode.Disposable(() => {}),
        stat: async (uri) => ({
          type:
            uri.toString() === virtualUri.toString()
              ? vscode.FileType.File
              : vscode.FileType.Directory,
          ctime: 0,
          mtime: 0,
          size: bytes.length,
        }),
        readFile: async () => bytes,
        readDirectory: async () => [["note.md", vscode.FileType.File]],
        createDirectory: async () => {},
        writeFile: async () => {
          writes++;
        },
        rename: async () => {},
        delete: async () => {},
      },
    );
    try {
      store.root = virtualRoot;
      const notes = parseNotes(virtualUri.toString(), text);
      const editor = await openNote(store, notes[1]);
      assert.ok(
        editor,
        "opening must pass the Windows drive-letter containment check",
      );
      assert.equal(editor.selection.active.line, 2);
      const range = new vscode.Range(3, 14, 3, 20);
      await openNote(store, notes[1], 3, false, range);
      assert.equal(
        editor.document.getText(editor.selection),
        "Second",
        "search result navigation must select the matching part",
      );
      assert.equal(
        await completeReminder(store, notes[1], notes[1].reminders[0]),
        true,
        "Todo completion must pass the same Windows path check",
      );
      assert.ok(editor.document.isDirty);
      assert.equal(writes, 0, "completion must not save");
      await vscode.commands.executeCommand("undo");
      assert.equal(editor.document.getText(), text);
      assert.equal(
        store.noteCount,
        2,
        "dirty overlays must recognize the serialized Windows-shaped URI",
      );
    } finally {
      provider.dispose();
      events.dispose();
    }
    console.log(
      "WINDOWS PATH PASSED: URI round trips, local/OneDrive/UNC paths, boundary checks, case preservation, note/search navigation, Todo completion/Undo and dirty overlays",
    );
  } finally {
    store.dispose();
  }
};
