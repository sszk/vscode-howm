const fs = require("node:fs/promises");
const path = require("node:path");
const { getL10nJson } = require("@vscode/l10n-dev");

const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const message = (value) => (typeof value === "string" ? value : value.message);
const placeholders = (text) =>
  [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).sort();

function compare(expected, actual, label, errors) {
  for (const key of Object.keys(expected)) {
    if (!(key in actual)) errors.push(`${label}: missing ${key}`);
    else if (
      typeof message(actual[key]) !== "string" ||
      !message(actual[key]).trim()
    )
      errors.push(`${label}: empty or invalid translation for ${key}`);
    else if (
      JSON.stringify(placeholders(message(expected[key]))) !==
      JSON.stringify(placeholders(message(actual[key])))
    )
      errors.push(`${label}: placeholder mismatch for ${key}`);
  }
  for (const key of Object.keys(actual))
    if (!(key in expected)) errors.push(`${label}: unused ${key}`);
}

async function check() {
  const errors = [];
  const files = (await fs.readdir("src", { recursive: true })).filter((file) =>
    file.endsWith(".ts"),
  );
  const extracted = await getL10nJson(
    await Promise.all(
      files.map(async (file) => ({
        contents: await fs.readFile(path.join("src", file), "utf8"),
        extension: ".ts",
      })),
    ),
  );
  const base = await read("l10n/bundle.l10n.json");
  compare(extracted, base, "English bundle (run npm run l10n:extract)", errors);
  const manifest = await read("package.json");
  const manifestKeys = {};
  function visit(value) {
    if (typeof value === "string" && /^%[^%]+%$/.test(value))
      manifestKeys[value.slice(1, -1)] = "";
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      Object.values(value).forEach(visit);
  }
  visit(manifest);
  const manifestBase = await read("package.nls.json");
  for (const key of Object.keys(manifestKeys))
    if (!(key in manifestBase)) errors.push(`package.nls.json: missing ${key}`);
  for (const key of Object.keys(manifestBase))
    if (!(key in manifestKeys)) errors.push(`package.nls.json: unused ${key}`);
  for (const file of await fs.readdir("l10n")) {
    if (/^bundle\.l10n\..+\.json$/.test(file))
      compare(base, await read(`l10n/${file}`), file, errors);
  }
  for (const file of await fs.readdir(".")) {
    if (/^package\.nls\..+\.json$/.test(file))
      compare(manifestBase, await read(file), file, errors);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `Localization OK: ${Object.keys(base).length} runtime messages, ${Object.keys(manifestBase).length} manifest strings`,
  );
}
check().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
