import { z } from "zod";
import { parseBlockJson } from "./chat-json.js";

export const PIMI_CHART_FENCE = "pimi-chart";
export const PIMI_VIEW_FENCE = "pimi-view";
export type ViewFence = typeof PIMI_CHART_FENCE | typeof PIMI_VIEW_FENCE;

/**
 * Agent output is untrusted. Every cap is enforced before a view reaches a renderer. Fields the
 * catalog does not name are dropped, not rejected: nothing reaches a renderer except what the
 * schemas below define, and one stray key should not turn a whole chart into raw JSON.
 */
export const VIEW_LIMITS = {
  /** Roughly twice the largest valid table, so no valid view is rejected for its size. */
  sourceLength: 32_768,
  /** A view is one chat block; more nodes than this is a page, not a block. */
  nodes: 48,
  /** Bounds parser and renderer recursion. */
  depth: 5,
  /** Keeps one layout container readable on a phone. */
  children: 12,
  /** One distinguishable colour per series. */
  series: 8,
  /** Bars and slices need a readable width and label each. */
  categoryPoints: 36,
  /** A line stays legible at about two pixels per point on a phone. */
  continuousPoints: 120,
  /** Every scatter point is its own focusable target. */
  scatterPoints: 360,
  /** Columns stay readable without scrolling far sideways. */
  tableColumns: 8,
  /** A longer table belongs in a file. */
  tableRows: 50,
  /** A sparkline is about a hundred pixels wide. */
  trendPoints: 60,
  /** One line of heading. */
  title: 120,
  /** One line beside a mark, a column or a tile. */
  label: 64,
  /** Fits beside a title. */
  unit: 24,
  /** A metric value is a figure, not a sentence. */
  value: 32,
  /** A short paragraph; longer prose belongs in the reply. */
  text: 1000,
  /** One table cell. */
  cell: 120,
  /** A flow past this many boxes is two diagrams: an overview and a detail. */
  flowNodes: 24,
  /** About two edges per box keeps the lines followable. */
  flowEdges: 40,
  /** Each lane is a band of its own; more do not fit a phone. */
  flowLanes: 6,
  /** Up to three short lines in a box. */
  flowLabel: 48,
  /** A branch condition beside an arrow. */
  flowEdgeLabel: 24,
  /** Shown when the reader points at or presses a box. */
  flowDetail: 240,
} as const;

function text(max: number) {
  return z.string().trim().min(1).max(max);
}

const idSchema = text(VIEW_LIMITS.label);
const titleSchema = text(VIEW_LIMITS.title);
const labelSchema = text(VIEW_LIMITS.label);
const unitSchema = text(VIEW_LIMITS.unit);
const toneSchema = z.enum(["neutral", "positive", "negative", "warning"]);

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

function categoryData(maxPoints: number) {
  return {
    labels: z.array(labelSchema).min(1).max(maxPoints),
    series: z
      .array(
        z.object({
          name: labelSchema,
          values: z.array(z.number()).min(1).max(maxPoints),
        }),
      )
      .min(1)
      .max(VIEW_LIMITS.series),
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
    ...categoryData(VIEW_LIMITS.categoryPoints),
    stacked: z.boolean().optional(),
    ...axisTitles,
  })
  .refine(isAlignedCategoryData);

const lineChartSchema = z
  .object({
    ...chartHeading,
    kind: z.literal("line"),
    ...categoryData(VIEW_LIMITS.continuousPoints),
    ...axisTitles,
  })
  .refine(isAlignedCategoryData);

const areaChartSchema = z
  .object({
    ...chartHeading,
    kind: z.literal("area"),
    ...categoryData(VIEW_LIMITS.continuousPoints),
    stacked: z.boolean().optional(),
    ...axisTitles,
  })
  .refine(isAlignedCategoryData);

