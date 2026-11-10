import { NETWORK_PURPOSE } from "@pimi/protocol/network-activity";
import { withNetworkInitiator } from "./network/activity.js";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";
import { Parser } from "htmlparser2";
import { z } from "zod";
import {
  isPimiArxivEmbed,
  isPimiVideoEmbed,
  isPimiXEmbed,
  parsePimiSpaceUrl,
} from "@pimi/protocol/pimi-task";

const MAX_RESPONSE_BYTES = 512 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; PimiLinkReader/1.0)";
const MAX_PREVIEW_TEXT = 8192;
const MAX_TITLE = 300;
export const SpaceLinkPreview = z.strictObject({
  title: z.string().max(MAX_TITLE),
  text: z.string().max(MAX_PREVIEW_TEXT),
  truncated: z.boolean(),
});
export type SpaceLinkPreview = z.infer<typeof SpaceLinkPreview>;

// Special-purpose networks (IANA), plus multicast and reserved IPv4 space.
const restricted = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  restricted.addSubnet(address, bits, "ipv4");
restricted.addAddress("168.63.129.16", "ipv4"); // Azure host platform services.
for (const [address, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  restricted.addSubnet(address, bits, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function publicAddress({ address, family }: { address: string; family: number }) {
  if (family === 4) return !restricted.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !restricted.check(address, "ipv6");
}

async function requestPage(
  url: URL,
  accept: string,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const { hostname } = url;
  if (
    url.port ||
    !hostname.includes(".") ||
    isIP(hostname) ||
    hostname.startsWith("[") ||
    /\.(?:localhost|local|internal|test|invalid|onion|home\.arpa)\.?$/i.test(hostname)
  )
    throw new Error("Link preview requires a public web address.");
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void lookup(hostname, { all: true })
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
  const first = addresses[0];
  if (!first || !addresses.every(publicAddress)) {
    throw new Error("Link preview requires a public IP address.");
  }
  const secure = url.protocol === "https:";
  const get = secure ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const request = get(
      {
        // Connect to the vetted address directly. Keep the original host for TLS and HTTP.
        hostname: first.address,
        path: url.pathname + url.search,
        ...(secure && { servername: hostname, rejectUnauthorized: true }),
        agent: false,
        signal,
        // Sites such as Wikipedia refuse requests that name no client.
        headers: {
          host: url.host,
          accept,
          "accept-encoding": "identity",
          "user-agent": USER_AGENT,
        },
      },
      resolve,
    );
    request.once("error", reject);
  });
}

async function readPage(
  start: URL,
  accept: string,
  signal: AbortSignal,
  maxBytes = MAX_RESPONSE_BYTES,
) {
  let url = start;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const target = url;
    const response = await withNetworkInitiator(NETWORK_PURPOSE.spaces, () =>
      requestPage(target, accept, signal),
    );
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.destroy();
      const next = parsePimiSpaceUrl(URL.parse(response.headers.location, url)?.href);
      if (!next || (url.protocol === "https:" && next.protocol !== "https:")) return null;
      url = next;
      continue;
    }
    const type = response.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
    const encoding = response.headers["content-encoding"];
    if (
      status !== 200 ||
      !type ||
      !accept.split(", ").includes(type) ||
      (encoding && encoding !== "identity")
    ) {
      response.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      chunks.push(chunk.subarray(0, maxBytes - bytes));
      bytes += chunk.length;
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
    }
    return { type, body: Buffer.concat(chunks).toString("utf8"), truncated };
  }
  return null;
}

