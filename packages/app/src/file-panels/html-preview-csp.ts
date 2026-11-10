// A preview renders a self-contained document and nothing else. Inline styles and
// scripts run so a plan page keeps its layout and its diagrams; fetch, XHR,
// WebSocket, beacon, remote script, remote font, remote image, and form posts are
// all refused. Agent-written HTML is not trusted markup.
//
// What this does NOT stop: the document navigating itself. No CSP directive
// available in current browsers prevents it — `navigate-to` was dropped from CSP3
// and is unenforced, and `<meta http-equiv="refresh">` needs no script at all
// (both verified against the Chromium this app ships against). So a hostile page
// can still reach a server by navigating, carrying data available inside the
// preview. The opaque origin is what bounds the damage: the frame has no storage,
// no parent access, and no way to read any file but itself. Native narrows it
// further in html-preview.tsx, because a WebView can refuse navigation outside CSP — see the
// caveat there on why that is a mitigation rather than a guarantee.
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

// The policy must reach the parser before any markup the document declares, and it
// only counts if it lands in `<head>` — once the parser has moved on to `<body>`, a
// meta http-equiv CSP is ignored outright.
//
// Locating the document's own doctype to insert after it means reimplementing the
// tokenizer's initial insertion mode: its exact whitespace set (JS `\s` matches
// characters HTML does not, and one stray NBSP is enough to push the policy into
// the body where it stops applying), every comment ending including `--!>`, `<!-->`
// and `<!--->`, bogus-comment tokens like `<?xml …?>` and `<![CDATA[…]]>`, and the
// rule that a doctype closes at the first `>` in every state. Each of those rules
// cost a bug before it was right.
//
// So the prologue isn't found, it's supplied: our doctype, then the policy, then
// the file verbatim. The file's own doctype becomes a stray DOCTYPE token, which
// the parser ignores wherever it appears. Standards mode is guaranteed, the policy
// is always the first element and therefore always in the head, and no part of the
// document has to be parsed to place it.
const PROLOGUE = `<!doctype html>${META}`;

// Left where it is, a BOM would sit mid-document and render as a zero-width space.
const BOM = "\uFEFF";

/** How a preview embedded in another surface, such as a chat reply, should present itself. */
export interface HtmlPreviewEmbed {
  colorScheme: "light" | "dark";
  /** Custom properties without the leading `--`, exposed to the document as `--pimi-<name>`. */
  variables: Readonly<Record<string, string>>;
}

export const HTML_PREVIEW_HEIGHT_MESSAGE = "pimiPreviewHeight";

// The values are theme tokens, but they are written into a style element, so anything that
// could close a declaration or the element is dropped rather than trusted.
const UNSAFE_CSS_VALUE = /[<>{};]/;

// The theme reaches the document as static CSS, so no message ever has to cross into the frame.
// `:where()` keeps these defaults at zero specificity; any rule the document declares wins.
function embedStyle({ colorScheme, variables }: HtmlPreviewEmbed): string {
  const declarations = Object.entries(variables)
    .filter(([name, value]) => /^[a-z][a-z0-9-]*$/.test(name) && !UNSAFE_CSS_VALUE.test(value))
    .map(([name, value]) => `--pimi-${name}:${value}`)
    .join(";");
  return `<style>:root{color-scheme:${colorScheme};${declarations}}:where(html){background:var(--pimi-bg);color:var(--pimi-fg);font-family:var(--pimi-font)}:where(body){margin:0;padding:16px}</style>`;
}

// The one thing an embedded document tells its host is how tall its content is. The root
// element's own box is measured, not its scroll height, which never drops below the frame's
// height and would stop the frame from shrinking.
const HEIGHT_REPORTER = `<script>(function(){var send=function(){var height=Math.ceil(document.documentElement.getBoundingClientRect().height);var message={${HTML_PREVIEW_HEIGHT_MESSAGE}:height};if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify(message))}else{parent.postMessage(message,"*")}};new ResizeObserver(send).observe(document.documentElement);addEventListener("load",send)})();</script>`;

/** Reads a height report from an embedded preview, or null for any other message. */
export function readHtmlPreviewHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const height = (data as Record<string, unknown>)[HTML_PREVIEW_HEIGHT_MESSAGE];
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : null;
}

export function withPreviewCsp(html: string, embed?: HtmlPreviewEmbed): string {
  const document = html.startsWith(BOM) ? html.slice(BOM.length) : html;
  // The policy stays first so it is in force before the theme style or the reporter parse.
  return PROLOGUE + (embed ? embedStyle(embed) + HEIGHT_REPORTER : "") + document;
}
