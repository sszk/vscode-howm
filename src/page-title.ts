import * as http from "http";
import * as https from "https";
import { lookup } from "dns/promises";
import { isIP } from "net";
import ipaddr from "ipaddr.js";
import { Parser } from "htmlparser2";

export const TITLE_TIMEOUT_MS = 3000;
export const MAX_HTML_BYTES = 512 * 1024;

export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.range() !== "unicast") return false;
    // Exclude IPv6 transition mechanisms that can reach non-public IPv4 hosts.
    if (parsed.kind() === "ipv6") {
      const first = parsed.toByteArray();
      return (
        first[0] >= 0x20 &&
        first[0] <= 0x3f &&
        !(
          first[0] === 0x20 &&
          (first[1] === 0x02 ||
            (first[1] === 0x01 && first[2] === 0 && first[3] === 0))
        )
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function titleFromHtml(
  bytes: Buffer,
  contentType: string,
): string | undefined {
  const head = bytes.subarray(0, 4096).toString("latin1");
  const headerCharset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(
    contentType,
  )?.[1];
  const metaCharset = /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s"'/>;]+)/i.exec(
    head,
  )?.[1];
  let html: string;
  try {
    const bom =
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? "utf-8"
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? "utf-16le"
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? "utf-16be"
            : undefined;
    html = new TextDecoder(
      bom || headerCharset || metaCharset || "utf-8",
    ).decode(bytes);
  } catch {
    html = bytes.toString("utf8");
  }
  let title = "",
    og = "",
    insideTitle = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title" && !title) insideTitle = true;
        if (
          name === "meta" &&
          (attrs.property || attrs.name)?.toLowerCase() === "og:title" &&
          !og
        )
          og = attrs.content || "";
      },
      ontext(text) {
        if (insideTitle) title += text;
      },
      onclosetag(name) {
        if (name === "title") insideTitle = false;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  const clean = (value: string) =>
    value.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
  // Bound subsequent document edits even when a site returns an enormous title.
  return (clean(title) || clean(og)).slice(0, 4096) || undefined;
}

async function requestPage(
  url: URL,
  signal: AbortSignal,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    /(^|\.)(localhost|local|internal|lan|home)\.?$/i.test(hostname)
  )
    throw new Error("Non-public host");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    signal.aborted ||
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new Error("Non-public address");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        signal,
        // Validate once, then connect to that exact IP to prevent DNS rebinding.
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [pinned])
            : callback(null, pinned.address, pinned.family),
        agent: false,
        headers: {
          Accept: "text/html, application/xhtml+xml",
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        const headers = response.headers;
        if (
          [301, 302, 303, 307, 308].includes(status) ||
          status < 200 ||
          status >= 300 ||
          !/^(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(
            headers["content-type"] || "",
          ) ||
          (headers["content-encoding"] &&
            headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          resolve({ status, headers, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          const remaining = MAX_HTML_BYTES - size;
          chunks.push(chunk.subarray(0, remaining));
          size += Math.min(remaining, chunk.length);
          if (size >= MAX_HTML_BYTES) {
            resolve({ status, headers, body: Buffer.concat(chunks) });
            response.destroy();
          }
        });
        response.on("end", () =>
          resolve({ status, headers, body: Buffer.concat(chunks) }),
        );
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Response aborted")));
      },
    );
    request.on("error", reject);
  });
}

/** All failures deliberately leave the provisional hostname label intact. */
export async function fetchPageTitle(
  input: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async () => {
      let url = new URL(input);
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (!/^https?:$/.test(url.protocol) || controller.signal.aborted)
          return;
        const page = await requestPage(url, controller.signal);
        if ([301, 302, 303, 307, 308].includes(page.status)) {
          if (!page.headers.location || redirects === 5) return;
          url = new URL(page.headers.location, url);
          continue;
        }
        return page.body.length
          ? titleFromHtml(page.body, page.headers["content-type"] || "")
          : undefined;
      }
    };
    const aborted = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
      if (controller.signal.aborted) resolve(undefined);
      timer = setTimeout(abort, TITLE_TIMEOUT_MS);
    });
    return await Promise.race([work(), aborted]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
