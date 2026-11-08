const vscode = require("vscode");
const assert = require("node:assert/strict");
const titleModule = require("../dist/page-title");

const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
async function until(predicate, message) {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await pause();
  }
  assert.fail(message);
}

exports.run = async () => {
  const requests = [];
  titleModule.fetchPageTitle = (url, signal) =>
    new Promise((resolve) => requests.push({ url, signal, resolve }));
  const clipboard = await vscode.env.clipboard.readText();
  try {
    await vscode.extensions.getExtension("local-howm.markdown-howm").activate();
    const config = vscode.workspace.getConfiguration("howm");
    await config.update(
      "autoLinkOnPaste",
      true,
      vscode.ConfigurationTarget.Global,
    );
    async function editor(text = "", language = "markdown") {
      const doc = await vscode.workspace.openTextDocument({
        language,
        content: text,
      });
      return vscode.window.showTextDocument(doc);
    }
    async function paste(target, value = "https://example.com/資料") {
      await vscode.env.clipboard.writeText(value);
      await vscode.commands.executeCommand(
        "editor.action.clipboardPasteAction",
      );
      await pause();
      return target.document.getText();
    }
    let ed = await editor();
    const provisional = "[example.com](https://example.com/資料)";
    assert.equal(
      await paste(ed),
      provisional,
      "ordinary paste must prefer the howm link edit",
    );
    await until(() => requests.length === 1, "paste must trigger title fetch");
    requests.pop().resolve("日本語 [Title]");
    await until(
      () => ed.document.getText().includes("日本語"),
      "title must update asynchronously",
    );
    const completed = ed.document.getText();
    assert.equal(completed, "[日本語 \\[Title\\]](https://example.com/資料)");
    assert.equal(
      ed.selection.active.character,
      completed.length,
      "cursor remains after the link",
    );
    await vscode.commands.executeCommand("undo");
    assert.equal(ed.document.getText(), provisional);
    await vscode.commands.executeCommand("undo");
    assert.equal(ed.document.getText(), "");
    await vscode.commands.executeCommand("redo");
    assert.equal(ed.document.getText(), provisional);
    await vscode.commands.executeCommand("redo");
    assert.equal(ed.document.getText(), completed);

    ed = await editor("公式ドキュメント");
    ed.selection = new vscode.Selection(0, 0, 0, 8);
    assert.equal(
      await paste(ed),
      "[公式ドキュメント](https://example.com/資料)",
    );
    assert.equal(requests.length, 0, "selected labels must skip networking");

    for (const [input, expected] of [
      ["file:///tmp/report.pdf", "[report.pdf](file:///tmp/report.pdf)"],
      [
        " \nFILE:///C:/%E8%B3%87%E6%96%99/設計%20書.pdf\n ",
        "[設計 書.pdf](file:///C:/資料/設計%20書.pdf)",
      ],
      [
        "file://Server/share/a%5Bb%5D.txt",
        "[a\\[b\\].txt](file://Server/share/a%5Bb%5D.txt)",
      ],
    ]) {
      ed = await editor();
      assert.equal(
        await paste(ed, input),
        expected,
        "file URLs use their filename",
      );
      assert.equal(
        requests.length,
        0,
        "file URL paste must skip title fetching",
      );
      assert.equal(ed.selection.active.character, expected.length);
      await vscode.commands.executeCommand("undo");
      assert.equal(ed.document.getText(), "");
      await vscode.commands.executeCommand("redo");
      assert.equal(ed.document.getText(), expected);
    }
    ed = await editor("first\nsecond");
    ed.selections = [
      new vscode.Selection(0, 0, 0, 5),
      new vscode.Selection(1, 0, 1, 6),
    ];
    const fileLink = "[a.md](file:///tmp/a.md)";
    assert.equal(
      await paste(ed, "file:///tmp/a.md"),
      `${fileLink}\n${fileLink}`,
      "file names take precedence over selected text at every cursor",
    );
    assert.equal(requests.length, 0);

    for (const mode of ["edit", "delete", "undo"]) {
      ed = await editor();
      await paste(ed);
      await until(() => requests.length === 1, "pending title");
      const request = requests.pop();
      if (mode === "undo") await vscode.commands.executeCommand("undo");
      else
        await ed.edit((builder) =>
          builder.replace(
            mode === "delete"
              ? new vscode.Range(0, 0, 0, provisional.length)
              : new vscode.Range(0, 1, 0, 8),
            mode === "delete" ? "" : "edited",
          ),
        );
      const before = ed.document.getText();
      request.resolve("Should not replace");
      await pause();
      assert.equal(ed.document.getText(), before, mode);
    }

    ed = await editor("prefix\n\n");
    ed.selection = new vscode.Selection(1, 0, 1, 0);
    await paste(ed);
    await until(() => requests.length === 1, "shifted title");
    const shifted = requests.pop();
    await ed.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), "before\n"),
    );
    ed.selection = new vscode.Selection(0, 2, 0, 2);
    shifted.resolve("Shifted title");
    await until(
      () => ed.document.getText().includes("Shifted title"),
      "unrelated edits must preserve position tracking",
    );
    assert.equal(
      ed.document.lineAt(2).text,
      "[Shifted title](https://example.com/資料)",
    );
    assert.equal(ed.selection.active.character, 2);

    ed = await editor("\n");
    ed.selections = [
      new vscode.Selection(0, 0, 0, 0),
      new vscode.Selection(1, 0, 1, 0),
    ];
    assert.equal(await paste(ed), `${provisional}\n${provisional}`);
    await until(
      () => requests.length === 1,
      "multi cursor should share one request",
    );
    requests.pop().resolve("Multi");
    await until(
      () =>
        ed.document.getText() ===
        "[Multi](https://example.com/資料)\n[Multi](https://example.com/資料)",
      "multi-cursor titles",
    );
    assert.equal(ed.selections.length, 2);

    ed = await editor("first\nsecond");
    ed.selections = [
      new vscode.Selection(0, 0, 0, 5),
      new vscode.Selection(1, 0, 1, 6),
    ];
    assert.equal(
      await paste(ed),
      "[first](https://example.com/資料)\n[second](https://example.com/資料)",
    );
    assert.equal(requests.length, 0);

    ed = await editor("first\n");
    ed.selections = [
      new vscode.Selection(0, 0, 0, 5),
      new vscode.Selection(1, 0, 1, 0),
    ];
    assert.equal(
      await paste(ed),
      `[first](https://example.com/資料)\n${provisional}`,
    );
    await until(
      () => requests.length === 1,
      "mixed selections fetch only empty selections",
    );
    requests.pop().resolve("Mixed");
    await until(
      () => ed.document.lineAt(1).text === "[Mixed](https://example.com/資料)",
      "mixed title must be tracked",
    );
    assert.equal(
      ed.document.lineAt(0).text,
      "[first](https://example.com/資料)",
    );

    ed = await editor();
    await paste(ed);
    await until(() => requests.length === 1, "fallback title");
    requests.pop().resolve(undefined);
    await pause();
    assert.equal(
      ed.document.getText(),
      provisional,
      "fetch failures retain the hostname",
    );

    for (const [text, line, character] of [
      ["```\n\n```", 1, 0],
      ["`code`", 0, 2],
    ]) {
      for (const url of ["https://example.com/資料", "file:///tmp/a.md"]) {
        ed = await editor(text);
        ed.selection = new vscode.Selection(line, character, line, character);
        const offset = ed.document.offsetAt(ed.selection.active);
        assert.equal(
          await paste(ed, url),
          text.slice(0, offset) + url + text.slice(offset),
          "code must use native paste",
        );
        assert.equal(requests.length, 0);
      }
    }
    for (const value of [
      "https://example.com\nhttps://other.com",
      "[link](https://example.com)",
      "file:///tmp/a.md\nfile:///tmp/b.md",
      "file:///tmp/a%ZZ.md",
    ]) {
      ed = await editor();
      assert.equal(await paste(ed, value), value);
      assert.equal(requests.length, 0);
    }
    ed = await editor("```\ncode\n```\n");
    ed.selection = new vscode.Selection(3, 0, 3, 0);
    assert.equal(await paste(ed), `\`\`\`\ncode\n\`\`\`\n${provisional}`);
    await until(
      () => requests.length === 1,
      "paste immediately after a closing fence",
    );
    requests.pop().resolve(undefined);
    ed = await editor("", "plaintext");
    assert.equal(await paste(ed), "https://example.com/資料");
    ed = await editor("", "plaintext");
    assert.equal(await paste(ed, "file:///tmp/a.md"), "file:///tmp/a.md");
    ed = await editor();
    await paste(ed);
    await until(() => requests.length === 1, "pending title before disabling");
    const disabled = requests.pop();
    await config.update(
      "autoLinkOnPaste",
      false,
      vscode.ConfigurationTarget.Global,
    );
    disabled.resolve("Disabled");
    await pause();
    assert.equal(ed.document.getText(), provisional);
    ed = await editor();
    assert.equal(await paste(ed), "https://example.com/資料");
    ed = await editor();
    assert.equal(await paste(ed, "file:///tmp/a.md"), "file:///tmp/a.md");
    console.log(
      "URL PASTE PASSED: native HTTP(S)/file paste, filenames, title update, selections, protected edits/deletion/Undo, offset tracking, multi-cursor, code, exclusions, settings and Undo/Redo",
    );
  } finally {
    await vscode.env.clipboard.writeText(clipboard);
  }
};
