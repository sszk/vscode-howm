import { Note } from "./core";
import {
  Cancelled,
  yieldTurn,
  fieldTerms,
  normalizeSimilarityText,
  inverseDocumentFrequency,
  correctedCosine,
} from "./similarity-text";

interface TextLine {
  line: number;
  text: string;
}
interface Section {
  start: number;
  end: number;
  lines: TextLine[];
}
export interface PassageQuery {
  note: Note;
  startLine: number;
  endLine: number; // Exclusive, as in Note.
  text: string;
}
export interface Passage extends PassageQuery {
  // Opaque, session-local identity; line numbers are navigation metadata only.
  id: string;
  generation: number;
  lines: TextLine[];
  terms: Map<string, number>;
  normRevision: number;
  norm: number;
}
export interface RelatedPassage {
  passage: Passage;
  score: number;
  excerpt: string;
}

const queryLimit = 4000;
const sectionsCache = new WeakMap<Note, Section[]>();
function prose(line: string) {
  return normalizeSimilarityText(line)
    .replace(/^\s*(?:[-+]|\d+[.)])\s+(?:\[[ x]\]\s*)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sections(note: Note): Section[] {
  const cached = sectionsCache.get(note);
  if (cached) return cached;
  const result: Section[] = [];
  let section: Section = {
    start: note.startLine,
    end: note.endLine,
    lines: [],
  };
  result.push(section);
  note.active.forEach((active, i) => {
    const line = note.startLine + i;
    // Store's active lines already mask fenced/indented code and inline code.
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(active)) {
      if (line !== section.start) {
        section.end = line;
        section = { start: line, end: note.endLine, lines: [] };
        result.push(section);
      }
      return;
    }
    const text = prose(active);
    if (/[\p{L}\p{N}]/u.test(text)) section.lines.push({ line, text });
  });
  sectionsCache.set(note, result);
  return result;
}

export function extractPassageQuery(
  note: Note,
  cursor: number,
  contextLines = 5,
  minLength = 30,
): PassageQuery | undefined {
  const section = sections(note).find(
    (s) => cursor >= s.start && cursor < s.end,
  );
  if (!section?.lines.length) return;
  const candidates = section.lines;
  let from = candidates.findIndex((l) => l.line >= cursor - contextLines);
  if (from < 0) from = candidates.length;
  let to = from;
  while (to < candidates.length && candidates[to].line <= cursor + contextLines)
    to++;
  const selected: TextLine[] = candidates.slice(from, to);
  const effectiveLength = (text: string) =>
    Array.from(text.slice(0, queryLimit).replace(/\s/g, "")).length;
  let length = selected.reduce((sum, l) => sum + effectiveLength(l.text), 0);
  // Expand within this section when prose is short or the cursor is in code.
  while (
    length < Math.min(minLength, queryLimit) &&
    (from > 0 || to < candidates.length)
  ) {
    const before = candidates[from - 1],
      after = candidates[to];
    const entry =
      before && (!after || cursor - before.line <= after.line - cursor)
        ? candidates[--from]
        : candidates[to++];
    selected.push(entry);
    length += effectiveLength(entry.text);
  }
  selected.sort((a, b) => a.line - b.line);
  // Bound even a single extremely long line, favoring the cursor's vicinity.
  const nearest = [...selected].sort(
    (a, b) => Math.abs(a.line - cursor) - Math.abs(b.line - cursor),
  );
  const kept: TextLine[] = [];
  let remaining = queryLimit;
  for (const entry of nearest) {
    if (!remaining) break;
    const text = entry.text.slice(0, remaining);
    kept.push({ line: entry.line, text });
    remaining -= text.length + 1;
    remaining = Math.max(0, remaining);
  }
  kept.sort((a, b) => a.line - b.line);
  const text = kept.map((l) => l.text).join("\n");
  if (Array.from(text.replace(/\s/g, "")).length < minLength) return;
  return {
    note,
    text,
    startLine: kept[0].line,
    endLine: kept.at(-1)!.line + 1,
  };
}

