const vscode = require("vscode");
const assert = require("node:assert/strict");
exports.run = async () => {
  const extension = vscode.extensions.getExtension("local-howm.markdown-howm");
  assert.ok(extension);
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    !commands.includes("howm.todos.focus"),
    "fixture must simulate an old workbench manifest",
  );
  assert.equal(
    await vscode.commands.executeCommand("howm.showTodos"),
    false,
    "missing view should offer window reload instead of trying to register it",
  );
  assert.equal(
    await vscode.commands.executeCommand("howm.showTodos"),
    false,
    "retry must be safe until the workbench is reloaded",
  );
  assert.ok(
    commands.includes("howm.reminders"),
    "the existing reminder picker should remain available",
  );
  assert.equal(
    await vscode.commands.executeCommand("howm.focusNotesSearch"),
    false,
    "an older tree manifest must give a reload hint for the search view",
  );
  console.log(
    "MISSING VIEW PASSED: new extension code with an old manifest activates safely and returns a reload hint",
  );
};
