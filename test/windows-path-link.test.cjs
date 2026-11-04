const { test } = require("node:test");
const assert = require("node:assert/strict");
const { windowsPathLink } = require("../dist/windows-path-link");

test("absolute Windows paths retain readable Unicode, drive letters and hierarchy on every OS", () => {
  for (const [input, expected] of [
    [String.raw`C:\dir\file.txt`, "[file.txt](file:///C:/dir/file.txt)"],
    [
      String.raw`C:\共有資料\基本設計\設計書.pdf`,
      "[設計書.pdf](file:///C:/共有資料/基本設計/設計書.pdf)",
    ],
    [
      String.raw`d:\中文\한국어\📄.pdf`,
      "[📄.pdf](file:///d:/中文/한국어/📄.pdf)",
    ],
    ["C:/資料/設計 書.pdf", "[設計 書.pdf](file:///C:/資料/設計%20書.pdf)"],
    [
      String.raw`C:\資料/sub\file.txt`,
      "[file.txt](file:///C:/資料/sub/file.txt)",
    ],
    [
      String.raw` "C:\資料\設計書.pdf" `,
      "[設計書.pdf](file:///C:/資料/設計書.pdf)",
    ],
    ["C:\\", "[C:](file:///C:/)"],
    ["C:\\資料\\", "[資料](file:///C:/資料/)"],
  ])
    assert.equal(windowsPathLink(input), expected, input);
});

test("UNC paths retain server spelling, Japanese share/folder names and folder roots", () => {
  for (const [input, expected] of [
    [
      String.raw`\\Server\share\file.txt`,
      "[file.txt](file://Server/share/file.txt)",
    ],
    [
      String.raw`\\server\共有資料\基本 設計\設計書.pdf`,
      "[設計書.pdf](file://server/共有資料/基本%20設計/設計書.pdf)",
    ],
    [
      String.raw`\\サーバー\共有\資料.pdf`,
      "[資料.pdf](file://サーバー/共有/資料.pdf)",
    ],
    ["//Server/共有/", "[共有](file://Server/共有/)"],
    [String.raw`\\server\共有`, "[共有](file://server/共有)"],
  ])
    assert.equal(windowsPathLink(input), expected, input);
});

test("file URI parsing decodes valid UTF-8 per segment and preserves its authority", () => {
  for (const [input, expected] of [
    [
      "file:///C:/%E8%B3%87%E6%96%99/%E8%A8%AD%E8%A8%88%20%E6%9B%B8.pdf",
      "[設計 書.pdf](file:///C:/資料/設計%20書.pdf)",
    ],
    ["FILE:///c:/資料/設計書.pdf", "[設計書.pdf](file:///c:/資料/設計書.pdf)"],
    [
      "file://Server/%E5%85%B1%E6%9C%89/file.txt",
      "[file.txt](file://Server/共有/file.txt)",
    ],
    ["file://localhost/C:/a.txt", "[a.txt](file://localhost/C:/a.txt)"],
    ["file://[::1]/share/a.txt", "[a.txt](file://[::1]/share/a.txt)"],
    ["file:/C:/dir/file.txt", "[file.txt](file:///C:/dir/file.txt)"],
    ["file:///tmp/資料.txt", "[資料.txt](file:///tmp/資料.txt)"],
    ["file:///", "[/](file:///)"],
  ])
    assert.equal(windowsPathLink(input), expected, input);
});

test("raw Windows percent sequences are literal while URI escapes are decoded exactly once", () => {
  for (const [input, expected] of [
    [
      String.raw`C:\資料\設計%20書.pdf`,
      "[設計%20書.pdf](file:///C:/資料/設計%2520書.pdf)",
    ],
    [
      String.raw`\\server\共有\100%.txt`,
      "[100%.txt](file://server/共有/100%25.txt)",
    ],
    [String.raw`C:\a%ZZ.txt`, "[a%ZZ.txt](file:///C:/a%25ZZ.txt)"],
    [
      "file:///C:/資料/設計%20書.pdf",
      "[設計 書.pdf](file:///C:/資料/設計%20書.pdf)",
    ],
    ["file:///C:/a%2520.txt", "[a%20.txt](file:///C:/a%2520.txt)"],
  ])
    assert.equal(windowsPathLink(input), expected, input);
});

