const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const exe =
  process.env.VSCODE_EXECUTABLE ||
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
if (!fs.existsSync(exe)) {
  console.error("Set VSCODE_EXECUTABLE to the VS Code executable");
  process.exit(1);
}
const user = fs.mkdtempSync(path.join(os.tmpdir(), "howm-vscode-"));
const child = spawn(
  exe,
  [
    "--new-window",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--user-data-dir=${user}`,
    `--extensions-dir=${path.join(user, "extensions")}`,
    `--extensionDevelopmentPath=${path.resolve(__dirname, "..")}`,
    `--extensionTestsPath=${path.resolve(__dirname, "../test/integration.cjs")}`,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  },
);
const timer = setTimeout(() => {
  console.error("Integration test timed out");
  child.kill();
}, 60000);
child.on("exit", (code) => {
  clearTimeout(timer);
  fs.rmSync(user, { recursive: true, force: true });
  process.exit(code ?? 1);
});
