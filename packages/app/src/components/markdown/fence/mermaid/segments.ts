import { fromMarkdown } from "mdast-util-from-markdown";
import type { Code, Definition, RootContent } from "mdast";
import {
  PIMI_ARTIFACT_FENCE,
  parseChatArtifact,
  type ChatArtifact,
} from "@pimi/protocol/chat-artifact";
import { PIMI_HTML_FENCE, parseChatHtml, type ChatHtml } from "@pimi/protocol/chat-html";
import { PIMI_VEGA_FENCE, parseChatVega, type ChatVega } from "@pimi/protocol/chat-vega";
import { parseChatView, viewFenceOf, type ChatView } from "@pimi/protocol/chat-view";

type Fence =
  | { kind: "mermaid"; source: string }
  | { kind: "artifact"; source: string; artifact: ChatArtifact }
  // `view` is null for a block that is still streaming and not yet valid.
  | { kind: "view"; source: string; view: ChatView | null; failed?: boolean }
  | { kind: "vega"; source: string; vega: ChatVega | null; failed?: boolean }
  | { kind: "html"; source: string; html: ChatHtml | null; failed?: boolean };
type Segment = ({ kind: "markdown"; source: string } | Fence) & { id: string };

export interface FenceSplitOptions {
  /** Extract the `pimi-*` visual blocks. Assistant replies only. */
  visualizations?: boolean;
  mermaid?: boolean;
  /** The reply is still arriving, so an invalid view block may only be unfinished. */
  streaming?: boolean;
}

/** Matches text that may hold a block rendered outside the Markdown library. */
export const PIMI_FENCE_PATTERN = /pimi-(?:chart|view|artifact|vega|html)/i;

/** A fenced block ends with its closing fence; one still being written does not. */
const CLOSED_FENCE = /\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/;

/** The id an agent has written so far in a block that is not yet complete JSON. */
function pendingViewId(source: string): string | undefined {
  return /"id"\s*:\s*"([^"\\]*)"/.exec(source)?.[1];
}

/** Native enriched-markdown has no fenced-block override. */
export function splitMermaidFences(
  markdown: string,
  {
    visualizations: allowVisualizations = false,
    mermaid: allowMermaid = true,
    streaming = false,
  }: FenceSplitOptions = {},
): Segment[] {
  if (
    !(allowMermaid && /mermaid/i.test(markdown)) &&
    !(allowVisualizations && PIMI_FENCE_PATTERN.test(markdown))
  ) {
    return [{ kind: "markdown", id: "0", source: markdown }];
  }
  const segments: Segment[] = [];
  const definitions = new Map<string, Definition>();
  let cursor = 0;
  const viewSlots = new Map<string, number>();
  function appendFence(
    position: NonNullable<RootContent["position"]>,
    fence: Fence,
    viewId?: string,
  ): void {
    const start = position.start.offset!;
    const end = position.end.offset!;
    if (start > cursor) {
      segments.push({
        kind: "markdown",
        id: String(segments.length),
        source: markdown.slice(cursor, start),
      });
    }
    const slot = viewId === undefined ? undefined : viewSlots.get(viewId);
    const isPendingUpdate = fence.kind === "view" && fence.view === null;
    if (slot === undefined) {
      if (viewId !== undefined) viewSlots.set(viewId, segments.length);
      segments.push({ ...fence, id: String(segments.length) });
    } else if (!isPendingUpdate) {
      // Reuse the first slot and React key; prose and earlier replies remain untouched.
      // An update that is still streaming leaves the last valid view in that slot.
      segments[slot] = { ...fence, id: segments[slot].id };
    }
    cursor = end;
  }
  function appendView(position: NonNullable<RootContent["position"]>, node: Code): void {
    const fence = viewFenceOf(node.lang);
    if (!fence) return;
    const view = parseChatView(fence, node.value);
    if (view) appendFence(position, { kind: "view", source: node.value, view }, view.id);
    else if (streaming) {
      appendFence(
        position,
        { kind: "view", source: node.value, view: null },
        pendingViewId(node.value),
      );
    } else appendFence(position, { kind: "view", source: node.value, view: null, failed: true });
  }
  function appendVega(position: NonNullable<RootContent["position"]>, node: Code): void {
    const vega = parseChatVega(node.value);
    // An unparsed spec in a reply that is still arriving is only unfinished.
    appendFence(position, {
      kind: "vega",
      source: node.value,
      vega,
      failed: !vega && !streaming,
    });
  }
  function appendHtml(position: NonNullable<RootContent["position"]>, node: Code): void {
    // HTML has no parse to tell a whole document from half of one, and half a document would
    // run. Until the reply ends, only a closed block is shown.
    const closed = CLOSED_FENCE.test(markdown.slice(position.start.offset, position.end.offset));
    const html = closed || !streaming ? parseChatHtml(node.value) : null;
    appendFence(position, {
      kind: "html",
      source: node.value,
      html,
      failed: !html && (closed || !streaming),
    });
  }
  function visit(node: RootContent): void {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if (node.type === "code" && node.position) {
      const lang = node.lang?.toLowerCase();
      if (allowMermaid && lang === "mermaid")
        appendFence(node.position, { kind: "mermaid", source: node.value });
      if (allowVisualizations) appendView(node.position, node);
      if (allowVisualizations && lang === PIMI_VEGA_FENCE) appendVega(node.position, node);
      if (allowVisualizations && lang === PIMI_HTML_FENCE) appendHtml(node.position, node);
      if (allowVisualizations && lang === PIMI_ARTIFACT_FENCE) {
        const artifact = parseChatArtifact(node.value);
        if (artifact)
          appendFence(node.position, { kind: "artifact", source: node.value, artifact });
      }
    } else if ("children" in node) node.children.forEach(visit);
  }
  const tree = fromMarkdown(markdown);
  tree.children.forEach(visit);
  if (cursor < markdown.length || segments.length === 0)
    segments.push({
      kind: "markdown",
      id: String(segments.length),
      source: markdown.slice(cursor),
    });
  // Prepend the document's first definitions after splitting, so fragment-local
  // duplicates cannot override them. Original source slices and fence offsets stay intact.
  if (segments.some((segment) => segment.kind !== "markdown")) {
    const referenceSource = [...definitions.values()]
      .map((node) => {
        const label = node.identifier.replace(/[\\[\]]/g, "\\$&");
        const url = node.url.replace(/[\\<>]/g, "\\$&");
        const title = node.title ? ` "${node.title.replace(/[\\"]/g, "\\$&")}"` : "";
        return `[${label}]: <${url}>${title}`;
      })
      .join("\n");
    if (referenceSource)
      for (const segment of segments) {
        if (segment.kind === "markdown") segment.source = `${referenceSource}\n\n${segment.source}`;
      }
  }
  return segments;
}
