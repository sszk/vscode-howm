import { Note } from "./core";

interface Features {
  note: Note;
  terms: Map<string, number>;
  normRevision: number;
  norm: number;
}
export interface SimilarNote {
  note: Note;
  score: number;
}
type Cancelled = () => boolean;
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

// Only search text is derived here; note boundaries and identity come from Store.
export function normalizeSimilarityText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\[\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\][@+!~.\-]?\d*/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_~>#|]/g, " ");
}

const boilerplate = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "note",
  "notes",
  "untitled",
  "メモ",
]);

async function fieldTerms(
  text: string,
  cancelled: Cancelled,
): Promise<Map<string, number> | undefined> {
  const terms = new Map<string, number>();
  const add = (term: string) => terms.set(term, (terms.get(term) || 0) + 1);
  let deadline = performance.now() + 8,
    steps = 0;
  for (const match of normalizeSimilarityText(text).matchAll(
    /[\p{L}\p{N}\p{M}]+/gu,
  )) {
    const word = match[0];
    if (boilerplate.has(word)) continue;
    const chars = Array.from(word); // Iterate code points, never UTF-16 halves.
    for (let i = 0; i < chars.length; i++) {
      if (i + 1 < chars.length) add(`2:${chars[i]}${chars[i + 1]}`);
      if (i + 2 < chars.length)
        add(`3:${chars[i]}${chars[i + 1]}${chars[i + 2]}`);
      if (++steps % 1024 === 0 && performance.now() >= deadline) {
        await yieldTurn();
        if (cancelled()) return;
        deadline = performance.now() + 8;
      }
    }
    if (/^[a-z0-9]{2,}$/.test(word)) add(`w:${word}`);
  }
  return terms;
}

async function features(
  note: Note,
  cancelled: Cancelled,
): Promise<Features | undefined> {
  if (!note.text.trim())
    return { note, terms: new Map(), normRevision: -1, norm: 0 };
  const title = await fieldTerms(note.title, cancelled);
  if (!title || cancelled()) return;
  // A parsed H1 is already in title. Do not count it again as body content.
  const bodyText = /^ {0,3}#(?:[ \t]|$)/.test(note.lines[0])
    ? note.lines.slice(1).join("\n")
    : note.text;
  const body = await fieldTerms(bodyText, cancelled);
  if (!body || cancelled()) return;
  const terms = new Map<string, number>();
  for (const [term, count] of title) terms.set(term, 3 * (1 + Math.log(count)));
  for (const [term, count] of body)
    terms.set(term, (terms.get(term) || 0) + 1 + Math.log(count));
  return { note, terms, normRevision: -1, norm: 0 };
}

export class SimilarityIndex {
  private documents = new Map<string, Features>();
  private frequencies = new Map<string, number>();
  private revision = 0;
  // IDF depends on the complete corpus. Raw TF features survive IDF changes.
  private idfs = new Map<string, number>();

  private remove(document: Features) {
    for (const term of document.terms.keys()) {
      const count = this.frequencies.get(term)! - 1;
      if (count) this.frequencies.set(term, count);
      else this.frequencies.delete(term);
    }
    this.documents.delete(document.note.id);
  }

  async sync(
    notes: Note[],
    cancelled: Cancelled = () => false,
  ): Promise<boolean> {
    const live = new Set(notes.map((note) => note.id));
    for (const [id, document] of this.documents) {
      if (!live.has(id)) {
        this.remove(document);
        this.invalidate();
      }
    }
    let deadline = performance.now() + 8;
    for (const note of notes) {
      if (cancelled()) return false;
      const old = this.documents.get(note.id);
      if (old?.note.text === note.text && old.note.title === note.title) {
        old.note = note;
      } else {
        const document = await features(note, cancelled);
        if (!document || cancelled()) return false;
        if (old) this.remove(old);
        this.documents.set(note.id, document);
        // A title and its body are one document for document frequency.
        for (const term of document.terms.keys())
          this.frequencies.set(term, (this.frequencies.get(term) || 0) + 1);
        this.invalidate();
      }
      if (performance.now() >= deadline) {
        await yieldTurn();
        deadline = performance.now() + 8;
      }
    }
    return !cancelled();
  }

  private invalidate() {
    this.revision++;
    this.idfs.clear();
  }

  private idf(term: string) {
    let value = this.idfs.get(term);
    if (value === undefined) {
      value =
        1 +
        Math.log(
          (1 + this.documents.size) / (1 + (this.frequencies.get(term) || 0)),
        );
      this.idfs.set(term, value);
    }
    return value;
  }

  private async norm(document: Features, cancelled: Cancelled) {
    if (document.normRevision !== this.revision) {
      let square = 0;
      let deadline = performance.now() + 8,
        steps = 0;
      for (const [term, tf] of document.terms) {
        square += (tf * this.idf(term)) ** 2;
        if (++steps % 1024 === 0 && performance.now() >= deadline) {
          await yieldTurn();
          if (cancelled()) return;
          deadline = performance.now() + 8;
        }
      }
      document.norm = Math.sqrt(square);
      document.normRevision = this.revision;
    }
    return document.norm;
  }

  async search(
    id: string,
    maxResults = 10,
    minSimilarity = 0.1,
    cancelled: Cancelled = () => false,
  ): Promise<SimilarNote[]> {
    const query = this.documents.get(id);
    if (!query || !query.terms.size) return [];
    const norm = await this.norm(query, cancelled);
    if (!norm || cancelled()) return [];
    const results: SimilarNote[] = [];
    let deadline = performance.now() + 8;
    for (const [otherId, document] of this.documents) {
      if (cancelled()) return [];
      if (otherId === id) continue;
      let dot = 0,
        evidence = 0;
      // A large active note must not multiply its entire vocabulary by the
      // number of small candidate notes.
      const [smaller, larger] =
        query.terms.size <= document.terms.size
          ? [query.terms, document.terms]
          : [document.terms, query.terms];
      let steps = 0;
      for (const [term, tf] of smaller) {
        if (++steps % 1024 === 0 && performance.now() >= deadline) {
          await yieldTurn();
          if (cancelled()) return [];
          deadline = performance.now() + 8;
        }
        const other = larger.get(term);
        if (other === undefined) continue;
        dot += tf * other * this.idf(term) ** 2;
        evidence += 1 / (1 + Math.log(this.frequencies.get(term)!));
      }
      if (dot) {
        const otherNorm = await this.norm(document, cancelled);
        if (!otherNorm || cancelled()) return [];
        // Shrink weak matches: a single shared bigram or ubiquitous fragments
        // must not score as highly as a substantial shared phrase.
        const score =
          (Math.min(1, dot / (norm * otherNorm)) * evidence) / (evidence + 8);
        if (score >= minSimilarity)
          results.push({ note: document.note, score });
      }
      if (performance.now() >= deadline) {
        await yieldTurn();
        deadline = performance.now() + 8;
      }
    }
    if (cancelled()) return [];
    return results
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.note.modified - a.note.modified ||
          a.note.uri.localeCompare(b.note.uri) ||
          a.note.startLine - b.note.startLine,
      )
      .slice(0, maxResults);
  }

  dispose() {
    this.documents.clear();
    this.frequencies.clear();
    this.idfs.clear();
  }
}
