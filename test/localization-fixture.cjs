const japanese = require("../l10n/bundle.l10n.ja.json");

// Model the extension host's bundle lookup and positional substitutions.
function localization(language = "ja") {
  const env = { language };
  return {
    env,
    l10n: {
      t(message, ...args) {
        const text =
          env.language.split("-")[0] === "ja"
            ? (japanese[message] ?? message)
            : message;
        return text.replace(/\{(\d+)\}/g, (match, index) =>
          index < args.length ? String(args[index]) : match,
        );
      },
    },
  };
}
module.exports = { localization };
