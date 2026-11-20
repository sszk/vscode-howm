# Markdown howm

English | [日本語](README.ja.md)

A VS Code extension for writing small Markdown notes and reading them together through search and links.

## Installation

Run `npm install` followed by `npm run package` to build a VSIX. In VS Code, run **Extensions: Install from VSIX...** and select the generated file. For development, open this folder in VS Code and press F5.

Open a folder and run `howm: Create Note`. By default, notes are saved in its `howm/` subfolder. To use existing notes, run `howm: Select Notes Folder`. You can also select a notes folder without opening a workspace.

## Usage

- `howm: Open Home`: Open the main menu.
- `howm: Create Note`: Create a note with an editable title. The default is `メモ` (Japanese for “note”); change it with `howm.defaultTitle`. Selected text takes precedence as the suggested title. You can also leave the title empty.
- `howm: Open Daily Memo`: Open today’s howm file with the newest saved modification time. Ties are resolved by the timestamp in the filename, then by path. If no file dated today exists, create one using the normal filename, folder, and template settings. The calendar button beside Create Note runs the same command.
- `howm: Capture Note`: Save a short piece of text immediately. Edit longer content in the editor afterward.
- `howm: Search All Text`: Search the full text of notes using a case-insensitive literal query. Select a result to preview it and press Enter to open it.
- `howm: Search with Regular Expression`: Search with JavaScript regular expressions using the `iu` flags for case-insensitive Unicode matching. Expressions are limited to 256 characters. Searches run in a separate thread and stop after two seconds.
- **Read All Notes Together** in a search or note list: Combine notes into a read-only document. Use each **Open source note** link to return to the editable source.
- `howm: Show Related Notes`: Show other notes containing the current note’s declared keywords or link terms.
- `howm: Show Search History`, `howm: Open Random Note`, and `howm: Show Recent Notes` are also available.

Full-text and regular expression searches from the command palette are saved with their search mode in a history of up to 50 entries. Repeating the same query and mode moves it to the top instead of adding a duplicate. Empty queries are not saved. Selecting an entry repeats the search using its original mode.

Create a note with `Ctrl+Alt+N` on Windows/Linux or `Cmd+Alt+N` on macOS. Search with `Ctrl+Alt+H` or `Cmd+Alt+H`. You can change these shortcuts in VS Code’s keyboard shortcut settings.

## Pinning notes

Pin notes using the button at the right edge of a note row in Notes, Similar Notes, or Calendar. Unpinned buttons appear on hover or when the row receives keyboard focus; pinned buttons remain visible. Use Tab to focus a button and Enter or Space to toggle it.

You can also use the editor title bar, the editor context menu, or `howm: Toggle Pin` in the command palette. Only Markdown files inside the notes folder are eligible. The regular note list places pinned notes first while preserving the order within each group and the current search filter. Similar Notes keeps its similarity ranking, and Calendar keeps its date grouping.

Pin state is stored in the extension’s `globalState` and restored after a restart. Pins apply to files, so all notes in a file share the same state. Pinning does not change note content or save pending edits. Moving or renaming a file in VS Code preserves its pin; moving it outside the notes folder or deleting it removes the pin. Moving the entire notes folder in VS Code also transfers its URI keys; update the notes folder setting to the new location to restore them. Renames made by an external application are treated as deletion and creation, so their pins are not transferred.

## Markdown and links

```markdown
# Ideas for a search UI

<<< Search UI

Preview the text when selecting a result.

> > > Keyboard navigation

[2026-10-15]!7 Build a prototype
```

A file can contain multiple notes. Each `# Heading` starts a note that continues until the next top-level heading. Subheadings (`##` and below), headings in fenced code blocks, and indented code do not split notes. Only ATX level-one headings using `#` serve as boundaries.

```markdown
This preamble is not indexed.

# Shopping

[2026-10-10]

[2026-10-10]+ Buy milk

# Reading

[2026-10-11]

<<< Reading
Organize the books I want to read.

## Books of interest

This subheading belongs to the Reading note.
```

