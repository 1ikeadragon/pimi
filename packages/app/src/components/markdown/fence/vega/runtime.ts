// Everything that imports Vega lives in this module, and nothing imports this module statically:
// the fence loads it with `import()` the first time a chart appears, so Vega stays out of the
// app's startup bundle.
import { View, loader as createLoader, parse, Error as LogErrors } from "vega";
import type { Loader } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile, type Config, type TopLevelSpec } from "vega-lite";
import { VEGA_LIMITS } from "@pimi/protocol/chat-vega";

export interface VegaChartInput {
  /** A spec that already passed `parseChatVega`. */
  spec: Record<string, unknown>;
  config: Config;
  /** The width the chart may take, in CSS pixels. */
  width: number;
}

export interface TooltipRow {
  label: string;
  value: string;
}

/** A mark the reader can press for its values, in the coordinates of the rendered SVG. */
export interface VegaRegion {
  box: { x: number; y: number; width: number; height: number };
  rows: TooltipRow[];
}

export interface VegaSvg {
  svg: string;
  width: number;
  height: number;
  regions: VegaRegion[];
}

/**
 * A spec is untrusted, so the chart can reach nothing. `parseChatVega` already refuses a spec
 * that names a URL or a link; this loader is the second wall behind it. `load` fails every
 * request, whatever the scheme. `sanitize` must resolve rather than throw: Vega awaits it while
 * writing a link, and a rejection there escapes as an unhandled error. A null href drops the link.
 */
function sealedLoader(): Loader {
  const loader = createLoader();
  const refuse = () => Promise.reject(new Error("A chart cannot load external data."));
  loader.load = refuse;
  loader.http = refuse;
  loader.file = refuse;
  loader.sanitize = () => Promise.resolve({ href: null as unknown as string });
  return loader;
}

const silent = {
  level: () => silent,
  error: () => silent,
  warn: () => silent,
  info: () => silent,
  debug: () => silent,
};

/** Below this width a legend beside the chart leaves too little room for the marks. */
const SIDE_LEGEND_MIN_WIDTH = 520;
const LEGEND_COLUMN_WIDTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One plot area, as opposed to a facet, concat or repeat, which size each cell on their own. */
function isSinglePlot(spec: Record<string, unknown>): boolean {
  if (!("mark" in spec) && !("layer" in spec)) return false;
  const { encoding } = spec;
  return !isRecord(encoding) || !("facet" in encoding || "row" in encoding || "column" in encoding);
}

/**
 * The app owns the chart's width: a single plot is fitted to the chat column, axes and legend
 * included. A multi-plot spec keeps its own cell sizes and scrolls sideways when it is wider.
 */
function fitToColumn(spec: Record<string, unknown>, width: number): TopLevelSpec {
  if (!isSinglePlot(spec)) return spec as unknown as TopLevelSpec;
  const { width: _width, height, autosize: _autosize, ...rest } = spec;
  return {
    ...rest,
    width,
    ...(typeof height === "number" ? { height: Math.min(height, VEGA_LIMITS.height) } : null),
    ...(isRecord(height) ? { height } : null),
    autosize: { type: "fit-x", contains: "padding" },
  } as unknown as TopLevelSpec;
}

/** A narrow column gets its legend below the plot and slanted category labels, so none are lost. */
function fitConfigToColumn(config: Config, width: number): Config {
  if (width >= SIDE_LEGEND_MIN_WIDTH) return config;
  return {
    ...config,
    axisXDiscrete: { ...config.axisXDiscrete, labelAngle: -40, labelOverlap: false },
    legend: {
      ...config.legend,
      orient: "bottom",
      direction: "horizontal",
      columns: Math.max(1, Math.floor(width / LEGEND_COLUMN_WIDTH)),
    },
  };
}

/**
 * Builds a view that has not run yet. Expressions go through Vega's AST interpreter, so nothing
 * in a spec is ever compiled with the Function constructor. Throws for a spec Vega-Lite rejects.
 */
export function createVegaView(
  { spec, config, width }: VegaChartInput,
  target: { renderer: "svg"; container: Element } | { renderer: "none" },
): View {
  const compiled = compile(fitToColumn(spec, width), {
    config: fitConfigToColumn(config, width),
    logger: silent,
  });
  const runtime = parse(compiled.spec, undefined, { ast: true });
  return new View(runtime, {
    ...target,
    // Hover styling needs pointer events, which only the DOM renderer has.
    hover: target.renderer === "svg",
    loader: sealedLoader(),
    expr: expressionInterpreter,
    logLevel: LogErrors,
  });
}

