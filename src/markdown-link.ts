/** Keep labels literal, including HTML entities and nested Markdown syntax. */
export function escapeLinkLabel(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").replace(/[\\`*_[\]()<>!&|~]/g, "\\$&");
}

/** Preserve the spelling of web URLs, encoding only Markdown delimiters. */
export function webLink(label: string, url: string): string {
  const destination = url
    .replace(
      /[\\()<>`"\x00-\x20\x7f]/g,
      (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .replace(/&(?=(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);)/g, "\\&");
  return `[${escapeLinkLabel(label)}](${destination})`;
}

export function singleWebUrl(input: string): string | undefined {
  const value = input.trim();
  if (!/^https?:\/\/[^\s\x00-\x1f\x7f]+$/i.test(value)) return;
  try {
    const url = new URL(value);
    if (url.hostname) return value;
  } catch {
    // Leave other clipboard contents to VS Code.
  }
}