This example contains two notes: Shopping and Reading. Text before the first top-level heading is excluded from searches, links, dates, and reminders. A file without a heading is treated as one note. An empty top-level heading (`#` or `# `) still starts a note, using the filename as its displayed title. Notes with identical titles remain separate.

Notes, search results, and Calendar show each note separately and navigate to its heading when selected. Combined search results include only the matching notes’ text. Each note’s date comes from its own timestamp line, then the filename, then the modification date. Related notes can include other notes in the same file.

To add a note to an existing file, add another `# Heading` in the editor. Additions and deletions appear in lists even before saving. `howm: Create Note` and `howm: Capture Note` continue to create new files.

`>>> keyword` is a full-text search link. `<<< keyword` is a come-from declaration: occurrences of that term in other notes become search links, and the declaring notes rank higher in search results. Put each custom link or declaration on its own line. Follow a link with Ctrl/Cmd-click or `howm: Open Link at Cursor`. If a newly declared keyword does not appear as a link in another open note, reopen that tab.

You can also follow paths to existing files, such as `>>> ./other.md`. Standard Markdown links work through VS Code’s built-in support. Custom links work in the editor and are not added to Markdown previews. Fenced and inline code are excluded from custom syntax processing, but full-text search still includes code.

In Markdown notes inside the notes folder, typing `>>> ` or `<<< ` offers completion for declared keywords. `howm: Insert Keyword` lets you choose a declared keyword and insert it at the editor selection.

### Creating Markdown links by pasting URLs

Paste a single HTTP/HTTPS URL into a Markdown editor with `Cmd+V` or `Ctrl+V` to insert a link such as `[example.com](https://example.com)` immediately. The extension fetches the page title asynchronously and updates the link label. If text is selected, that text becomes the label and no request is made. Disable this behavior by setting `howm.autoLinkOnPaste` to `false` (the default is `true`).

Pasting a `file:` URL also creates a link labeled with the filename. For example, `file:///C:/資料/設計%20書.pdf` becomes `[設計 書.pdf](file:///C:/資料/設計%20書.pdf)`. Unicode and percent-encoded filenames and shared-folder URLs are supported. For file URLs, the filename is always used even when text is selected. No file is read and no network request is made.

Code blocks, inline code, existing Markdown links, multiple URLs, and ordinary prose are not converted. This feature works in Markdown files outside the howm notes folder as well. Choose other paste formats from VS Code’s paste options.

Title fetching is limited to three seconds, five redirects, and 512 KiB of HTML. The HTML `title` takes precedence over `og:title`; if neither can be retrieved, the hostname remains as the label. HTTP header and meta charset declarations are supported in addition to UTF-8. Requests to local, private, and link-local addresses are blocked, including addresses obtained through DNS or redirects.

Links edited, deleted, or affected by Undo/Redo while a title is being fetched are not updated. Edits elsewhere in the document are tracked to keep the link’s position correct. Title updates are separate Undo operations and are not merged with preceding typing. Pending updates stop when the document is no longer visible. Pages that require JavaScript execution to obtain their title are not supported.

### Converting Windows paths to Markdown links

Select a path in the editor and run `howm: Insert Windows Path as Link` to replace it with a Markdown link labeled with the filename, or folder name for a folder. Without a selection, the command inserts the clipboard path at the cursor. Double quotes added by Windows Explorer’s **Copy as path** are accepted.

Absolute Windows paths, UNC paths, and existing `file:` URIs produce the same results on every operating system. Drive-relative paths (`C:dir\file.txt`), ordinary relative paths, and other URI schemes such as `https:` are rejected without changing the document.

```text
C:\共有資料\基本設計\設計 書.pdf
→ [設計 書.pdf](file:///C:/共有資料/基本設計/設計%20書.pdf)

\\server\共有資料\設計書.pdf
→ [設計書.pdf](file://server/共有資料/設計書.pdf)

file:///C:/%E8%B3%87%E6%96%99/%E8%A8%AD%E8%A8%88%20%E6%9B%B8.pdf
→ [設計 書.pdf](file:///C:/資料/設計%20書.pdf)
```