const radialChartSchema = z
  .object({
    ...chartHeading,
    kind: z.enum(["pie", "donut"]),
    ...categoryData(VIEW_LIMITS.categoryPoints),
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
          points: z
            .array(z.tuple([z.number(), z.number()]))
            .min(1)
            .max(VIEW_LIMITS.continuousPoints),
        }),
      )
      .min(1)
      .max(VIEW_LIMITS.series),
    ...axisTitles,
  })
  .refine(({ series }) => {
    const total = series.reduce((count, { points }) => count + points.length, 0);
    return hasDistinctNames(series) && total <= VIEW_LIMITS.scatterPoints;
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
  value: text(VIEW_LIMITS.value),
  delta: text(VIEW_LIMITS.value).optional(),
  tone: toneSchema.optional(),
  hint: titleSchema.optional(),
  trend: z.array(z.number()).min(2).max(VIEW_LIMITS.trendPoints).optional(),
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
      .min(1)
      .max(VIEW_LIMITS.tableColumns),
    rows: z
      .array(
        z
          .array(z.union([z.string().trim().max(VIEW_LIMITS.cell), z.number()]))
          .min(1)
          .max(VIEW_LIMITS.tableColumns),
      )
      .min(1)
      .max(VIEW_LIMITS.tableRows),
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
  content: text(VIEW_LIMITS.text),
  tone: toneSchema.optional(),
  emphasis: z.enum(["normal", "strong", "subtle"]).optional(),
});

const badgeSchema = z.object({
  type: z.literal("badge"),
  label: text(VIEW_LIMITS.value),
  tone: toneSchema.optional(),
});

const flowTextSchema = text(VIEW_LIMITS.flowLabel);

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
  label: text(VIEW_LIMITS.flowEdgeLabel).optional(),
});

const flowSchema = z
  .object({
    type: z.literal("flow"),
    direction: z.enum(["right", "down"]).optional(),
    lanes: z
      .array(z.object({ id: flowTextSchema, label: flowTextSchema }))
      .min(1)
      .max(VIEW_LIMITS.flowLanes)
      .optional(),
    nodes: z
      .array(
        z.object({
          id: flowTextSchema,
          label: flowTextSchema,
          detail: text(VIEW_LIMITS.flowDetail).optional(),
          lane: flowTextSchema.optional(),
          tone: toneSchema.optional(),
        }),
      )
      .min(1)
      .max(VIEW_LIMITS.flowNodes),
    edges: z.array(flowEdgeSchema).max(VIEW_LIMITS.flowEdges),
  })
  .refine(isConnectedFlow);

