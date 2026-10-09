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
const missingView = process.argv.includes("--missing-view");
let developmentPath = path.resolve(__dirname, "..");
if (missingView) {
  developmentPath = path.join(user, "old-manifest");
  fs.mkdirSync(developmentPath);
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
  );
  manifest.contributes.views = {
    explorer: [{ id: "howm.notes", name: "howm" }],
  };
  delete manifest.contributes.viewsContainers;
  fs.writeFileSync(
    path.join(developmentPath, "package.json"),
    JSON.stringify(manifest),
  );
  fs.cpSync(
    path.resolve(__dirname, "../dist"),
    path.join(developmentPath, "dist"),
    { recursive: true },
  );
}
const child = spawn(
  exe,
  [
    "--new-window",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--user-data-dir=${user}`,
    `--extensions-dir=${path.join(user, "extensions")}`,
    `--extensionDevelopmentPath=${developmentPath}`,
    `--extensionTestsPath=${path.resolve(__dirname, missingView ? "../test/view-registration.cjs" : "../test/integration.cjs")}`,
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
