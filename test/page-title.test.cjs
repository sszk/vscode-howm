const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns/promises");
const {
  publicAddress,
  titleFromHtml,
  fetchPageTitle,
  MAX_HTML_BYTES,
} = require("../dist/page-title");

const html = (value, type = "text/html") =>
  titleFromHtml(Buffer.from(value), type);
test("HTML titles have priority over OG, entities decode, whitespace collapses", () => {
  assert.equal(
    html(
      '<meta property="og:title" content="OG"><title> 日本語 &amp; &#x1F600;\n  title </title>',
    ),
    "日本語 & 😀 title",
  );
  assert.equal(
    html(
      '<meta content="OG &quot;title&quot;" property="og:title"><title> </title>',
    ),
    'OG "title"',
  );
  assert.equal(
    html(
      '<!-- <title>wrong</title> --><script>"<title>wrong</title>"</script><TITLE>Right</TITLE>',
    ),
    "Right",
  );
  assert.equal(html("<p>No title</p>"), undefined);
  assert.equal(html(`<title>${"a".repeat(6000)}</title>`).length, 4096);
});

test("legacy header/meta encodings and BOM are decoded", () => {
  const sjis = Buffer.concat([
    Buffer.from('<meta charset="Shift_JIS"><title>'),
    Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]),
    Buffer.from("</title>"),
  ]);
  assert.equal(titleFromHtml(sjis, "text/html"), "日本語");
  assert.equal(titleFromHtml(sjis, "text/html; charset=Shift_JIS"), "日本語");
  assert.equal(
    titleFromHtml(
      Buffer.from("<title>café</title>", "latin1"),
      "text/html; charset=windows-1252",
    ),
    "café",
  );
  assert.equal(
    titleFromHtml(
      Buffer.from("\ufeff<title>日本語</title>", "utf16le"),
      "text/html",
    ),
    "日本語",
  );
});

test("non-public addresses, mapped IPv4 and transition ranges are blocked", () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "2002:a00:1::",
    "2001:db8::1",
    "bad",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888"])
    assert.equal(publicAddress(ip), true, ip);
});

function network(
  t,
  pages,
  addresses = [{ address: "93.184.216.34", family: 4 }],
) {
  const calls = [];
  t.mock.method(dns, "lookup", async () => addresses);
  const get = (url, options, callback) => {
    calls.push({ url, options });
    const request = new EventEmitter();
    options.signal.addEventListener(
      "abort",
      () => request.emit("error", new Error("aborted")),
      { once: true },
    );
    queueMicrotask(() => {
      const page = pages[calls.length - 1];
      if (page instanceof Error) {
        request.emit("error", page);
        return;
      }
      if (!page || options.signal.aborted) return;
      const response = Readable.from(
        page.chunks || [Buffer.from(page.body || "")],
      );
      response.statusCode = page.status || 200;
      response.headers = page.headers || { "content-type": "text/html" };
      callback(response);
    });
    return request;
  };
  t.mock.method(http, "get", get);
  t.mock.method(https, "get", get);
  return calls;
}

test("HTTP/HTTPS titles use a pinned validated address without credentials", async (t) => {
  const calls = network(t, [
    { body: "<title>HTTP</title>" },
    { body: "<title>HTTPS</title>" },
  ]);
  assert.equal(await fetchPageTitle("http://example.com"), "HTTP");
  assert.equal(await fetchPageTitle("https://example.com"), "HTTPS");
  for (const { options } of calls) {
    options.lookup("example.com", {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
    });
    options.lookup("example.com", { all: true }, (error, addresses) => {
      assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
    });
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
  }
});

test("redirects follow relative HTTP(S) locations and stop after five hops", async (t) => {
  const calls = network(t, [
    ...Array.from({ length: 5 }, () => ({
      status: 302,
      headers: { location: "/next" },
    })),
    { body: "<title>Final</title>" },
  ]);
  assert.equal(await fetchPageTitle("https://example.com"), "Final");
  assert.equal(calls.length, 6);
  calls.length = 0;
  const get = https.get;
  // A sixth redirect cannot be followed.
  t.mock.method(https, "get", (url, options, callback) =>
    get(url, options, (response) => {
      response.statusCode = 302;
      response.headers.location = "/next";
      callback(response);
    }),
  );
  assert.equal(await fetchPageTitle("https://example.com"), undefined);
  assert.equal(calls.length, 6);
});

test("local destinations, DNS results, credentials and unsafe redirects never connect", async (t) => {
  const calls = network(t, [
    { status: 302, headers: { location: "http://127.0.0.1" } },
  ]);
  for (const url of [
    "file:///a",
    "http://localhost",
    "http://host.local",
    "http://127.1",
    "http://2130706433",
    "http://[::1]",
    "https://user:password@example.com",
  ])
    assert.equal(await fetchPageTitle(url), undefined, url);
  assert.equal(calls.length, 0);
  assert.equal(await fetchPageTitle("https://example.com"), undefined);
  assert.equal(calls.length, 1);
  calls.length = 0;
  t.mock.method(dns, "lookup", async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  assert.equal(await fetchPageTitle("https://mixed.example"), undefined);
  assert.equal(calls.length, 0);
});

test("redirect targets reject non-HTTP schemes and freshly resolved private IPs", async (t) => {
  const calls = network(t, [
    { status: 302, headers: { location: "file:///private/file" } },
  ]);
  assert.equal(await fetchPageTitle("https://example.com"), undefined);
  assert.equal(calls.length, 1);
  calls.length = 0;
  let lookups = 0;
  t.mock.method(dns, "lookup", async () => [
    { address: lookups++ === 0 ? "8.8.8.8" : "10.0.0.1", family: 4 },
  ]);
  const get = https.get;
  t.mock.method(https, "get", (url, options, callback) =>
    get(url, options, (response) => {
      response.headers.location = "https://private.example/";
      callback(response);
    }),
  );
  assert.equal(await fetchPageTitle("https://example.com"), undefined);
  assert.equal(lookups, 2);
  assert.equal(
    calls.length,
    1,
    "a private redirect is rejected before connecting",
  );
});

test("DNS and network errors, non-HTML, HTTP errors and compressed bodies fall back", async (t) => {
  network(t, [
    new Error("offline"),
    { status: 404, body: "<title>Bad</title>" },
    { headers: { "content-type": "image/png" }, body: "<title>Bad</title>" },
    {
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
      body: "<title>Bad</title>",
    },
  ]);
  for (let i = 0; i < 4; i++)
    assert.equal(await fetchPageTitle("https://example.com"), undefined);
  t.mock.method(dns, "lookup", async () => {
    throw new Error("ENOTFOUND");
  });
  assert.equal(await fetchPageTitle("https://nonexistent.example"), undefined);
});

test("HTML download stops at its byte budget", async (t) => {
  network(t, [
    {
      chunks: [
        Buffer.from(" ".repeat(MAX_HTML_BYTES)),
        Buffer.from("<title>Too late</title>"),
      ],
    },
  ]);
  assert.equal(await fetchPageTitle("https://example.com"), undefined);
});

test("the three-second deadline includes DNS, and caller cancellation returns promptly", async (t) => {
  const calls = network(t, []);
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = fetchPageTitle("https://slow.example");
  t.mock.timers.tick(3000);
  assert.equal(await result, undefined);
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  const cancelled = fetchPageTitle("https://slow.example", controller.signal);
  controller.abort();
  assert.equal(await cancelled, undefined);
});