/** The parts of Vega's scenegraph this module reads: marks hold items, and group items hold marks. */
interface SceneNode {
  marktype?: string;
  role?: string;
  items?: SceneNode[];
  x?: number;
  y?: number;
  bounds?: { x1: number; y1: number; x2: number; y2: number };
  tooltip?: unknown;
}

function sceneRoot(view: View): SceneNode {
  return (view.scenegraph() as unknown as { root: SceneNode }).root;
}

/** Visits every item drawn by the spec's own marks, with its offset from the SVG origin. */
function visitMarkItems(
  mark: SceneNode,
  dx: number,
  dy: number,
  visit: (item: SceneNode, mark: SceneNode, dx: number, dy: number) => void,
): void {
  for (const item of mark.items ?? []) {
    if (mark.marktype === "group") {
      for (const child of item.items ?? []) {
        visitMarkItems(child, dx + (item.x ?? 0), dy + (item.y ?? 0), visit);
      }
    } else if (mark.role === "mark") {
      visit(item, mark, dx, dy);
    }
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "number")
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

/** A Vega tooltip value as rows. Vega-Lite gives an object of field titles to formatted values. */
export function tooltipRows(value: unknown): TooltipRow[] {
  if (value === null || value === undefined || value === "") return [];
  if (!isRecord(value)) return [{ label: "", value: formatValue(value) }];
  return Object.entries(value)
    .filter(([, field]) => field !== null && field !== undefined && field !== "")
    .slice(0, 12)
    .map(([label, field]) => ({ label, value: formatValue(field) }));
}

/** A point on a line or area has no size of its own, so it gets a finger-sized box. */
const POINT_REACH = 14;
const PATH_MARKS: ReadonlySet<string> = new Set(["line", "area", "trail"]);

/** How many items the spec's marks drew. Zero means the chart is blank. */
export function countMarkItems(view: View): number {
  let count = 0;
  visitMarkItems(sceneRoot(view), 0, 0, () => {
    count += 1;
  });
  return count;
}

function pressRegions(view: View): VegaRegion[] {
  // The SVG places the scene at the view's padding plus the room its axes take.
  const [originX, originY] = view.origin();
  // A view always reports its padding per side, whatever form the spec gave it in.
  const { left, top } = view.padding() as { left: number; top: number };
  const regions: VegaRegion[] = [];
  visitMarkItems(sceneRoot(view), originX + left, originY + top, (item, mark, dx, dy) => {
    const rows = tooltipRows(item.tooltip);
    if (rows.length === 0 || !item.bounds) return;
    const { x1, y1, x2, y2 } = item.bounds;
    const box = PATH_MARKS.has(mark.marktype ?? "")
      ? {
          x: dx + (item.x ?? 0) - POINT_REACH,
          y: dy + (item.y ?? 0) - POINT_REACH,
          width: POINT_REACH * 2,
          height: POINT_REACH * 2,
        }
      : { x: dx + x1, y: dy + y1, width: x2 - x1, height: y2 - y1 };
    if ([box.x, box.y, box.width, box.height].every(Number.isFinite)) regions.push({ box, rows });
  });
  return regions;
}

/** Draws a chart to an SVG string with no DOM, for a platform that has none. */
export async function renderVegaSvg(input: VegaChartInput): Promise<VegaSvg> {
  const view = createVegaView(input, { renderer: "none" });
  try {
    await view.runAsync();
    if (countMarkItems(view) === 0) throw new Error("The chart drew no marks.");
    const svg = await view.toSVG();
    const size = /<svg[^>]*?\swidth="([\d.]+)"[^>]*?\sheight="([\d.]+)"/.exec(svg);
    if (!size) throw new Error("The chart has no size.");
    return {
      // The third wall: whatever the spec said, the drawing holds no link and no image.
      svg: svg.replace(/<\/?a(?:\s[^>]*)?>|<image\s[^>]*>(?:<\/image>)?/g, ""),
      width: Number(size[1]),
      height: Number(size[2]),
      regions: pressRegions(view),
    };
  } finally {
    view.finalize();
  }
}