test("URI reserved characters and Markdown punctuation are escaped without encoding Japanese", () => {
  assert.equal(
    windowsPathLink(String.raw`C:\資料\設計 #?%().pdf`),
    String.raw`[設計 #?%\(\).pdf](file:///C:/資料/設計%20%23%3F%25%28%29.pdf)`,
  );
  assert.equal(
    windowsPathLink("C:/資料/a[b]_`*<&copy;>!|~.txt"),
    String.raw`[a\[b\]\_\`\*\<\&copy;\>\!\|\~.txt](file:///C:/資料/a%5Bb%5D_%60%2A%3C%26copy%3B%3E%21%7C~.txt)`,
  );
  assert.equal(
    windowsPathLink("file:///C:/a%23b%3Fc%25%28d%29.txt"),
    String.raw`[a#b?c%\(d\).txt](file:///C:/a%23b%3Fc%25%28d%29.txt)`,
  );
});

test("encoded separators never become path hierarchy or a URI authority", () => {
  for (const [input, expected] of [
    ["file:///C:/資料/a%2fb.txt", "[a/b.txt](file:///C:/資料/a%2Fb.txt)"],
    [
      "file:///C:/資料/a%5cb.txt",
      String.raw`[a\\b.txt](file:///C:/資料/a%5Cb.txt)`,
    ],
    ["file:///C:/a%2F..%2Fb.txt", "[a/../b.txt](file:///C:/a%2F..%2Fb.txt)"],
    [
      "file:///C:/%2Fserver%2Fshare",
      "[/server/share](file:///C:/%2Fserver%2Fshare)",
    ],
    [
      "file://Server/share/dir%2Ffile.txt",
      "[dir/file.txt](file://Server/share/dir%2Ffile.txt)",
    ],
    ["file:///C:/a/%2e%2e/b.txt", "[b.txt](file:///C:/a/%2E%2E/b.txt)"],
  ])
    assert.equal(windowsPathLink(input), expected, input);
  assert.equal(
    windowsPathLink("file://server%2Fother/share/file.txt"),
    undefined,
  );
});

test("query/fragment structure stays separate from encoded filename punctuation", () => {
  assert.equal(
    windowsPathLink(
      "file:///C:/資料/doc%3F%23.md?x=1&y=a%26b#%E7%AB%A0%20%281%29",
    ),
    "[doc?#.md](file:///C:/資料/doc%3F%23.md?x=1&y=a%26b#章%20%281%29)",
  );
});

test("converting generated file URI destinations again gives identical Markdown", () => {
  for (const input of [
    String.raw`C:\資料\設計 書.pdf`,
    String.raw`C:\a%20#?()[].txt`,
    String.raw`\\Server\共有資料\file.txt`,
    "file:///C:/a%2Fb%5Cc.txt",
    "file:///C:/%E8%B3%87%E6%96%99/%F0%9F%93%84.pdf",
    "file:///C:/doc.md?x=a%26b#章%20%281%29",
    "file://ser(ver)/share/a.txt",
    "file:///C:/a/%2E%2E/b.txt",
  ]) {
    const link = windowsPathLink(input);
    assert.ok(link, input);
    const target = link.slice(link.lastIndexOf("](") + 2, -1);
    assert.equal(windowsPathLink(target), link, input);
  }
});

test("malformed URI percent escapes and UTF-8 are rejected without changing input", () => {
  for (const tail of [
    "%",
    "%2",
    "%GG",
    "%FF",
    "%C0%AF",
    "%E8%B3",
    "%ED%A0%80",
    "%F4%90%80%80",
  ]) {
    for (const uri of [
      `file:///C:/${tail}.txt`,
      `file://${tail}/share/a.txt`,
      `file:///C:/a.txt#${tail}`,
    ])
      assert.equal(windowsPathLink(uri), undefined, uri);
  }
});

test("relative paths, other URI schemes, malformed authorities and multiline inputs are rejected", () => {
  for (const input of [
    "",
    " ",
    "a.txt",
    String.raw`dir\a.txt`,
    String.raw`C:a.txt`,
    "C:",
    String.raw`\dir\a.txt`,
    "/tmp/a.txt",
    "https://example.com/a.txt",
    "untitled:a.txt",
    "file:C:a.txt",
    "file:///C:relative",
    "file://C:/dir/a.txt",
    "file://c|/dir/a.txt",
    "file://server:123/share/a.txt",
    "file://user@server/share/a.txt",
    String.raw`\\server`,
    "\\\\server\\",
    String.raw`\\?\C:\a.txt`,
    String.raw`file:///C:\dir\a.txt`,
    "C:/a\nb.txt",
    "C:/a\0b.txt",
    "file:///C:/a%00.txt",
    "C:/\ud800.txt",
  ])
    assert.equal(windowsPathLink(input), undefined, JSON.stringify(input));
});
