import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt();

/** Source offsets, rather than rendered text, also work in lists and quotes. */
export function codeRegions(text: string): [number, number][] {
  const lines = [0];
  for (const match of text.matchAll(/\n/g)) lines.push(match.index! + 1);
  const regions: [number, number][] = [];
  for (const token of markdown.parse(text, {})) {
    if (!token.map) continue;
    const start = lines[token.map[0]] ?? text.length;
    const end = lines[token.map[1]] ?? text.length;
    if (token.type === "fence" || token.type === "code_block") {
      const contentLines = token.content
        ? token.content.split("\n").length -
          (token.content.endsWith("\n") ? 1 : 0)
        : 0;
      const unclosedFence =
        token.type === "fence" &&
        token.map[1] - token.map[0] === contentLines + 1;
      // An empty line after a closing fence is prose; EOF in an unfinished
      // fence or on a code line still belongs to the code region.
      const includeEof =
        end === text.length && (unclosedFence || !text.endsWith("\n"));
      regions.push([start, end + (includeEof ? 1 : 0)]);
    } else if (token.type === "inline") {
      const source = text.slice(start, end);
      const runs = [...source.matchAll(/`+/g)];
      for (let i = 0; i < runs.length; i++) {
        const opening = runs[i];
        const prefix = source.slice(0, opening.index);
        if ((/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) continue;
        const closing = runs.findIndex(
          (run, j) => j > i && run[0] === opening[0],
        );
        if (closing < 0) continue;
        regions.push([
          start + opening.index!,
          start + runs[closing].index! + runs[closing][0].length,
        ]);
        i = closing;
      }
    }
  }
  return regions;
}

export function touchesCode(
  regions: [number, number][],
  start: number,
  end: number,
): boolean {
  return regions.some(([from, to]) =>
    start === end ? start >= from && start < to : start < to && end > from,
  );
}
