import { Note } from "./core";

export interface MatchRange {
  start: number;
  end: number;
}
export interface LineMatch {
  id: string;
  note: Note;
  line: number;
  text: string;
  ranges: MatchRange[];
}

export function searchLines(notes: Note[], query: string): LineMatch[] {
  if (!query) return [];
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const results: LineMatch[] = [];
  for (const note of notes) {
    note.lines.forEach((text, localLine) => {
      const ranges = [...text.matchAll(pattern)].map((match) => ({
        start: match.index!,
        end: match.index! + match[0].length,
      }));
      if (ranges.length) {
        const line = note.startLine + localLine;
        results.push({
          id: JSON.stringify([note.id, line]),
          note,
          line,
          text,
          ranges,
        });
      }
    });
  }
  return results;
}

export function matchSnippet(match: LineMatch, length = 180) {
  const first = match.ranges[0];
  let start = Math.max(0, first.start - 40);
  let end = Math.min(match.text.length, Math.max(start + length, first.end));
  // Keep UTF-16 offsets for VS Code, without splitting an emoji in the preview.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(match.text[start])) start--;
  if (end < match.text.length && /[\uDC00-\uDFFF]/.test(match.text[end])) end++;
  return {
    start,
    end,
    text: match.text.slice(start, end),
    ranges: match.ranges
      .filter((range) => range.start < end && range.end > start)
      .map((range) => ({
        start: Math.max(range.start, start) - start,
        end: Math.min(range.end, end) - start,
      })),
  };
}