Non-ASCII characters, including Japanese, remain readable. Spaces become `%20`; characters such as `#`, `?`, and parentheses are escaped so they do not break URI or Markdown syntax. In a Windows path, `%20` is a literal part of the filename and becomes `%2520`. In an existing file URI, `%20` already represents a space and remains `%20`. Invalid percent encoding or UTF-8 is rejected. Encoded separators `%2F` and `%5C` remain inside their path segment instead of becoming directory separators.

The command does not check file existence or make network requests. Insertion and replacement support Undo and do not save automatically. The generated links are standard Markdown links.

## Reminders

Write `[YYYY-MM-DD]symbolDays text` and run `howm: Open Todos Sidebar`.

| Symbol | Meaning                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| `@`    | Event. Appears among upcoming events in date order.                               |
| `+`    | Todo. Priority increases from the specified date.                                 |
| `!`    | Deadline. Priority rises during its lead time and stays high after it is overdue. |
| `-`    | Note to revisit. Rises on the specified date, then gradually falls.               |
| `~`    | Deferred item. Priority rises and falls periodically from the specified date.     |
| `.`    | Completed item. Excluded from the list.                                           |

The optional number sets the lead time or period in days. Defaults are one day for `-`, 30 days for `~`, and seven days for the other kinds. Priorities use an algorithm inspired by howm and do not exactly reproduce the Emacs version’s ordering. Dates are calculated as local calendar days.

### Viewing and completing reminders in the sidebar

Click the howm icon in the activity bar or run `howm: Open Todos Sidebar`. The sidebar includes Calendar, Todos and Schedule, Notes, On This Day, Similar Notes, and Related Passages. You can also open it from `howm: Open Home`.

Calendar shows a month at a time. Use the **Create Note** title-bar button to create a note. Set `howm.calendarWeekStart` to `sunday` (default) or `monday` to choose the first day of the week. Changes apply immediately while preserving the displayed month and selected date. Navigate with the previous month, next month, and Today buttons. Select a date to see its notes below the calendar. Each row shows the text after the date and reminder marker on a line matching the selected date, or the note title if that line has no text. Text on subsequent lines is not used. Multiple reminders in one note on the selected date appear on separate lines. Click the displayed text or title to open the note. The list includes notes dated that day and notes with unfinished reminders on that day. A note appears only once; separate notes in the same file remain separate.

Days with notes have a small marker. Days with unfinished reminders (`@ / + / ! / - / ~`) have a highlighted background. Hover over a day or focus it with Tab to see reminder text, kinds, and note titles in a tooltip. Completed reminders (`.`) are excluded. Future and past items appear on their written dates; overdue Todos are not repeated on every day. The calendar follows edits, completion, Undo, and external changes. Reload the window after updating from a version without Calendar.

Notes has a full-text search field at the top. After 200 ms, it searches all loaded notes using a case-insensitive literal query. Use the search icon or `howm: Search Notes View` to focus the field. Results wait until IME composition is complete.

Results are grouped by note and show each matching line with its file line number. Matches are highlighted; multiple matches on one line produce one result row. Clicking a row selects its first match in the original file. Long lines show an excerpt around the match; hover to see the full line and file location. Headings and code are included in full-text search, but text before the first top-level heading is excluded.

Results are displayed in batches of 200 lines; use **Show More** for the next batch. Clear the query with the × button or Escape to return to the regular note list. Clicking a title opens its heading. The search field remains at the top while results scroll, and the query is preserved when the sidebar is hidden and shown again. Results follow unsaved edits, Undo, and external changes. If the source file changes after results are displayed, the view refreshes and asks you to select again. Searching and navigation do not save automatically.

**After updating from a version before 0.4.0, run `Developer: Reload Window`.** The Notes view changed format, and reloading enables its search field. `howm: Search All Text` and `howm: Search with Regular Expression` continue to open a picker.

Notes shows a date in `YYYY-MM-DD` format to the right of each title. A standalone `[YYYY-MM-DD HH:mm]` or `[YYYY-MM-DD]` line in the note takes precedence, followed by a date at the start of the filename and then the modification date. Reminder dates and dates in code blocks are not used as the note date. Hover to see the date’s source.