const leafSchemas = [
  metricSchema,
  chartSchema,
  tableSchema,
  progressSchema,
  textSchema,
  badgeSchema,
  flowSchema,
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

const childrenSchema: z.ZodType<ViewNode[]> = z.lazy(() =>
  z.array(nodeSchema).min(1).max(VIEW_LIMITS.children),
);

const stackSchema = z.object({
  type: z.literal("stack"),
  direction: z.enum(["column", "row"]).optional(),
  children: childrenSchema,
});

const gridSchema = z.object({
  type: z.literal("grid"),
  columns: z.number().int().min(1).max(4).optional(),
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
export type ChatView = z.infer<typeof viewSchema>;

/** Points one series may hold, per chart kind. */
export const CHART_POINT_LIMITS: Record<ChartKind, number> = {
  bar: VIEW_LIMITS.categoryPoints,
  line: VIEW_LIMITS.continuousPoints,
  area: VIEW_LIMITS.continuousPoints,
  scatter: VIEW_LIMITS.continuousPoints,
  pie: VIEW_LIMITS.categoryPoints,
  donut: VIEW_LIMITS.categoryPoints,
};

/** The fields of each node as an agent is told them. A new node type cannot compile without an entry. */
export const VIEW_NODE_FIELDS: Record<ViewNodeType, string> = {
  stack: 'children; optional direction "column" (default) or "row"',
  grid: `children; optional columns 1-4 (default 2), fewer when narrow`,
  section: "title, children",
  metric:
    "label, value (string); optional delta (string), tone, hint, trend (numbers drawn as a sparkline)",
  chart: `kind (${Object.keys(CHART_POINT_LIMITS).join(", ")}), title, labels, series [{name, values}]; optional unit, xLabel, yLabel, stacked (bar and area). Scatter has no labels: series [{name, points: [[x, y], ...]}]`,
  table:
    'columns [{label, optional align "start" or "end"}] with distinct labels, rows of strings or numbers, one cell per column',
  progress: "label, value, max; optional tone",
  text: 'content; optional tone, emphasis "normal", "strong" or "subtle"',
  badge: "label; optional tone",
  flow: `nodes [{id, label, optional detail, lane, tone}], edges [{from, to, optional label}] naming node ids; optional direction "right" (default) or "down", lanes [{id, label}]. Cycles are allowed; an edge from a node to itself is not`,
};
export const VIEW_TONES = toneSchema.options;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects oversized trees before the recursive schema walks them. */
function isWithinTreeLimits(root: unknown): boolean {
  let level: unknown[] = [root];
  let nodes = 0;
  for (let depth = 1; level.length > 0; depth++) {
    nodes += level.length;
    if (depth > VIEW_LIMITS.depth || nodes > VIEW_LIMITS.nodes) return false;
    level = level.flatMap((node) =>
      isRecord(node) && Array.isArray(node.children) ? node.children : [],
    );
  }
  return true;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

/**
 * Keeps a flow whose boxes are sound when some of its references are not. An edge that names a
 * missing box, loops on its own box, repeats an earlier edge, or is malformed is dropped, and a
 * lane that does not exist is cleared from its box. Boxes themselves are never dropped: a missing
 * box changes what the diagram says, so a bad box fails the flow.
 */
function salvageFlow(node: Record<string, unknown>): unknown {
  if (!Array.isArray(node.nodes)) return node;
  const ids = new Set(node.nodes.map((box) => (isRecord(box) ? trimmedString(box.id) : null)));
  const lanes = Array.isArray(node.lanes) ? node.lanes : [];
  const laneIds = new Set(lanes.map((lane) => (isRecord(lane) ? trimmedString(lane.id) : null)));
  const nodes = node.nodes.map((box) => {
    if (!isRecord(box) || box.lane === undefined || laneIds.has(trimmedString(box.lane))) {
      return box;
    }
    return Object.fromEntries(Object.entries(box).filter(([key]) => key !== "lane"));
  });
  if (!Array.isArray(node.edges)) return { ...node, nodes };
  const seen = new Set<string>();
  // The source length cap bounds how many edges this walks.
  const edges = node.edges.filter((edge) => {
    const parsed = flowEdgeSchema.safeParse(edge);
    if (!parsed.success) return false;
    const { from, to } = parsed.data;
    const key = edgeKey(from, to);
    if (from === to || !ids.has(from) || !ids.has(to) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...node, nodes, edges };
}

/**
 * Keeps the valid parts of a layout. An agent that gets one tile or table wrong should still show
 * the rest of its view, so an invalid child is dropped rather than failing the whole block. Runs
 * after the tree limits, so the repeated validation stays bounded.
 */
function salvageNode(node: unknown): unknown {
  if (isRecord(node) && node.type === "flow") return salvageFlow(node);
  if (!isRecord(node) || !Array.isArray(node.children)) return node;
  const children = node.children
    .map(salvageNode)
    .filter((child) => nodeSchema.safeParse(child).success);
  return { ...node, children };
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
  if (source.length > VIEW_LIMITS.sourceLength) return null;
  let data: unknown;
  try {
    data = parseBlockJson(source);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const document = fence === PIMI_CHART_FENCE ? chartDocument(data) : data;
  if (!isRecord(document) || !isWithinTreeLimits(document.root)) return null;
  const result = viewSchema.safeParse({ ...document, root: salvageNode(document.root) });
  if (!result.success) return null;
  if (fence === PIMI_CHART_FENCE && result.data.root.type !== "chart") return null;
  return result.data;
}

export function viewFenceOf(language: string | null | undefined): ViewFence | null {
  const name = language?.toLowerCase();
  return name === PIMI_CHART_FENCE || name === PIMI_VIEW_FENCE ? name : null;
}
