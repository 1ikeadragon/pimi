export const PIMI_HTML_FENCE = "pimi-html";

/**
 * The custom properties an HTML visual is themed with, each exposed to the document as
 * `--pimi-<name>`. The app fills every one from its theme, and the agent is told this same list.
 */
export const PIMI_HTML_VARIABLES = [
  "bg",
  "surface",
  "fg",
  "muted",
  "border",
  "accent",
  "accent-fg",
  "font",
  "mono",
] as const;

export type PimiHtmlVariable = (typeof PIMI_HTML_VARIABLES)[number];

export interface ChatHtml {
  html: string;
  /** The document's own `<title>`, shown as the card heading. */
  title: string | null;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function documentTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]{1,400})<\/title>/i.exec(html);
  const title = match?.[1]
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return title || null;
}

/** Returns null for an empty block; the caller then shows the source. */
export function parseChatHtml(source: string): ChatHtml | null {
  if (!source.trim()) return null;
  return { html: source, title: documentTitle(source) };
}