// Yield windows lazily so indexing a large memo can return to the event loop.
export function* passageWindows(note: Note, windowLines = 5, windowStep = 2) {
  const size = Math.max(1, Math.floor(windowLines));
  const step = Math.max(1, Math.min(size, Math.floor(windowStep)));
  for (const section of sections(note)) {
    for (let i = 0; i < section.lines.length; i += step) {
      const lines = section.lines.slice(i, i + size);
      yield {
        note,
        lines,
        text: lines.map((l) => l.text).join("\n"),
        startLine: lines[0].line,
        endLine: lines.at(-1)!.line + 1,
      };
      if (i + size >= section.lines.length) break;
    }
  }
}

export function deduplicatePassages(
  results: RelatedPassage[],
  maxResults: number,
) {
  const kept: RelatedPassage[] = [];
  for (const result of results) {
    const p = result.passage;
    if (
      kept.some(
        ({ passage: other }) =>
          other.note.id === p.note.id &&
          p.startLine < other.endLine &&
          other.startLine < p.endLine,
      )
    )
      continue;
    kept.push(result);
    if (kept.length >= maxResults) break;
  }
  return kept;
}

export class PassageIndex {
  private notes = new Map<string, { note: Note; passages: Passage[] }>();
  private frequencies = new Map<string, number>();
  private idfs = new Map<string, number>();
  private revision = 0;
  private sequence = 0;
  private count = 0;
  private geometry = "";

  private remove(id: string) {
    const old = this.notes.get(id);
    if (!old) return;
    for (const passage of old.passages) {
      this.count--;
      for (const term of passage.terms.keys()) {
        const count = this.frequencies.get(term)! - 1;
        if (count) this.frequencies.set(term, count);
        else this.frequencies.delete(term);
      }
    }
    this.notes.delete(id);
    this.invalidate();
  }

  private invalidate() {
    this.revision++;
    this.idfs.clear();
  }

  async sync(
    notes: Note[],
    windowLines = 5,
    windowStep = 2,
    cancelled: Cancelled = () => false,
  ) {
    if (cancelled()) return false;
    const geometry = JSON.stringify([windowLines, windowStep]);
    if (this.geometry !== geometry) {
      this.dispose();
      this.geometry = geometry;
    }
    const live = new Set(notes.map((n) => n.id));
    for (const id of this.notes.keys()) if (!live.has(id)) this.remove(id);
    let deadline = performance.now() + 8;
    for (const note of notes) {
      if (cancelled()) return false;
      const old = this.notes.get(note.id);
      if (old?.note.text === note.text) {
        old.note = note;
        // Refresh source snapshots even if only another memo in the file changed.
        for (const passage of old.passages) passage.note = note;
      } else {
        const passages: Passage[] = [];
        for (const window of passageWindows(note, windowLines, windowStep)) {
          const raw = await fieldTerms(window.text, cancelled);
          if (!raw || cancelled()) return false;
          const terms = new Map(
            [...raw].map(([term, count]) => [term, 1 + Math.log(count)]),
          );
          if (terms.size)
            passages.push({
              ...window,
              terms,
              id: `passage-${++this.sequence}`,
              generation: this.revision + 1,
              normRevision: -1,
              norm: 0,
            });
          if (performance.now() >= deadline) {
            await yieldTurn();
            if (cancelled()) return false;
            deadline = performance.now() + 8;
          }
        }
        this.remove(note.id);
        this.notes.set(note.id, { note, passages });
        for (const passage of passages) {
          this.count++;
          for (const term of passage.terms.keys())
            this.frequencies.set(term, (this.frequencies.get(term) || 0) + 1);
        }
        this.invalidate();
      }
      if (performance.now() >= deadline) {
        await yieldTurn();
        deadline = performance.now() + 8;
      }
    }
    return !cancelled();
  }

  private idf(term: string) {
    let idf = this.idfs.get(term);
    if (idf === undefined) {
      idf = inverseDocumentFrequency(
        this.count,
        this.frequencies.get(term) || 0,
      );
      this.idfs.set(term, idf);
    }
    return idf;
  }