If clicking a note in a list, search, Calendar, or Todos does not open it on Windows, update to 0.4.1 or later. Earlier versions could treat the difference between a notes folder’s drive letter (`C:`) and a note URI’s drive letter (`c:`) as a location outside the notes folder and stop navigation. Version 0.4.1 compares both URIs in the same normalized form. Run `Developer: Reload Window` after updating.

If `No view is registered with id: howm.todos` appears just after an update, run `Developer: Reload Window` from the command palette. This reloads the sidebar registration in the workbench. Reload during development as well when changing view definitions in `package.json`.

Todos and Schedule uses the following groups. Completed reminders and empty groups are hidden.

- **Todos (by Priority)**: Todos whose start date has arrived, deadlines, notes to revisit, and deferred items. Expanded by default.
- **Upcoming Events and Deadlines**: Events from today onward and deadlines that have not yet entered the Todo group, in date order. Expanded by default. When a deadline enters its lead time, it moves into Todos instead of appearing in both groups.
- **Future Todos and Past Events**: Todos before their start date and past events. Collapsed by default.

Each item shows its text, date, and kind. Items without text display **No text**. Hover to see the note title, file location, and line number. Click to navigate to the original reminder line.

Deadlines (`!`) use orange text and icons from three days before the due date through the due date, and red starting the following day. Today’s events (`@`) are yellow. Todos (`+`), notes to revisit (`-`), and deferred items (`~`) use start dates and are not included in deadline coloring. Change the threshold with `howm.todos.dueSoonDays`; `0` means only the due date is orange. This setting is independent of each reminder’s lead time, such as `7` in `!7`, and does not affect ordering or grouping. Setting changes and date changes update the display automatically.

