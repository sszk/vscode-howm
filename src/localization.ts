import * as vscode from "vscode";

// These model values are also used by workers and remain locale independent.
export function modelText(value: string): string {
  switch (value) {
    case "メモ内の日付":
      return vscode.l10n.t("Date in note");
    case "ファイル名の日付":
      return vscode.l10n.t("Date in filename");
    case "更新日":
      return vscode.l10n.t("Modified date");
    case "Todo（優先度順）":
      return vscode.l10n.t("Todos (by Priority)");
    case "これからの予定・締切":
      return vscode.l10n.t("Upcoming Events and Deadlines");
    case "開始前のTodo・過去の予定":
      return vscode.l10n.t("Future Todos and Past Events");
    case "対象のMarkdownメモがありません。保存先を確認してください。":
      return vscode.l10n.t("No Markdown notes. Check the notes folder.");
    case "リマインダがありません。本文に [YYYY-MM-DD]+ 内容 を記述してください（コードブロック内は対象外）。":
      return vscode.l10n.t(
        "No reminders. Add [YYYY-MM-DD]+ text to a note outside code blocks.",
      );
    case "リマインダはすべて完了済みです。":
      return vscode.l10n.t("All reminders are complete.");
    case "表示するリマインダがありません。":
      return vscode.l10n.t("No reminders to display.");
    case "正規表現は256文字以内にしてください":
      return vscode.l10n.t(
        "Regular expressions must be 256 characters or fewer",
      );
    case "正規表現検索が時間制限（2秒）を超えました":
      return vscode.l10n.t(
        "Regular expression search exceeded the time limit (2 seconds)",
      );
    case "ファイル名は保存先内の相対パスで、拡張子.mdにしてください":
      return vscode.l10n.t(
        "Use a relative filename within the notes folder with a .md extension",
      );
    default:
      return value;
  }
}

export function errorMessage(error: unknown): string {
  return modelText(error instanceof Error ? error.message : String(error));
}

// Unsupported UI languages use the same English fallback as the bundles.
export function uiLanguage(): string {
  return vscode.env.language.toLowerCase().split("-")[0] === "ja" ? "ja" : "en";
}
export function calendarMonth(month: string): string {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, number - 1, 1);
  return new Intl.DateTimeFormat(uiLanguage(), {
    year: "numeric",
    month: "long",
  }).format(date);
}
export function calendarWeekdays(start: "sunday" | "monday"): string[] {
  const format = new Intl.DateTimeFormat(uiLanguage(), {
    weekday: uiLanguage() === "ja" ? "narrow" : "short",
    timeZone: "UTC",
  });
  return Array.from({ length: 7 }, (_, i) =>
    format.format(
      new Date(Date.UTC(2023, 0, 1 + i + (start === "monday" ? 1 : 0))),
    ),
  );
}

export function scriptString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
