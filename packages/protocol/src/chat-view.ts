import { z } from "zod";
import { parseBlockJson } from "./chat-json.js";

export const PIMI_CHART_FENCE = "pimi-chart";
export const PIMI_VIEW_FENCE = "pimi-view";
export type ViewFence = typeof PIMI_CHART_FENCE | typeof PIMI_VIEW_FENCE;

/** Fields outside the visual grammar are ignored; authored nodes and edges are never dropped. */
function text() {
  return z.string().trim().min(1);
}

const idSchema = text();
const titleSchema = text();
const labelSchema = text();
const unitSchema = text();
const toneSchema = z.enum(["neutral", "positive", "negative", "warning"]);
/** What a flow box is. It picks the box's icon and colour; a box without one is a plain step. */
const flowKindSchema = z.enum([
  "step",
  "user",
  "agent",
  "service",
  "data",
  "file",
  "queue",
  "tool",
  "code",
  "external",
  "secret",
]);

function hasDistinctNames(series: readonly { name: string }[]): boolean {
  return new Set(series.map(({ name }) => name)).size === series.length;
}

interface CategoryData {
  labels: string[];
  series: { name: string; values: number[] }[];
}

function isAlignedCategoryData({ labels, series }: CategoryData): boolean {
  return (
    new Set(labels).size === labels.length &&
    hasDistinctNames(series) &&
    series.every(({ values }) => values.length === labels.length)
  );
}

function categoryData() {
  return {
    labels: z.array(labelSchema).min(1),
    series: z
      .array(
        z.object({
          name: labelSchema,
          values: z.array(z.number()).min(1),
        }),
      )
      .min(1),
  };
}

const chartHeading = {
  type: z.literal("chart"),
  title: titleSchema,
  unit: unitSchema.optional(),
};
const axisTitles = { xLabel: labelSchema.optional(), yLabel: labelSchema.optional() };

const barChartSchema = z
  .object({
    ...chartHeading,
    kind: z.literal("bar"),
    ...categoryData(),
    stacked: z.boolean().optional(),
    ...axisTitles,
  })
  .refine(isAlignedCategoryData);

const lineChartSchema = z
  .object({
    ...chartHeading,
    kind: z.literal("line"),
    ...categoryData(),
    ...axisTitles,
  })
  .refine(isAlignedCategoryData);

const areaChartSchema = z
  .object({
    ...chartHeading,
    kind: z.literal("area"),
    ...categoryData(),
    stacked: z.boolean().optional(),
    ...axisTitles,
  })
  .refine(isAlignedCategoryData);

const radialChartSchema = z
  .object({
    ...chartHeading,
    kind: z.enum(["pie", "donut"]),
    ...categoryData(),
  })
  .refine(isAlignedCategoryData)
  .refine(
    ({ series }) =>
      series.length === 1 &&
      series[0].values.every((value) => value >= 0) &&
      series[0].values.some((value) => value > 0),
  );

const scatterChartSchema = z
  .object({
    ...chartHeading,
    kind: z.literal("scatter"),
    series: z
      .array(
        z.object({
          name: labelSchema,
          points: z.array(z.tuple([z.number(), z.number()])).min(1),
        }),
      )
      .min(1),
    ...axisTitles,
  })
  .refine(({ series }) => {
    return hasDistinctNames(series);
  });

const chartSchema = z.discriminatedUnion("kind", [
  barChartSchema,
  lineChartSchema,
  areaChartSchema,
  radialChartSchema,
  scatterChartSchema,
]);

const metricSchema = z.object({
  type: z.literal("metric"),
  label: labelSchema,
  value: text(),
  delta: text().optional(),
  tone: toneSchema.optional(),
  hint: titleSchema.optional(),
  trend: z.array(z.number()).min(2).optional(),
});

const tableSchema = z
  .object({
    type: z.literal("table"),
    columns: z
      .array(
        z.object({
          label: labelSchema,
          align: z.enum(["start", "end"]).optional(),
        }),
      )
      .min(1),
    rows: z.array(z.array(z.union([z.string().trim(), z.number()])).min(1)).min(1),
  })
  .refine(
    ({ columns, rows }) =>
      new Set(columns.map(({ label }) => label)).size === columns.length &&
      rows.every((row) => row.length === columns.length),
  );

const progressSchema = z
  .object({
    type: z.literal("progress"),
    label: labelSchema,
    value: z.number().nonnegative(),
    max: z.number().positive(),
    tone: toneSchema.optional(),
  })
  .refine(({ value, max }) => value <= max);

const textSchema = z.object({
  type: z.literal("text"),
  content: text(),
  tone: toneSchema.optional(),
  emphasis: z.enum(["normal", "strong", "subtle"]).optional(),
});

const badgeSchema = z.object({
  type: z.literal("badge"),
  label: text(),
  tone: toneSchema.optional(),
});

const flowTextSchema = text();