const skippedElements = new Set([
  "aside",
  "footer",
  "header",
  "nav",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);
const blockElements = new Set([
  "article",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "li",
  "main",
  "p",
  "pre",
  "section",
  "td",
]);
const compact = (text: string) =>
  text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function htmlText(html: string, post: boolean) {
  const scope: { hidden: boolean; preferred: boolean }[] = [];
  let hidden = 0;
  let preferred = 0;
  let inHead = false;
  let inTitle = false;
  let title = "";
  let socialTitle = "";
  let description = "";
  let socialDescription = "";
  let body = "";
  let main = "";
  function captureMetadata(attrs: Record<string, string>) {
    const key = (attrs.property ?? attrs.name)?.toLowerCase();
    const value = attrs.content ?? "";
    if (key === "og:title" || key === "twitter:title") socialTitle ||= value;
    if (key === "og:description" || key === "twitter:description") socialDescription ||= value;
    if (key === "description") description ||= value;
  }
  function append(text: string) {
    if (hidden) return;
    if (inTitle) title += text;
    else if (!inHead) {
      body += text;
      if (preferred) main += text;
    }
  }
  new Parser({
    onopentag(name, attrs) {
      if (name === "head") inHead = true;
      if (name === "title" && inHead) inTitle = true;
      if (name === "meta" && inHead) captureMetadata(attrs);
      const frame = {
        hidden: skippedElements.has(name) || "hidden" in attrs || attrs["aria-hidden"] === "true",
        preferred: post ? name === "p" : name === "main" || name === "article",
      };
      scope.push(frame);
      if (frame.hidden) hidden += 1;
      if (frame.preferred) preferred += 1;
      if (blockElements.has(name)) append("\n");
    },
    ontext: append,
    onclosetag(name) {
      if (blockElements.has(name) && name !== "br") append("\n");
      if (name === "head") inHead = false;
      if (name === "title") inTitle = false;
      const frame = scope.pop();
      if (frame?.hidden) hidden -= 1;
      if (frame?.preferred) preferred -= 1;
    },
  }).end(html);
  return {
    title: socialTitle || title,
    text: compact(main) || (!post && compact(body)) || socialDescription || description,
  };
}

function makePreview(title: string, text: string, truncated: boolean): SpaceLinkPreview | null {
  title = compact(title).replaceAll("\n", " ");
  text = compact(text);
  if (!title && !text) return null;
  return {
    title: title.slice(0, MAX_TITLE),
    text: text.slice(0, MAX_PREVIEW_TEXT),
    truncated: truncated || title.length > MAX_TITLE || text.length > MAX_PREVIEW_TEXT,
  };
}

export async function fetchSpaceLinkPreview(
  url: URL,
  embedUrl: string | null,
  signal: AbortSignal,
) {
  const embed = embedUrl && new URL(embedUrl);
  if (embed && isPimiXEmbed(embed)) {
    const endpoint = new URL("https://publish.x.com/oembed");
    const post = new URL(`/i/status/${embed.searchParams.get("id")}`, "https://x.com");
    endpoint.search = new URLSearchParams({
      url: post.href,
      omit_script: "true",
      hide_thread: "true",
      dnt: "true",
    }).toString();
    const page = await readPage(endpoint, "application/json", signal);
    if (!page || page.truncated) return null;
    const payload = z
      .object({ author_name: z.string(), html: z.string() })
      .safeParse(JSON.parse(page.body));
    if (!payload.success) return null;
    const { text } = htmlText(payload.data.html, true);
    return text
      ? makePreview(payload.data.author_name, text, /…\s*(?:https?:\/\/\S+)?$/.test(text))
      : null;
  }
  let pageUrl = url;
  if (embed && isPimiArxivEmbed(embed)) {
    pageUrl = new URL(embed.pathname.replace(/^\/html\//, "/abs/"), embed.origin);
  } else if (embed && isPimiVideoEmbed(embed)) {
    pageUrl = new URL(`https://www.youtube.com/watch?v=${embed.pathname.split("/").pop()}`);
  }
  const page = await readPage(pageUrl, "text/html, application/xhtml+xml, text/plain", signal);
  if (!page) return null;
  if (page.type === "text/plain") return makePreview("", page.body, page.truncated);
  const { title, text } = htmlText(page.body, false);
  return makePreview(title, text, page.truncated);
}

// A saved page's text for an agent to read in full, beyond the short preview kept for search.
// arXiv HTML papers run to a few megabytes, mostly markup and math; the text cap keeps one read
// inside a model's context.
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_PAGE_TEXT = 60_000;
const PAGE_CACHE_SIZE = 8;
export interface SpaceLinkText {
  title: string;
  text: string;
  truncated: boolean;
}
const pages = new Map<string, Promise<SpaceLinkText | null>>();

/**
 * The readable text of a saved link: an arXiv paper from its HTML version, any other page from
 * its main content. Null for a post or video, whose preview already holds its text, and for a
 * page that is not HTML or plain text, such as a PDF.
 */
export function fetchSpaceLinkText(
  url: string,
  embedUrl: string | null,
  signal: AbortSignal,
): Promise<SpaceLinkText | null> {
  const embed = embedUrl ? new URL(embedUrl) : null;
  if (embed && (isPimiXEmbed(embed) || isPimiVideoEmbed(embed))) return Promise.resolve(null);
  const target = embed && isPimiArxivEmbed(embed) ? embed : new URL(url);
  let pending = pages.get(target.href);
  if (!pending) {
    pending = readPage(
      target,
      "text/html, application/xhtml+xml, text/plain",
      signal,
      MAX_PAGE_BYTES,
    ).then((page) => {
      if (!page) return null;
      const { title, text } =
        page.type === "text/plain" ? { title: "", text: page.body } : htmlText(page.body, false);
      const body = compact(text);
      if (!body) return null;
      return {
        title: compact(title).replaceAll("\n", " ").slice(0, MAX_TITLE),
        text: body.slice(0, MAX_PAGE_TEXT),
        truncated: page.truncated || body.length > MAX_PAGE_TEXT,
      };
    });
    // A failed read is not kept, so the next request tries again.
    const forget = () => pages.delete(target.href);
    pending.then((page) => page ?? forget(), forget);
    pages.set(target.href, pending);
    while (pages.size > PAGE_CACHE_SIZE) pages.delete(pages.keys().next().value!);
  }
  return pending;
}
