import * as vscode from "vscode";
import { codeRegions, touchesCode } from "./paste-code";
import { escapeLinkLabel, singleWebUrl, webLink } from "./markdown-link";
import { fetchPageTitle } from "./page-title";
import { fileUrlLink } from "./windows-path-link";

interface Insertion {
  start: number;
  length: number;
  text: string;
  fetch: boolean;
}
interface Candidate {
  document: vscode.TextDocument;
  version: number;
  url: string;
  insertions: Insertion[];
  expectedText: string;
  timer?: ReturnType<typeof setTimeout>;
}
interface TrackedLink {
  start: number;
  text: string;
  valid: boolean;
}
interface Job {
  document: vscode.TextDocument;
  links: TrackedLink[];
  controller: AbortController;
}

export class UrlPasteProvider
  implements vscode.DocumentPasteEditProvider, vscode.Disposable
{
  static readonly kind = vscode.DocumentDropOrPasteEditKind.Empty.append(
    "markdown",
    "link",
    "howm",
  );
  private edits = new WeakMap<vscode.DocumentPasteEdit, Candidate>();
  private candidates = new Set<Candidate>();
  private jobs = new Set<Job>();
  private disposed = false;
  private subscriptions: vscode.Disposable[];

  constructor(private readonly fetchTitle = fetchPageTitle) {
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => this.changed(event)),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.cancel(document),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("howm.autoLinkOnPaste")) this.cancel();
      }),
    ];
  }

  private enabled(document: vscode.TextDocument) {
    return (
      !this.disposed &&
      !document.isClosed &&
      document.languageId === "markdown" &&
      vscode.workspace
        .getConfiguration("howm", document.uri)
        .get<boolean>("autoLinkOnPaste", true)
    );
  }

  async provideDocumentPasteEdits(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[],
    data: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    if (
      !this.enabled(document) ||
      !ranges.length ||
      token.isCancellationRequested
    )
      return;
    const version = document.version;
    const item = data.get("text/plain");
    if (!item) return;
    const value = await item.asString();
    const url = singleWebUrl(value);
    const fileLink = fileUrlLink(value);
    if (
      (!url && !fileLink) ||
      !this.enabled(document) ||
      document.version !== version ||
      token.isCancellationRequested
    )
      return;
    const regions = codeRegions(document.getText());
    const insertions: Insertion[] = [];
    for (const range of ranges) {
      const start = document.offsetAt(range.start),
        end = document.offsetAt(range.end);
      // A mixed multi-cursor paste falls back as a whole, preserving native behavior.
      if (touchesCode(regions, start, end)) return;
      const selected = document.getText(range);
      insertions.push({
        start,
        length: end - start,
        text: fileLink ?? webLink(selected || new URL(url!).hostname, url!),
        fetch: !!url && !selected,
      });
    }
    insertions.sort((a, b) => a.start - b.start);
    if (
      insertions.some(
        (item, i) =>
          i > 0 &&
          item.start <= insertions[i - 1].start + insertions[i - 1].length,
      )
    )
      return;
    const sameText = insertions.every(
      (item) => item.text === insertions[0].text,
    );
    const edit = new vscode.DocumentPasteEdit(
      sameText ? insertions[0].text : "",
      "howm: URLをMarkdownリンクとして貼り付け",
      UrlPasteProvider.kind,
    );
    // Keep the native snippet/cursor handling whenever all selections share a label.
    if (!sameText) {
      const additional = new vscode.WorkspaceEdit();
      for (const item of insertions)
        additional.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(item.start),
            document.positionAt(item.start + item.length),
          ),
          item.text,
        );
      edit.additionalEdit = additional;
    }
    if (url) {
      let expectedText = document.getText();
      for (const item of [...insertions].reverse())
        expectedText =
          expectedText.slice(0, item.start) +
          item.text +
          expectedText.slice(item.start + item.length);
      this.edits.set(edit, {
        document,
        version,
        url,
        insertions,
        expectedText,
      });
    }
    return [edit];
  }

  resolveDocumentPasteEdit(
    edit: vscode.DocumentPasteEdit,
    token: vscode.CancellationToken,
  ) {
    const candidate = this.edits.get(edit);
    this.edits.delete(edit);
    if (
      candidate &&
      this.enabled(candidate.document) &&
      !token.isCancellationRequested &&
      candidate.document.version === candidate.version &&
      candidate.insertions.some((item) => item.fetch)
    ) {
      // Resolve runs before application. Start networking only after the exact
      // proposed edit is observed, so unused provider alternatives have no effects.
      this.candidates.add(candidate);
      candidate.timer = setTimeout(() => this.removeCandidate(candidate), 5000);
    }
    return edit;
  }

  private removeCandidate(candidate: Candidate) {
    if (candidate.timer) clearTimeout(candidate.timer);
    this.candidates.delete(candidate);
  }

  private changed(event: vscode.TextDocumentChangeEvent) {
    if (!event.contentChanges.length) return;
    const changes = [...event.contentChanges].sort(
      (a, b) => a.rangeOffset - b.rangeOffset,
    );
    for (const job of this.jobs) {
      if (job.document !== event.document) continue;
      for (const link of job.links) {
        if (!link.valid) continue;
        if (
          event.reason ||
          changes.some(
            (change) =>
              change.rangeOffset <= link.start + link.text.length &&
              change.rangeOffset + change.rangeLength >= link.start,
          )
        ) {
          link.valid = false;
          continue;
        }
        link.start += changes
          .filter((change) => change.rangeOffset < link.start)
          .reduce(
            (shift, change) => shift + change.text.length - change.rangeLength,
            0,
          );
      }
      if (!job.links.some((link) => link.valid)) {
        job.controller.abort();
        this.jobs.delete(job);
      }
    }
    for (const candidate of this.candidates) {
      if (candidate.document !== event.document) continue;
      this.removeCandidate(candidate);
      if (
        event.reason ||
        event.document.version !== candidate.version + 1 ||
        // VS Code can minimize replacements into several smaller changes.
        // Match the entire expected next version, never search for link text.
        event.document.getText() !== candidate.expectedText
      )
        continue;
      let shift = 0;
      const links: TrackedLink[] = [];
      for (const item of candidate.insertions) {
        if (item.fetch)
          links.push({
            start: item.start + shift,
            text: item.text,
            valid: true,
          });
        shift += item.text.length - item.length;
      }
      const job: Job = {
        document: event.document,
        links,
        controller: new AbortController(),
      };
      this.jobs.add(job);
      void this.updateTitle(job, candidate.url);
    }
  }

  private async updateTitle(job: Job, url: string) {
    try {
      const title = await this.fetchTitle(url, job.controller.signal);
      if (!title || !this.jobs.has(job) || !this.enabled(job.document)) return;
      const editor = vscode.window.visibleTextEditors.find(
        (item) => item.document === job.document,
      );
      if (!editor) return;
      const label = escapeLinkLabel(title);
      const hostname = escapeLinkLabel(new URL(url).hostname);
      if (label === hostname) return;
      const links = job.links.filter(
        (link) =>
          link.valid &&
          job.document.getText(
            new vscode.Range(
              job.document.positionAt(link.start),
              job.document.positionAt(link.start + link.text.length),
            ),
          ) === link.text,
      );
      // TextEditor.edit validates the document version on application, adjusts
      // selections natively, and gives this asynchronous update its own undo step.
      this.jobs.delete(job);
      if (links.length)
        await editor.edit(
          (builder) => {
            for (const link of links)
              builder.replace(
                new vscode.Range(
                  job.document.positionAt(link.start + 1),
                  job.document.positionAt(link.start + 1 + hostname.length),
                ),
                label,
              );
          },
          { undoStopBefore: true, undoStopAfter: true },
        );
    } catch {
      // Network errors and editor shutdown must never show an error notification.
    } finally {
      this.jobs.delete(job);
      job.controller.abort();
    }
  }

  private cancel(document?: vscode.TextDocument) {
    for (const candidate of this.candidates)
      if (!document || candidate.document === document)
        this.removeCandidate(candidate);
    for (const job of this.jobs)
      if (!document || job.document === document) {
        job.controller.abort();
        this.jobs.delete(job);
      }
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.subscriptions.forEach((item) => item.dispose());
  }
}

export function registerUrlPaste(context: vscode.ExtensionContext) {
  const provider = new UrlPasteProvider();
  context.subscriptions.push(
    provider,
    vscode.languages.registerDocumentPasteEditProvider(
      { language: "markdown" },
      provider,
      {
        pasteMimeTypes: ["text/plain"],
        providedPasteEditKinds: [UrlPasteProvider.kind],
      },
    ),
  );
}