interface FlowShape {
  lanes?: { id: string }[];
  nodes: { id: string; lane?: string }[];
  edges: { from: string; to: string }[];
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** Ids are distinct, and every lane and edge points at something that exists. */
function isConnectedFlow({ lanes = [], nodes, edges }: FlowShape): boolean {
  const ids = new Set(nodes.map(({ id }) => id));
  const laneIds = new Set(lanes.map(({ id }) => id));
  const edgeKeys = new Set(edges.map(({ from, to }) => edgeKey(from, to)));
  return (
    ids.size === nodes.length &&
    laneIds.size === lanes.length &&
    edgeKeys.size === edges.length &&
    nodes.every(({ lane }) => lane === undefined || laneIds.has(lane)) &&
    edges.every(({ from, to }) => from !== to && ids.has(from) && ids.has(to))
  );
}

const flowEdgeSchema = z.object({
  from: flowTextSchema,
  to: flowTextSchema,
  label: text().optional(),
});

const flowSchema = z
  .object({
    type: z.literal("flow"),
    direction: z.enum(["right", "down"]).optional(),
    lanes: z
      .array(z.object({ id: flowTextSchema, label: flowTextSchema }))
      .min(1)
      .optional(),
    nodes: z
      .array(
        z.object({
          id: flowTextSchema,
          label: flowTextSchema,
          detail: text().optional(),
          lane: flowTextSchema.optional(),
          kind: flowKindSchema.optional(),
          tone: toneSchema.optional(),
        }),
      )
      .min(1),
    edges: z.array(flowEdgeSchema),
  })
  .refine(isConnectedFlow);

const sequenceMessageSchema = z.object({
  from: flowTextSchema,
  to: flowTextSchema,
  label: text(),
  reply: z.boolean().optional(),
  tone: toneSchema.optional(),
});
const sequenceNoteSchema = z.object({ note: text() });
const sequenceGroupLabel = text();
export type SequenceStep =
  | z.infer<typeof sequenceMessageSchema>
  | z.infer<typeof sequenceNoteSchema>
  | { group: string; steps: SequenceStep[] };

const sequenceStepSchema: z.ZodType<SequenceStep> = z.union([
  sequenceMessageSchema,
  sequenceNoteSchema,
  z.object({ group: sequenceGroupLabel, steps: z.array(z.custom<SequenceStep>()).min(1) }),
]);

function parseSequenceSteps(value: unknown): SequenceStep[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const parsed = new Map<object, SequenceStep>();
  const pending = value.map((node) => ({ node: node as unknown, visited: false }));
  while (pending.length) {
    const { node, visited } = pending.pop()!;
    if (!isRecord(node)) return null;
    if ("group" in node && !visited) {
      if (!Array.isArray(node.steps)) return null;
      pending.push({ node, visited: true });
      for (const child of node.steps) pending.push({ node: child, visited: false });
      continue;
    }
    const result = sequenceStepSchema.safeParse(
      "group" in node
        ? { ...node, steps: (node.steps as object[]).map((child) => parsed.get(child)) }
        : node,
    );
    if (!result.success) return null;
    parsed.set(node, result.data);
  }
  return value.map((node: object) => parsed.get(node)!);
}

/** Every step, including nested groups, without recursive calls. */
function flattenSequenceSteps(steps: readonly SequenceStep[]): SequenceStep[] {
  const pending = [...steps];
  const result: SequenceStep[] = [];
  while (pending.length) {
    const step = pending.pop()!;
    result.push(step);
    if ("steps" in step) for (const child of step.steps) pending.push(child);
  }
  return result;
}

const sequenceSchema = z
  .object({
    type: z.literal("sequence"),
    participants: z.array(z.object({ id: flowTextSchema, label: flowTextSchema })).min(2),
    steps: z.unknown().transform((value, context) => {
      const steps = parseSequenceSteps(value);
      if (steps) return steps;
      context.addIssue({ code: "custom", message: "Invalid sequence steps" });
      return z.NEVER;
    }),
  })
  .refine(({ participants, steps }) => {
    const ids = new Set(participants.map(({ id }) => id));
    const all = flattenSequenceSteps(steps);
    return (
      ids.size === participants.length &&
      all.every((step) => !("from" in step) || (ids.has(step.from) && ids.has(step.to)))
    );
  });

const leafSchemas = [
  metricSchema,
  chartSchema,
  tableSchema,
  progressSchema,
  textSchema,
  badgeSchema,
  flowSchema,
  sequenceSchema,
] as const;

type LeafNode = z.infer<(typeof leafSchemas)[number]>;

/** Layout nodes hold nodes, so their types are written out; a schema cannot infer its own type. */
interface StackNode {
  type: "stack";
  direction?: "column" | "row";
  children: ViewNode[];
}

interface GridNode {
  type: "grid";
  columns?: number;
  children: ViewNode[];
}

interface SectionNode {
  type: "section";
  title: string;
  children: ViewNode[];
}

export type ViewNode = LeafNode | StackNode | GridNode | SectionNode;

// parseNodeTree validates children before their parent, so the schema never recurses.
const childrenSchema = z.array(z.custom<ViewNode>()).min(1);

const stackSchema = z.object({
  type: z.literal("stack"),
  direction: z.enum(["column", "row"]).optional(),
  children: childrenSchema,
});

const gridSchema = z.object({
  type: z.literal("grid"),
  columns: z.number().int().min(1).optional(),
  children: childrenSchema,
});

const sectionSchema = z.object({
  type: z.literal("section"),
  title: titleSchema,
  children: childrenSchema,
});

const nodeSchema: z.ZodType<ViewNode> = z.discriminatedUnion("type", [
  stackSchema,
  gridSchema,
  sectionSchema,
  ...leafSchemas,
]);

const viewSchema = z.object({
  id: idSchema.optional(),
  title: titleSchema.optional(),
  root: nodeSchema,
});

export type ViewNodeType = ViewNode["type"];
export type ViewTone = z.infer<typeof toneSchema>;
export type ChartNode = z.infer<typeof chartSchema>;
export type ChartKind = ChartNode["kind"];
export type FlowNode = z.infer<typeof flowSchema>;
export type FlowKind = z.infer<typeof flowKindSchema>;
export type SequenceNode = z.infer<typeof sequenceSchema>;
export type ChatView = z.infer<typeof viewSchema>;

const CHART_KINDS = ["bar", "line", "area", "scatter", "pie", "donut"] satisfies ChartKind[];

/** The fields of each node as an agent is told them. A new node type cannot compile without an entry. */
export const VIEW_NODE_FIELDS: Record<ViewNodeType, string> = {
  stack: 'children; optional direction "column" (default) or "row"',
  grid: `children; optional positive columns (default 2), fewer when narrow`,
  section: "title, children",
  metric:
    "label, value (string); optional delta (string), tone, hint, trend (numbers drawn as a sparkline)",
  chart: `kind (${CHART_KINDS.join(", ")}), title, labels, series [{name, values}]; optional unit, xLabel, yLabel, stacked (bar and area). Scatter has no labels: series [{name, points: [[x, y], ...]}]`,
  table:
    'columns [{label, optional align "start" or "end"}] with distinct labels, rows of strings or numbers, one cell per column',
  progress: "label, value, max; optional tone",
  text: 'content; optional tone, emphasis "normal", "strong" or "subtle"',
  badge: "label; optional tone",
  flow: `nodes [{id, label, optional detail, lane, kind, tone}], edges [{from, to, optional label}] naming node ids; optional direction "right" or "down" (kept as written; when omitted Pimi picks one from the shape of the graph), lanes [{id, label}]. A kind is one of ${flowKindSchema.options.join(", ")}. Cycles are allowed; an edge from a node to itself is not`,
  sequence: `participants [{id, label}] in column order, steps in time order. A step is a message {from, to, label, optional reply (true draws a dashed return arrow), tone}, a note {note}, or a group {group, steps}: a labelled frame around a loop, an optional part, or one branch of an alternative. from and to name participant ids and may be the same participant`,
};
export const VIEW_TONES = toneSchema.options;
export const FLOW_KINDS = flowKindSchema.options;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate each node once, bottom-up, without a depth budget or recursive schema calls. */
function parseNodeTree(root: unknown): ViewNode | null {
  const parsed = new Map<object, ViewNode>();
  const pending: { node: unknown; visited: boolean }[] = [{ node: root, visited: false }];
  while (pending.length) {
    const { node, visited } = pending.pop()!;
    if (!isRecord(node)) return null;
    const layout = node.type === "stack" || node.type === "grid" || node.type === "section";
    if (layout && !visited) {
      if (!Array.isArray(node.children)) return null;
      pending.push({ node, visited: true });
      for (let index = node.children.length - 1; index >= 0; index--) {
        pending.push({ node: node.children[index], visited: false });
      }
      continue;
    }
    const candidate = layout
      ? { ...node, children: (node.children as object[]).map((child) => parsed.get(child)) }
      : node;
    const result = nodeSchema.safeParse(candidate);
    if (!result.success) return null;
    parsed.set(node, result.data);
  }
  return isRecord(root) ? (parsed.get(root) ?? null) : null;
}

/**
 * A chart block is the chart itself with `type` naming its kind, the shape stored chats
 * already contain. It becomes a view whose root is that chart.
 */
function chartDocument(data: Record<string, unknown>): unknown {
  const { id, type, ...chart } = data;
  const isChartNode = type === "chart";
  if (!isChartNode && "kind" in chart) return null;
  const root = isChartNode ? { type, ...chart } : { type: "chart", kind: type, ...chart };
  return id === undefined ? { root } : { id, root };
}

/** Returns null for anything that is not a valid view; the caller then shows the source. */
export function parseChatView(fence: ViewFence, source: string): ChatView | null {
  let data: unknown;
  try {
    data = parseBlockJson(source);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const document = fence === PIMI_CHART_FENCE ? chartDocument(data) : data;
  if (!isRecord(document)) return null;
  const root = parseNodeTree(document.root);
  if (!root) return null;
  const result = viewSchema.safeParse({ ...document, root });
  if (!result.success) return null;
  if (fence === PIMI_CHART_FENCE && result.data.root.type !== "chart") return null;
  return result.data;
}

export function viewFenceOf(language: string | null | undefined): ViewFence | null {
  const name = language?.toLowerCase();
  return name === PIMI_CHART_FENCE || name === PIMI_VIEW_FENCE ? name : null;
}
