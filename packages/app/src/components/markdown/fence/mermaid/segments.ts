import { fromMarkdown } from "mdast-util-from-markdown";
import type { Definition, RootContent } from "mdast";
import {
  PIMI_VISUALIZATION_FENCE,
  parseChatVisualization,
  type ChatVisualization,
} from "@pimi/protocol/chat-visualization";

type Fence =
  | { kind: "mermaid"; source: string }
  | { kind: "visualization"; source: string; chart: ChatVisualization };
type Segment = ({ kind: "markdown"; source: string } | Fence) & { id: string };

/** Native enriched-markdown has no fenced-block override. */
export function splitMermaidFences(
  markdown: string,
  allowVisualizations = false,
  allowMermaid = true,
): Segment[] {
  if (
    !(allowMermaid && /mermaid/i.test(markdown)) &&
    !(allowVisualizations && /pimi-chart/i.test(markdown))
  ) {
    return [{ kind: "markdown", id: "0", source: markdown }];
  }
  const segments: Segment[] = [];
  const definitions = new Map<string, Definition>();
  let cursor = 0;
  const chartSlots = new Map<string, number>();
  function appendFence(position: NonNullable<RootContent["position"]>, fence: Fence): void {
    const start = position.start.offset!;
    const end = position.end.offset!;
    if (start > cursor) {
      segments.push({
        kind: "markdown",
        id: String(segments.length),
        source: markdown.slice(cursor, start),
      });
    }
    const chartId = fence.kind === "visualization" ? fence.chart.id : undefined;
    const slot = chartId === undefined ? undefined : chartSlots.get(chartId);
    if (slot !== undefined) {
      // Reuse the first slot and React key; prose and earlier replies remain untouched.
      segments[slot] = { ...fence, id: segments[slot].id };
    } else {
      if (chartId !== undefined) chartSlots.set(chartId, segments.length);
      segments.push({ ...fence, id: String(segments.length) });
    }
    cursor = end;
  }
  function visit(node: RootContent): void {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if (node.type === "code" && node.position) {
      const lang = node.lang?.toLowerCase();
      if (allowMermaid && lang === "mermaid")
        appendFence(node.position, { kind: "mermaid", source: node.value });
      if (allowVisualizations && lang === PIMI_VISUALIZATION_FENCE) {
        const chart = parseChatVisualization(node.value);
        if (chart) appendFence(node.position, { kind: "visualization", source: node.value, chart });
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
