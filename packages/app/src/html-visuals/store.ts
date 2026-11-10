import type { ChatHtml } from "@pimi/protocol/chat-html";

/**
 * Visuals written inline in a chat that the reader opened in a tab. A reply owns its HTML; the
 * tab only needs it while the app runs, so it is kept here and never written to the layout.
 */
const visuals = new Map<string, ChatHtml>();

/** Two 32-bit FNV-1a passes. The same document always gets the same id, so reopening it finds its tab. */
function documentId(html: string): string {
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let index = 0; index < html.length; index++) {
    forward = Math.imul(forward ^ html.charCodeAt(index), 0x01000193);
    backward = Math.imul(backward ^ html.charCodeAt(html.length - 1 - index), 0x01000193);
  }
  return `${html.length.toString(36)}-${(forward >>> 0).toString(36)}-${(backward >>> 0).toString(36)}`;
}

export function rememberHtmlVisual(visual: ChatHtml): string {
  const id = documentId(visual.html);
  visuals.set(id, visual);
  return id;
}

export function readHtmlVisual(id: string): ChatHtml | null {
  return visuals.get(id) ?? null;
}
