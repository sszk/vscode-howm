const { test } = require("node:test");
const assert = require("node:assert/strict");
const { singleWebUrl, webLink } = require("../dist/markdown-link");
const { codeRegions, touchesCode } = require("../dist/paste-code");
const MarkdownIt = require("markdown-it");

test("only a complete single HTTP(S) URL is accepted, preserving its spelling", () => {
  for (const input of [
    "https://example.com/資料?q=日本語",
    "HTTP://Example.COM/a",
    "http://127.0.0.1/a",
  ])
    assert.equal(singleWebUrl(` \n${input}\r\n `), input);
  for (const input of [
    "",
    "text",
    "[name](https://example.com)",
    "file:///a.md",
    "ftp://example.com",
    "https://",
    "https://example.com\nhttps://other.com",
    "https://example.com x",
    "https://exa mple.com",
    "https://example.com/\u0000",
  ])
    assert.equal(singleWebUrl(input), undefined, JSON.stringify(input));
});

test("labels and URL delimiters survive Markdown parsing as literal text", () => {
  const md = new MarkdownIt();
  const title = "C++ [入門] (基礎編) *bold* `code` <tag> &copy; \\";
  const link = webLink(title, "https://example.com/資料(a))?q=<tag>&v=%20");
  assert.ok(link.includes("資料%28a%29%29"));
  assert.ok(link.includes("%3Ctag%3E"));
  const children = md.parse(link, {})[1].children;
  assert.deepEqual(
    children.map((item) => item.type),
    ["link_open", "text", "link_close"],
  );
  assert.equal(children[1].content, title);
});

test("entity-shaped URL text and multiline selections retain valid link semantics", () => {
  const md = new MarkdownIt();
  const link = webLink(
    "first\n\nsecond",
    "https://example.com/?a=1&copy;=2&#123;",
  );
  const children = md.parse(link, {})[1].children;
  assert.equal(
    children[0].attrGet("href"),
    "https://example.com/?a=1&copy;=2&#123;",
  );
  assert.equal(children[1].content, "first  second");
});

test("fences, nested fences, indented code and multiline inline code are excluded", () => {
  for (const text of [
    "```js\nHERE\n```\n",
    "~~~\nHERE\n~~~~\n",
    "```\nHERE",
    "> ```\n> HERE\n> ```\n",
    "- item\n\n  ```\n  HERE\n  ```\n",
    "    HERE\n",
    "prefix `HERE` suffix",
    "``a ` HERE``",
    "`a\nHERE`",
  ]) {
    const at = text.indexOf("HERE");
    assert.equal(touchesCode(codeRegions(text), at, at), true, text);
    assert.equal(touchesCode(codeRegions(text), at, at + 4), true, text);
  }
  for (const text of [
    "plain HERE",
    "\\`HERE`",
    "`unmatched HERE",
    "```\ncode\n```\nHERE",
    "`code` HERE",
  ])
    assert.equal(
      touchesCode(
        codeRegions(text),
        text.indexOf("HERE"),
        text.indexOf("HERE"),
      ),
      false,
      text,
    );
  assert.equal(
    touchesCode(codeRegions("```\n"), 4, 4),
    true,
    "EOF inside an unfinished fence",
  );
  for (const text of ["```\nx\n```\n", "> ```\n> x\n> ```\n", "    code\n"])
    assert.equal(
      touchesCode(codeRegions(text), text.length, text.length),
      false,
      "EOF after closed code: " + text,
    );
});
