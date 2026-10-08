export interface Reminder {
  line: number;
  start: number;
  end: number;
  date: string;
  kind: string;
  days: number;
  text: string;
}
export interface Link {
  line: number;
  start: number;
  end: number;
  target: string;
  declaration: boolean;
}
export interface Note {
  uri: string;
  title: string;
  text: string;
  modified: number;
  keywords: string[];
  links: Link[];
  reminders: Reminder[];
  lines: string[];
  active: string[];
}
export function dateString(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function dayNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
    ? date.getTime() / 86400000
    : NaN;
}
export function parseNote(
  uri: string,
  text: string,
  modified = Date.now(),
): Note {
  const lines = text.split(/\r?\n/);
  const active: string[] = [];
  let fence = "",
    fenceLength = 0,
    title = "";
  const links: Link[] = [],
    reminders: Reminder[] = [],
    keywords: string[] = [];
  lines.forEach((line, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence &&
        marker[1].length >= fenceLength &&
        !marker[2].trim()
      )
        fence = "";
      active.push("");
      return;
    }
    if (marker) {
      fence = marker[1][0];
      fenceLength = marker[1].length;
      active.push("");
      return;
    }
    if (/^( {4}|\t)/.test(line)) {
      active.push("");
      return;
    }
    const plain = line.replace(/(`+).*?\1/g, (match) =>
      " ".repeat(match.length),
    );
    active.push(plain);
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(plain);
    if (!title && heading) title = heading[1];
    const link = /^\s*(<<<|>>>)\s+(.+?)\s*$/.exec(plain);
    if (link) {
      links.push({
        line: i,
        start: line.indexOf(link[1]),
        end: line.trimEnd().length,
        target: link[2],
        declaration: link[1] === "<<<",
      });
      if (link[1] === "<<<") keywords.push(link[2]);
    }
    const re = /\[(\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2})?\]([@+!~.\-])(\d*)/g;
    for (const m of plain.matchAll(re)) {
      if (!Number.isFinite(dayNumber(m[1]))) continue;
      reminders.push({
        line: i,
        start: m.index!,
        end: m.index! + m[0].length,
        date: m[1],
        kind: m[2],
        days: Math.max(
          1,
          Number(m[3]) || (m[2] === "~" ? 30 : m[2] === "-" ? 1 : 7),
        ),
        text: line.slice(m.index! + m[0].length).trim(),
      });
    }
  });
  return {
    uri,
    title: title || decodeURIComponent(uri.split("/").pop() || "Untitled"),
    text,
    modified,
    keywords: [...new Set(keywords)],
    links,
    reminders,
    lines,
    active,
  };
}
export function search(notes: Note[], query: string, regex = false): Note[] {
  if (regex && query.length > 256)
    throw new Error("正規表現は256文字以内にしてください");
  const pattern = regex ? new RegExp(query, "iu") : undefined;
  const q = query.toLocaleLowerCase();
  return notes
    .filter((n) =>
      pattern ? pattern.test(n.text) : n.text.toLocaleLowerCase().includes(q),
    )
    .sort((a, b) => {
      const rank = (n: Note) =>
        n.keywords.some((k) => k.toLocaleLowerCase() === q)
          ? 2
          : n.keywords.some((k) => k.toLocaleLowerCase().includes(q))
            ? 1
            : 0;
      return (
        rank(b) - rank(a) ||
        b.modified - a.modified ||
        a.uri.localeCompare(b.uri)
      );
    });
}
export function keywordLinks(note: Note, keywords: string[]): Link[] {
  const result: Link[] = [...note.links];
  const sorted = [...new Set(keywords)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  note.active.forEach((line, i) => {
    if (note.links.some((l) => l.line === i)) return;
    const occupied: [number, number][] = [];
    for (const m of line.matchAll(/!?\[[^\]]*\]\([^)]*\)|<[^>]*>/g))
      occupied.push([m.index!, m.index! + m[0].length]);
    for (const keyword of sorted) {
      let at = 0;
      while ((at = line.indexOf(keyword, at)) !== -1) {
        const end = at + keyword.length;
        if (!occupied.some(([s, e]) => at < e && end > s)) {
          result.push({
            line: i,
            start: at,
            end,
            target: keyword,
            declaration: false,
          });
          occupied.push([at, end]);
        }
        at = end;
      }
    }
  });
  return result;
}
// Original scoring policy inspired by howm, not byte-for-byte Emacs ordering.
export function priority(r: Reminder, today = dateString()): number {
  const age = dayNumber(today) - dayNumber(r.date);
  switch (r.kind) {
    case ".":
      return -Infinity;
    case "@":
      return age === 0 ? 1000 : -Infinity;
    case "!":
      return age >= 0
        ? 1000 + age
        : age >= -r.days
          ? 100 + 100 * (1 + age / r.days)
          : -Infinity;
    case "+":
      return age >= 0 ? (100 * age) / r.days : -Infinity;
    case "-":
      return age >= 0 ? 100 - (age * 100) / r.days : -Infinity;
    case "~":
      return age >= 0
        ? 50 + 50 * Math.cos((age * 2 * Math.PI) / r.days)
        : -Infinity;
    default:
      return -Infinity;
  }
}
export function renderTemplate(
  template: string,
  title: string,
  body: string,
  now = new Date(),
): string {
  const values: Record<string, string> = {
    title,
    body,
    date: dateString(now),
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
  };
  return template.replace(
    /\{(title|body|date|time)\}/g,
    (_, key) => values[key],
  );
}
export function filename(pattern: string, now = new Date()): string {
  const values: Record<string, string> = {
    YYYY: String(now.getFullYear()),
    MM: String(now.getMonth() + 1).padStart(2, "0"),
    DD: String(now.getDate()).padStart(2, "0"),
    HH: String(now.getHours()).padStart(2, "0"),
    mm: String(now.getMinutes()).padStart(2, "0"),
    ss: String(now.getSeconds()).padStart(2, "0"),
  };
  const result = pattern.replace(
    /\{(YYYY|MM|DD|HH|mm|ss)\}/g,
    (_, key) => values[key],
  );
  if (
    !result ||
    result.startsWith("/") ||
    result.includes("\\") ||
    result.split("/").some((p) => p === ".." || p === "." || !p) ||
    /[:\x00-\x1f]/.test(result) ||
    !/\.md$/i.test(result)
  )
    throw new Error(
      "ファイル名は保存先内の相対パスで、拡張子.mdにしてください",
    );
  return result;
}
