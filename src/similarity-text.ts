export type Cancelled = () => boolean;
export const yieldTurn = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

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

export async function fieldTerms(
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

// Both searches use the same smoothed IDF and weak-evidence correction, with
// independent corpus statistics and norm caches.
export const inverseDocumentFrequency = (
  documents: number,
  frequency: number,
) => 1 + Math.log((1 + documents) / (1 + frequency));

export const correctedCosine = (
  dot: number,
  norm: number,
  otherNorm: number,
  evidence: number,
) => (Math.min(1, dot / (norm * otherNorm)) * evidence) / (evidence + 8);
