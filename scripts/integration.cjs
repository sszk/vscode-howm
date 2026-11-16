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
const windowsPaths = process.argv.includes("--windows-paths");
const urlPaste = process.argv.includes("--url-paste");
const localization = process.argv.includes("--l10n");
const locale =
  process.argv.find((arg) => arg.startsWith("--locale=")) || "--locale=en";
// A new profile has no language-pack cache yet. Seed it from the explicitly
// supplied test extensions so --locale takes effect on the first launch.
if (process.env.VSCODE_TEST_EXTENSIONS_DIR) {
  const languagePacks = {};
  const directory = path.resolve(process.env.VSCODE_TEST_EXTENSIONS_DIR);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(directory, entry.name, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const pack of manifest.contributes?.localizations || []) {
      languagePacks[pack.languageId] = {
        hash: require("node:crypto")
          .createHash("sha256")
          .update(JSON.stringify(pack) + manifest.version)
          .digest("hex"),
        translations: Object.fromEntries(
          pack.translations.map((item) => [
            item.id,
            path.resolve(directory, entry.name, item.path),
          ]),
        ),
      };
    }
  }
  fs.writeFileSync(
    path.join(user, "languagepacks.json"),
    JSON.stringify(languagePacks),
  );
}
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
  for (const file of ["package.nls.json", "package.nls.ja.json", "l10n"]) {
    fs.cpSync(
      path.resolve(__dirname, "..", file),
      path.join(developmentPath, file),
      { recursive: true },
    );
  }
  fs.cpSync(
    path.resolve(__dirname, "../dist"),
    path.join(developmentPath, "dist"),
    { recursive: true },
  );
  fs.symlinkSync(
    path.resolve(__dirname, "../node_modules"),
    path.join(developmentPath, "node_modules"),
    "junction",
  );
}
const child = spawn(
  exe,
  [
    "--new-window",
    locale,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--user-data-dir=${user}`,
    `--extensions-dir=${process.env.VSCODE_TEST_EXTENSIONS_DIR || path.join(user, "extensions")}`,
    `--extensionDevelopmentPath=${developmentPath}`,
    `--extensionTestsPath=${path.resolve(__dirname, localization ? "../test/localization-integration.cjs" : missingView ? "../test/view-registration.cjs" : windowsPaths ? "../test/windows-path-integration.cjs" : urlPaste ? "../test/url-paste-integration.cjs" : "../test/integration.cjs")}`,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      HOWM_TEST_LOCALE: locale.slice("--locale=".length),
    },
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
