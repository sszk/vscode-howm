interface FileLink {
  host: string;
  segments: string[];
  query: string;
  fragment: string;
  escapedDots?: Set<number>;
}

function validHost(host: string): boolean {
  if (/[\\/?#@%|\s]/u.test(host)) return false;
  if (host.includes(":") && !host.startsWith("[")) return false;
  try {
    encodeURIComponent(host);
    // Validate authority syntax without using URL's normalized/encoded output.
    new URL(`file://${host}/`);
    return true;
  } catch {
    return false;
  }
}

function parseFileLink(input: string): FileLink | undefined {
  let value = input.trim();
  // Explorer's "Copy as path" surrounds paths with double quotes.
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (!value || /[\x00-\x1f\x7f]/u.test(value)) return undefined;
  if (/^[a-z]:[\\/]/i.test(value)) {
    return {
      host: "",
      segments: value.split(/[\\/]/),
      query: "",
      fragment: "",
    };
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/](.+)$/.exec(value);
  if (unc) {
    if (!validHost(unc[1]) || /^[\\/]/.test(unc[2])) return undefined;
    return {
      host: unc[1],
      segments: unc[2].split(/[\\/]/),
      query: "",
      fragment: "",
    };
  }
  const uri = /^file:(?:\/\/([^/?#]*))?(\/[^?#]*)(\?[^#]*)?(#.*)?$/i.exec(
    value,
  );
  if (!uri || value.includes("\\")) return undefined;
  const host = decodeURIComponent(uri[1] || "");
  if (!validHost(host)) return undefined;
  // Split before decoding: encoded slashes and backslashes stay inside their
  // original segment and are re-encoded when rendering the destination.
  const rawSegments = uri[2].slice(1).split("/");
  const segments = rawSegments.map(decodeURIComponent);
  if (/^[a-z]:./i.test(segments[0])) return undefined;
  const escapedDots = new Set<number>();
  segments.forEach((segment, index) => {
    if (
      (segment === "." || segment === "..") &&
      rawSegments[index].includes("%")
    )
      escapedDots.add(index);
  });
  return {
    host,
    segments,
    query: uri[3] || "",
    fragment: uri[4] || "",
    escapedDots,
  };
}

function readableComponent(value: string, allowed = ""): string {
  // Reject unpaired UTF-16 surrogates instead of silently replacing characters.
  encodeURIComponent(value);
  return Array.from(value, (char) => {
    if (
      /^[a-z0-9._~-]$/i.test(char) ||
      allowed.includes(char) ||
      (char.codePointAt(0)! >= 0xa0 && !/\s/u.test(char))
    )
      return char;
    // encodeURIComponent leaves some Markdown punctuation unescaped.
    return encodeURIComponent(char).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }).join("");
}

function readableSuffix(value: string): string {
  decodeURIComponent(value); // Validate all escapes and UTF-8 first.
  return value.replace(/(?:%[\da-f]{2})+|[^%]+/gi, (part) =>
    part.startsWith("%")
      ? readableComponent(decodeURIComponent(part))
      : readableComponent(part, ":/?#@!$&'*+,;="),
  );
}

/** Convert an absolute Windows/UNC path or file URI to a readable Markdown link. */
export function windowsPathLink(input: string): string | undefined {
  try {
    const parsed = parseFileLink(input);
    if (!parsed) return undefined;
    const { host, segments, query, fragment } = parsed;
    if (segments.some((segment) => /[\x00-\x1f\x7f]/u.test(segment)))
      return undefined;
    const path = segments
      .map((segment, index) =>
        parsed.escapedDots?.has(index)
          ? segment.replace(/\./g, "%2E")
          : readableComponent(
              segment,
              index === 0 && /^[a-z]:$/i.test(segment) ? ":" : "",
            ),
      )
      .join("/");
    const authority = readableComponent(
      host,
      host.startsWith("[") ? "[]:" : "",
    );
    const uri = `file://${authority}/${path}${readableSuffix(query)}${readableSuffix(fragment)}`;
    const name =
      [...segments].reverse().find((segment) => segment !== "") || host || "/";
    const label = name.replace(/[\\`*_[\]()<>!&|~]/g, "\\$&");
    return `[${label}](${uri})`;
  } catch {
    // Invalid percent escapes, invalid UTF-8 and malformed authorities are input errors.
    return undefined;
  }
}
