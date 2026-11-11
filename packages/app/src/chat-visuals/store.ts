import type { ChatHtml } from "@pimi/protocol/chat-html";
import type { ChatVega } from "@pimi/protocol/chat-vega";
import type { ChatView } from "@pimi/protocol/chat-view";

/** A visual written inline in a chat, as its fence parsed it. */
export type ChatVisual =
  | { kind: "html"; html: ChatHtml }
  | { kind: "vega"; vega: ChatVega }
  | { kind: "view"; view: ChatView }
  | { kind: "mermaid"; source: string };

/**
 * Visuals the reader opened in a tab. A reply owns its visuals; the tab only needs one while the
 * app runs, so it is kept here and never written to the layout.
 */
const visuals = new Map<string, ChatVisual>();

/** Two 32-bit FNV-1a passes. The same visual always gets the same id, so reopening it finds its tab. */
function documentId(text: string): string {
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    forward = Math.imul(forward ^ text.charCodeAt(index), 0x01000193);
    backward = Math.imul(backward ^ text.charCodeAt(text.length - 1 - index), 0x01000193);
  }
  return `${text.length.toString(36)}-${(forward >>> 0).toString(36)}-${(backward >>> 0).toString(36)}`;
}

function visualText(visual: ChatVisual): string {
  switch (visual.kind) {
    case "html":
      return visual.html.html;
    case "mermaid":
      return visual.source;
    case "vega":
      return JSON.stringify(visual.vega);
    case "view":
      return JSON.stringify(visual.view);
  }
}

export function rememberChatVisual(visual: ChatVisual): string {
  const id = `${visual.kind}-${documentId(visualText(visual))}`;
  visuals.set(id, visual);
  return id;
}

export function readChatVisual(id: string): ChatVisual | null {
  return visuals.get(id) ?? null;
}