  private async norm(terms: Map<string, number>, cancelled: Cancelled) {
    let square = 0,
      steps = 0,
      deadline = performance.now() + 8;
    for (const [term, tf] of terms) {
      square += (tf * this.idf(term)) ** 2;
      if (++steps % 1024 === 0 && performance.now() >= deadline) {
        await yieldTurn();
        if (cancelled()) return 0;
        deadline = performance.now() + 8;
      }
    }
    return Math.sqrt(square);
  }

  async search(
    query: PassageQuery,
    maxResults = 10,
    minSimilarity = 0.15,
    cancelled: Cancelled = () => false,
  ): Promise<RelatedPassage[]> {
    if (cancelled()) return [];
    const raw = await fieldTerms(query.text, cancelled);
    if (!raw || cancelled()) return [];
    const terms = new Map(
      [...raw].map(([term, count]) => [term, 1 + Math.log(count)]),
    );
    const norm = await this.norm(terms, cancelled);
    if (!norm || cancelled()) return [];
    const results: RelatedPassage[] = [];
    let deadline = performance.now() + 8;
    for (const { note, passages } of this.notes.values()) {
      if (note.id === query.note.id) continue;
      for (const passage of passages) {
        if (cancelled()) return [];
        let dot = 0,
          evidence = 0,
          steps = 0;
        const [smaller, larger] =
          terms.size <= passage.terms.size
            ? [terms, passage.terms]
            : [passage.terms, terms];
        for (const [term, tf] of smaller) {
          const other = larger.get(term);
          if (other !== undefined) {
            dot += tf * other * this.idf(term) ** 2;
            evidence += 1 / (1 + Math.log(this.frequencies.get(term) || 1));
          }
          if (++steps % 1024 === 0 && performance.now() >= deadline) {
            await yieldTurn();
            if (cancelled()) return [];
            deadline = performance.now() + 8;
          }
        }
        if (dot) {
          if (passage.normRevision !== this.revision) {
            const value = await this.norm(passage.terms, cancelled);
            if (cancelled()) return [];
            passage.norm = value;
            passage.normRevision = this.revision;
          }
          if (passage.norm) {
            const score = correctedCosine(dot, norm, passage.norm, evidence);
            if (score >= minSimilarity)
              results.push({ passage, score, excerpt: "" });
          }
        }
        if (performance.now() >= deadline) {
          await yieldTurn();
          if (cancelled()) return [];
          deadline = performance.now() + 8;
        }
      }
    }
    results.sort(
      (a, b) =>
        b.score - a.score ||
        b.passage.note.modified - a.passage.note.modified ||
        a.passage.note.uri.localeCompare(b.passage.note.uri) ||
        a.passage.startLine - b.passage.startLine,
    );
    const selected = deduplicatePassages(results, maxResults);
    for (const result of selected) {
      let best = 0,
        bestScore = -1;
      for (let i = 0; i < result.passage.lines.length; i++) {
        const lineTerms = await fieldTerms(
          result.passage.lines[i].text,
          cancelled,
        );
        if (!lineTerms || cancelled()) return [];
        let score = 0;
        for (const term of lineTerms.keys())
          if (terms.has(term)) score += this.idf(term);
        if (score > bestScore) {
          best = i;
          bestScore = score;
        }
      }
      const lines = result.passage.lines;
      // Put the strongest line first so wrapping in a narrow sidebar cannot
      // hide it behind less relevant preceding context.
      const start = best;
      result.excerpt = lines
        .slice(start, start + 3)
        .map((l) => {
          const text =
            result.passage.note.lines[
              l.line - result.passage.note.startLine
            ].trim();
          return text.length > 120 ? text.slice(0, 119) + "…" : text;
        })
        .join("\n");
      if (start > 0) result.excerpt = "…" + result.excerpt;
      if (start + 3 < lines.length) result.excerpt += "…";
    }
    return cancelled() ? [] : selected;
  }

  dispose() {
    this.notes.clear();
    this.frequencies.clear();
    this.idfs.clear();
    this.count = 0;
    this.geometry = "";
    this.revision++;
  }
}