Customize each color through VS Code’s [`workbench.colorCustomizations`](https://code.visualstudio.com/api/references/theme-color). Light themes use darker shades for readability. Enable `explorer.decorations.colors` (default `true`) to color item text; icons remain colored when it is disabled. For example, add this to `settings.json`:

```json
{
  "howm.todos.dueSoonDays": 5,
  "workbench.colorCustomizations": {
    "howm.todoDueSoonForeground": "#FFA500",
    "howm.todoOverdueForeground": "#FF6666",
    "howm.scheduleTodayForeground": "#FFD700"
  }
}
```

Hover over an item and click its checkmark button to complete the reminder. Only that reminder is edited, even when you are working in another note. **Changes are not saved automatically.** Open the source note and save it normally. Undo in that note reverses completion. If the note has changed since the row was displayed, the list refreshes and asks you to try again.

Edits and external changes are reflected automatically. The notes folder is also rescanned when the sidebar is shown again or VS Code regains focus. While visible, the sidebar checks the date every minute and updates priorities and groups after a date change. Loading can take time with many notes.

If items are missing, check the view’s message and the notes folder. By default, `.md` files under the workspace’s `howm/` folder are included. Use the title-bar refresh button to retry or the folder button to select another location. Loading failures are shown in the view.

### Viewing reminders in a picker

`howm: Show Todos and Schedule` opens a picker with a filter field and items below it. It uses the same groups as the sidebar without duplicating reminders. The title shows note and reminder counts. **Review Future Todos and Past Events** lets you access inactive and past items. The notes folder is rescanned whenever the picker opens, and **Rebuild Index and Refresh** lets you refresh it again.

### Examples

Write each reminder on its own line in the note body. Do not put spaces between the closing date bracket and the symbol, or between the symbol and its number.

```text
[2026-10-12]@ Weekly team meeting
[2026-10-08]+ Tidy the room
[2026-10-08]+14 Read the book I started
[2026-10-15]!7 Submit the prototype
[2026-10-08]-3 Revisit an interesting article
[2026-10-08]~30 Consider buying a new keyboard
[2026-10-08]. Updated the README
```

- `@`: Appears as an October 12 event in Upcoming Events and Deadlines.
- `+`: Appears in Todos starting October 8 and gains priority over time. `+14` rises more slowly than the default seven-day `+`.
- `!7`: Gains Todo priority from October 8, seven days before the October 15 deadline. Remains near the top after the deadline until completed.
- `-3`: Rises on October 8 and loses priority over roughly three days. It is not automatically removed from the list.
- `~30`: Priority oscillates with a 30-day period starting October 8. It does not automatically create new events.
- `.`: Already complete, so it is excluded from Todos and Schedule.

Put reminders in the note body. Reminders inside code blocks are not recognized.

Run `howm: Complete Reminder on This Line` on the source line to mark it complete while retaining its original date and kind as history. `howm: Change Date on This Line` and `howm: Insert Today’s Date` are also available. These are ordinary editor changes: they support Undo and require normal saving. There are no OS or background notifications.

For example, completing this deadline on October 14 preserves both the completion date and the original deadline.

Before:

```text
[2026-10-15]!7 Submit the prototype
```

After:

```text
[2026-10-14]. [2026-10-15]:!7 Submit the prototype
```

### Entering dates

Run `howm: Enter Date` from the command palette to interpret an input and insert `[YYYY-MM-DD]` at the cursor. It replaces a selection and applies the same date to all cursors or selections. Press Enter on an empty field to use today, or Escape to cancel without changes.

Examples when today is November 5, 2026:

| Input                    | Inserted date                                  |
| ------------------------ | ---------------------------------------------- |
| Empty, `0`, `today`      | `[2026-11-05]`                                 |
| `tomorrow`, `+1`         | `[2026-11-06]`                                 |
| `+7`                     | `[2026-11-12]`                                 |
| `15`                     | `[2026-11-15]`                                 |
| `3`                      | `[2026-12-03]`                                 |
| `31`                     | `[2026-12-31]`                                 |
| `12/5`, `12-5`           | `[2026-12-05]`                                 |
| `1/10`                   | `[2027-01-10]`                                 |
| `2/29`                   | `[2028-02-29]`                                 |
| `2027/2/20`, `2027-2-20` | `[2027-02-20]`                                 |
| `2025/1/1`               | `[2025-01-01]`                                 |
| `thu`, `fri`, `mon`      | `[2026-11-05]`, `[2026-11-06]`, `[2026-11-09]` |

When the year or month is omitted, the nearest matching date on or after today is used, including today if it matches. A day missing from the current month is found in a later month; `2/29` selects the next valid leap day. `+N` means N days from today, while a number on its own specifies a day of the month. Use a full year/month/day for past dates. Weekdays `mon` through `sun` are supported. Inputs ignore letter case and surrounding whitespace. Invalid dates and unrecognized inputs show an error in the input field.

`howm: Change Date on This Line` accepts the same date inputs while preserving the reminder kind, lead time, text, and history. Both commands use local calendar days, support Undo, and do not save automatically. `howm: Insert Today’s Date` inserts today’s date directly without an input field.

## Similar Notes and On This Day

Similar Notes and On This Day are initially collapsed in the sidebar. Expand them to use them. Click a title to navigate to the source heading, or use the title-bar refresh button to update manually. If the views do not appear after an update, run `Developer: Reload Window`.

### Similar Notes

Shows up to ten notes similar to the title and body of the note at the current cursor, ranked by similarity and displayed with their dates. No `<<<` declarations or `>>>` links are required; it works alongside `howm: Show Related Notes`. Other notes in the same file and notes with identical titles remain separate, while the current note itself is excluded. If the cursor is outside the howm notes folder or before the first heading, the view asks you to select a note.

Similarity uses TF-IDF and cosine similarity over character 2-grams and 3-grams and alphanumeric words after Unicode NFKC normalization and lowercasing, without Japanese word segmentation. Titles receive three times the body weight. Dates, Markdown formatting, and some common words are excluded. Short matches and fragments common throughout the corpus are adjusted to reduce excessive scores. Scores range from 0 to 1. No external AI, API, or network requests are used.

The target changes when the cursor moves to another note. Edits are reflected after 500 ms, including unsaved changes, Undo, edits to other notes, and external modifications, additions, or deletions. If `howm.similarNotes.autoRefresh` is disabled, use the refresh button. Setting changes and showing the view again also refresh the results. An empty state is shown when no candidates match.

### On This Day

Shows notes written on the same local month and day in previous years, grouped by year from newest to oldest. The current year and future years are excluded. Year groups can be collapsed, and there is no result limit. Within a year, notes keep their regular note-list order.

Dates follow the same rules as Notes and Calendar: a standalone timestamp line in the note, a date at the start of the filename, then the modification date. Reminder dates and dates in code are excluded. February 29 notes appear only on February 29. While visible, the view shares the Todo sidebar’s one-minute date check. Index updates, showing the view again, and manual refresh also update it.

Both features share the existing note index without adding separate file scans or a persistent cache. Similarity features are held in memory and recalculated only for changed notes. Document frequency is tracked per note across its title and body; corpus changes update IDF and vector lengths. Rendering and similarity computation stop while hidden, and the index and cache are synchronized when shown again. Features for deleted or replaced notes are discarded during synchronization; disabling the feature or deactivating the extension also clears the search cache. Large computations periodically yield to event handling, and obsolete results are ignored. Initial computation time and memory use depend on note count and text volume.

Clicking a stale item after an edit asks you to select again, as with the regular note list. The current index and source text are checked before opening, so moved headings are not opened at obsolete positions. Notes are not rewritten or saved automatically.

## Related Passages

Related Passages uses text near the cursor to find related writing in past notes. The view starts collapsed in the sidebar. Whereas Similar Notes compares whole titles and bodies, Related Passages can find relevant sections buried in long notes. It works while reading an unmodified note or editing unsaved text in a new note. The active editor must be a Markdown file inside the howm notes folder.

The query uses five lines before and after the cursor, up to eleven lines in total. Context stays within the same note and heading section, expanding when needed to collect enough prose. Blank lines inside lists do not break the context. Code blocks are excluded; when the cursor is in code, surrounding prose from the same section is used. Markdown formatting, link destination URLs, timestamps, and reminder markers are removed. Formatting-only and URL-only lines are not used. Searches require at least 30 effective characters of prose, and queries are limited to 4,000 characters.

Notes are indexed with sliding windows of five effective body lines, advancing two lines at a time. Short trailing windows are included. Windows do not cross note or heading boundaries, and blank lines and code are not counted. Normalization, feature extraction, and short-match adjustments are shared with Similar Notes, but TF-IDF document frequency is tracked separately per passage. No external AI, API, network requests, or additional AI models are used. Similar Notes rankings and settings are unaffected.

Up to ten results appear in relevance order, showing the title, date, line number, and an excerpt of about three lines. Excerpts prioritize relevant lines within the passage and truncate long text. Overlapping passages in the same note are merged into the strongest result; distant related passages remain separate. The current note is excluded, but other notes in the same file are searched. Hover to see the file location and similarity score.

Click a result to open the original file, select the passage, and move the cursor to its starting line. If the source has changed, the current index and text are checked and you are asked to select again. Navigation does not use stale line numbers or save automatically.

Results refresh 500 ms after cursor movement or typing. Movement that produces the same query skips recalculation. Unsaved edits, Undo/Redo, added or deleted notes, and external changes are reflected. Showing the view again, changing settings, or clicking the title-bar refresh button also updates it. When `howm.relatedPassages.autoRefresh` is disabled, use the refresh button.

The feature uses the existing note index and change monitoring instead of scanning all files whenever a note opens. Features are held in memory, and passages are rebuilt only for changed notes. Changing the window length or step rebuilds the passage index. Searching stops while hidden, then synchronizes with the latest index when shown again. Large computations yield to event handling and discard obsolete results. There can be more passages than notes, so initial computation time and memory use depend on text volume and settings. The index is not persisted to disk.

## Settings

| Setting                               | Default and meaning                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `howm.notesDirectory`                 | `howm` inside the workspace. Supports absolute paths, `~/`, and relative paths.                                                                 |
| `howm.filenamePattern`                | `{YYYY}/{MM}/{YYYY}-{MM}-{DD}-{HH}{mm}{ss}.md`                                                                                                  |
| `howm.defaultTitle`                   | `メモ`. Default title for new notes; an empty string leaves it blank. Selected text takes precedence.                                           |
| `howm.template`                       | Title, timestamp, and body. Supports `{title}`, `{date}`, `{time}`, and `{body}`.                                                               |
| `howm.maxFileSizeKB`                  | `1024` (minimum `1`). Files exceeding this limit are excluded when read from disk.                                                              |
| `howm.calendarWeekStart`              | `sunday`. Use `monday` to start the week on Monday.                                                                                             |
| `howm.todos.dueSoonDays`              | `3` (minimum `0`). Days before a deadline to start displaying it in orange. `0` means the due date only.                                        |
| `workbench.colorCustomizations`       | Customize `howm.todoDueSoonForeground` (due soon), `howm.todoOverdueForeground` (overdue), and `howm.scheduleTodayForeground` (today’s events). |
| `howm.similarNotes.enabled`           | `true`. Enable or disable Similar Notes.                                                                                                        |
| `howm.similarNotes.maxResults`        | `10` (minimum `1`). Maximum similar notes to display.                                                                                           |
| `howm.similarNotes.minSimilarity`     | `0.1` (range `0`–`1`). Minimum similarity to display.                                                                                           |
| `howm.similarNotes.autoRefresh`       | `true`. Automatically refresh after edits or switching notes.                                                                                   |
| `howm.onThisDay.enabled`              | `true`. Enable or disable On This Day.                                                                                                          |
| `howm.relatedPassages.enabled`        | `true`. Enable or disable Related Passages.                                                                                                     |
| `howm.relatedPassages.maxResults`     | `10` (minimum `1`). Maximum passages to display.                                                                                                |
| `howm.relatedPassages.minSimilarity`  | `0.15` (range `0`–`1`). Minimum similarity to display.                                                                                          |
| `howm.relatedPassages.contextLines`   | `5` (minimum `0`). Lines to collect before and after the cursor.                                                                                |
| `howm.relatedPassages.windowLines`    | `5` (minimum `1`). Effective body lines per passage.                                                                                            |
| `howm.relatedPassages.windowStep`     | `2` (minimum `1`). Lines to advance between windows, limited to `windowLines`.                                                                  |
| `howm.relatedPassages.minQueryLength` | `30` (minimum `1`). Minimum query length after removing formatting and whitespace.                                                              |
| `howm.relatedPassages.autoRefresh`    | `true`. Automatically search after cursor movement, edits, or index updates.                                                                    |

`howm.filenamePattern` supports `{YYYY}` (year), `{MM}` (month), `{DD}` (day), `{HH}` (hour), `{mm}` (minute), and `{ss}` (second). All fields except the year use two digits. Use a relative path inside the notes folder with a `.md` extension. Absolute paths, `.` or `..` segments, empty path segments, backslashes, colons, and control characters are not allowed. Existing filenames receive a sequence suffix.

The size limit applies per file regardless of how many notes it contains. Unsaved edits enter the index without the size check; reloading after a save applies the limit. Ordinary Markdown files remain the source of truth, and the index is regenerated in memory. External edits and unsaved editor changes are reflected. Hidden directories, `node_modules`, and symbolic links are excluded from the initial scan. The sidebar’s regular Notes list shows the most recent 200 notes, Show Recent Notes shows 50, and List Notes gives access to all notes. In a multi-root workspace, the first folder supplies the default notes location.

## Importing existing Markdown files

The repository’s `scripts/import-markdown.pl` takes a destination folder as its first argument and input files as subsequent arguments. It derives folders and filenames from the leading `YYYYMMDD` in each input filename. Only standard Perl modules are required.

```sh
perl scripts/import-markdown.pl ./howm ./old-notes/20261012-note.md ./old-notes/20261013-note.md
```

Files are saved under `destination/YYYY/MM/YYYY-MM-DD-HHMMSS.md`. The input file’s ctime is converted to **JST (UTC+09:00)**. If that date matches the filename date, its hours, minutes, and seconds are used; otherwise the time is `000000`. Results do not depend on the system timezone, and no `TZ` setting is needed. ctime is the file metadata change time returned by Perl’s `stat`.

For example, `20261012-note.md` with a ctime of October 12, 2026 at 09:30:45 JST is copied to `2026/10/2026-10-12-093045.md`. If its ctime falls on a different date, it is copied to `2026/10/2026-10-12-000000.md`.

Source files are retained. UTF-8 Markdown text, headings, BOMs, and line endings are copied unchanged. Year and month folders are created automatically. If a destination already exists, suffixes such as `-1.md` and `-2.md` are added without overwriting. Running the import again also creates numbered copies.

Invalid dates, missing files, directories, and inputs that cannot be read as UTF-8 are reported while processing continues. The tool prints input-to-output mappings and success/failure counts. Exit codes are `0` when all files succeed, `1` when at least one fails, and `2` for usage errors such as missing arguments. Use `--help` for usage information.

After copying, run `howm: Select Notes Folder` and select the destination folder. If it is already the active notes folder, changes appear automatically; use `howm: Rebuild Index` if needed. A timestamp line in a note takes precedence over the output filename’s date. `howm.maxFileSizeKB` still applies.

This is a standalone repository tool and is not included in the VSIX. Run `npm run test:import` for the Perl tests and tests that parse imported files with the extension’s note parser.

## Development and limitations

Run `npm test` for type checking and core tests. `npm run test:integration` runs tests in a separate VS Code profile; on platforms other than macOS, set `VSCODE_EXECUTABLE` to the executable path. The extension targets desktop VS Code and does not support VS Code for the Web. It does not include Emacs Lisp, the legacy howm file format, Wiki links, Migemo, or Markdown preview integration.

howm: https://kaorahi.github.io/howm/

## Display language and translation maintenance

The UI follows VS Code’s display language automatically: Japanese for Japanese, and English for English and unsupported languages. There is no extension-specific language setting. To switch languages, run VS Code’s `Configure Display Language` command and restart the window.

Command, view, and setting text lives in `package.nls.json` (English) and `package.nls.ja.json` (Japanese). `package.json` references stable keys such as `%howm.create.title%`. Keep these keys when changing the displayed wording.

Use VS Code’s `vscode.l10n.t("English message")` for runtime text. Include variables in complete messages, such as `vscode.l10n.t("Notes for {0} ({1})", date, count)`, and use static English string literals so messages can be extracted. Translate webview text in the extension host and escape it before inserting it into HTML. Use `scriptString()` for text embedded in scripts. Preserve the CSP and existing message formats.

```sh
npm run l10n:extract
# Manually translate additions and changes in l10n/bundle.l10n.ja.json
npm run l10n:check
npm test
```

`l10n:extract` uses `@vscode/l10n-dev` to regenerate only the English source bundle, `l10n/bundle.l10n.json`, without overwriting manual Japanese translations. `l10n:check` detects source/bundle differences, missing or unused translations, and placeholder mismatches. It also runs during `npm test` and `npm run package`. Both `package.nls*.json` files and `l10n/*.json` files are included in the VSIX.

Do not translate note text, titles, user input, command IDs, setting keys or values, storage formats, date parsing, or search terms. For example, `howm.defaultTitle` retains its `メモ` default because it affects created data. Fixed strings in `core.ts`, `todo-model.ts`, and the search worker remain independent of VS Code and are translated at the display boundary in `src/localization.ts` to preserve model compatibility. External details such as communication errors retain their original wording. The standalone Perl importer’s CLI messages are outside the VS Code UI localization scope.

To add another language, create `package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json`, then update the date-display locale handling in `src/localization.ts`. Translation checks cover additional language files automatically.

Tests in VS Code use a temporary profile:

```sh
npm run test:integration
node scripts/integration.cjs --l10n --locale=en
VSCODE_TEST_EXTENSIONS_DIR=/path/to/test-extensions node scripts/integration.cjs --l10n --locale=ja
VSCODE_TEST_EXTENSIONS_DIR=/path/to/test-extensions node scripts/integration.cjs --l10n --locale=fr
```

Before running Japanese or French tests in VS Code, install the corresponding VS Code language pack in the specified test extensions directory. Tests fail if the requested language is not active. Automated tests check displayed text, webview HTML, pin actions, date formatting, and existing functionality. Also check long notifications and setting descriptions in both languages, narrow sidebars, and accessibility labels in the actual UI.

Localization API and extraction tool references: [VS Code API](https://code.visualstudio.com/api/references/vscode-api#l10n), [vscode-l10n](https://github.com/microsoft/vscode-l10n).
