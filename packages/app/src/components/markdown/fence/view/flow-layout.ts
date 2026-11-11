import type { FlowNode, ViewTone } from "@pimi/protocol/chat-view";
import type { Box, Point } from "./scene";

/**
 * A flow as geometry. Layered layout in the Sugiyama manner, kept small: cycles are broken at
 * depth-first back edges, boxes are ranked by longest path, edges that skip ranks get a dummy
 * slot in each rank they pass so they route around boxes, and a few barycenter sweeps order each
 * rank. Lanes are bands parallel to the flow; a box stays in its lane's band.
 *
 * Text is measured by character count, the same estimate the chart axes use, so the layout is
 * deterministic and needs no rendered text. A run of wide glyphs can overrun its box slightly.
 */

export type FlowDirection = "right" | "down";

const FONT_SIZE = 12;
const LINE_HEIGHT = 16;
/** Average advance of a 12px UI-font glyph, rounded up for capitals in identifiers. */
const CHARACTER_WIDTH = 6.8;
const BOX_PADDING_MAIN = 12;
const BOX_PADDING_CROSS = 8;
const TEXT_WIDTH = 140;
/** Wraps a box's label to about ten characters a line when the wide layout does not fit. */
const NARROW_TEXT_WIDTH = 72;
const MIN_BOX_WIDTH = 64;
const MAX_LINES = 5;
/** How many characters a word may run past its line before it is cut. */
const WORD_OVERHANG = 3;
const EDGE_LABEL_FONT_SIZE = 11;
const EDGE_LABEL_CHARACTER_WIDTH = 6.2;
const EDGE_LABEL_HEIGHT = 16;
const EDGE_LABEL_PADDING = 6;
const RANK_GAP: Record<FlowDirection, number> = { right: 40, down: 32 };
/** Between two stages: both bands' padding, the next band's header when it sits on this axis. */
const STAGE_GAP: Record<FlowDirection, number> = { right: 44, down: 56 };
const NODE_GAP: Record<FlowDirection, number> = { right: 12, down: 16 };
/** Cross-axis room a long edge takes in each rank it passes. */
const DUMMY_SIZE = 8;
const EDGE_ROOM = 12;
const BAND_PADDING = 10;
const BAND_GAP = 6;
const LANE_HEADER = 20;
const MIN_LANE_WIDTH = 96;
const EDGE_PADDING = 8;
const PORT_STEP = 10;
const ARROW_LENGTH = 7;
const ARROW_HALF_WIDTH = 4;
const SWEEPS = 4;

export { FONT_SIZE as FLOW_FONT_SIZE, LINE_HEIGHT as FLOW_LINE_HEIGHT };
export { EDGE_LABEL_FONT_SIZE as FLOW_EDGE_LABEL_FONT_SIZE };

export interface FlowBox {
  key: string;
  label: string;
  lines: string[];
  detail?: string;
  tone: ViewTone;
  box: Box;
}

export interface FlowEdge {
  key: string;
  /** Box indexes as the agent wrote the edge. */
  from: number;
  to: number;
  path: string;
  /** Arrowhead polygon at `to`. */
  arrow: string;
  /** Closes a cycle: drawn against the flow's direction. */
  back: boolean;
  label?: { text: string; box: Box };
}

export interface FlowLane {
  key: string;
  label: string;
  box: Box;
  labelAt: Point;
  labelAnchor: "start" | "middle";
}

export interface FlowTarget {
  key: string;
  description: string;
  anchor: Point;
  box: Box;
}

export interface FlowScene {
  width: number;
  height: number;
  direction: FlowDirection;
  lanes: FlowLane[];
  boxes: FlowBox[];
  edges: FlowEdge[];
  targets: FlowTarget[];
}

interface Vertex {
  /** The box it draws, or -1 for a slot a long edge passes through. */
  node: number;
  rank: number;
  lane: number;
  main: number;
  cross: number;
}

interface Route {
  edge: number;
  /** Vertex ids from the edge's upstream end to its downstream end. */
  chain: number[];
  back: boolean;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Breaks an identifier where a reader would: after punctuation, before a capital, else anywhere. */
function splitWord(word: string, capacity: number): string[] {
  if (word.length <= capacity + WORD_OVERHANG) return [word];
  const pieces = word.split(/(?<=[./_\-:])|(?<=[a-z0-9])(?=[A-Z])/);
  const parts: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length > capacity) {
      parts.push(current);
      current = "";
    }
    current += piece;
    // A word with no place to break is cut into even pieces. One that is only a little too
    // long stays whole and widens its box, so no line is left holding a letter or two.
    while (current.length > capacity + WORD_OVERHANG) {
      const cut = Math.ceil(current.length / Math.ceil(current.length / capacity));
      parts.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function wrapFlowLabel(text: string, capacity: number, maxLines = MAX_LINES): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (const part of splitWord(word, capacity)) {
      const joined = line ? `${line} ${part}` : part;
      if (joined.length <= capacity) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      line = part;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, capacity - 1))}…`;
  return kept;
}

function textWidth(text: string, characterWidth: number): number {
  return text.length * characterWidth;
}

function truncate(text: string, width: number, characterWidth: number): string {
  const capacity = Math.floor(width / characterWidth);
  if (text.length <= capacity) return text;
  return `${text.slice(0, Math.max(1, capacity - 1))}…`;
}

function edgeLabelSize(text: string) {
  return {
    width: round(textWidth(text, EDGE_LABEL_CHARACTER_WIDTH) + EDGE_LABEL_PADDING * 2),
    height: EDGE_LABEL_HEIGHT,
  };
}

/** Edges that close a cycle, found depth-first in the order the agent wrote the boxes. */
function backEdges(count: number, edges: readonly { from: number; to: number }[]): Set<number> {
  const outgoing: number[][] = Array.from({ length: count }, () => []);
  edges.forEach(({ from }, index) => outgoing[from].push(index));
  const state = new Uint8Array(count);
  const back = new Set<number>();
  const visit = (node: number) => {
    state[node] = 1;
    for (const edge of outgoing[node]) {
      const next = edges[edge].to;
      if (state[next] === 1) back.add(edge);
      else if (state[next] === 0) visit(next);
    }
    state[node] = 2;
  };
  for (let node = 0; node < count; node++) if (state[node] === 0) visit(node);
  return back;
}

/**
 * Longest-path ranks over an acyclic edge list. With stages, each stage's boxes take ranks after
 * every earlier stage's. A source box then moves up next to its first successor, within its stage.
 */
function rankNodes(
  count: number,
  edges: readonly [number, number][],
  stageOf: readonly number[] | null,
): number[] {
  const incoming = filled(count, 0);
  const successors: number[][] = Array.from({ length: count }, () => []);
  const predecessors: number[][] = Array.from({ length: count }, () => []);
  for (const [from, to] of edges) {
    incoming[to]++;
    successors[from].push(to);
    predecessors[to].push(from);
  }
  const order: number[] = [];
  for (let node = 0; node < count; node++) if (incoming[node] === 0) order.push(node);
  for (let head = 0; head < order.length; head++) {
    for (const next of successors[order[head]]) if (--incoming[next] === 0) order.push(next);
  }
  const rank = filled(count, 0);
  const floor = filled(count, 0);
  const ceiling = filled(count, Infinity);
  const stages = stageOf ? [...new Set(stageOf)].toSorted((a, b) => a - b) : [0];
  let base = 0;
  for (const stage of stages) {
    const members = order.filter((node) => !stageOf || stageOf[node] === stage);
    let top = base;
    for (const node of members) {
      rank[node] = Math.max(base, ...predecessors[node].map((before) => rank[before] + 1));
      top = Math.max(top, rank[node]);
    }
    for (const node of members) {
      floor[node] = base;
      if (stageOf) ceiling[node] = top;
    }
    base = top + 1;
  }
  for (let node = 0; node < count; node++) {
    if (predecessors[node].length > 0 || successors[node].length === 0) continue;
    const next = Math.min(...successors[node].map((after) => rank[after])) - 1;
    rank[node] = Math.min(ceiling[node], Math.max(floor[node], next));
  }
  return rank;
}

interface Measured {
  lines: string[];
  width: number;
  height: number;
}

function measureBox(label: string, maxTextWidth: number): Measured {
  const capacity = Math.floor(maxTextWidth / CHARACTER_WIDTH);
  const lines = wrapFlowLabel(label, capacity);
  const longest = Math.max(...lines.map((line) => textWidth(line, CHARACTER_WIDTH)));
  return {
    lines,
    width: round(Math.max(MIN_BOX_WIDTH, longest + BOX_PADDING_MAIN * 2)),
    height: lines.length * LINE_HEIGHT + BOX_PADDING_CROSS * 2,
  };
}

function cubicPath(points: readonly Point[]): string {
  const [start, ...rest] = points;
  let path = `M${round(start.x)},${round(start.y)}`;
  let previous = start;
  rest.forEach((point, index) => {
    // Even steps cross a gap between ranks; odd steps pass straight through a dummy slot.
    if (index % 2 === 1) {
      path += `L${round(point.x)},${round(point.y)}`;
    } else {
      path += `C${round(previous.x + (point.x - previous.x) / 2)},${round(previous.y)} ${round(
        previous.x + (point.x - previous.x) / 2,
      )},${round(point.y)} ${round(point.x)},${round(point.y)}`;
    }
    previous = point;
  });
  return path;
}

function verticalCubicPath(points: readonly Point[]): string {
  const [start, ...rest] = points;
  let path = `M${round(start.x)},${round(start.y)}`;
  let previous = start;
  rest.forEach((point, index) => {
    if (index % 2 === 1) {
      path += `L${round(point.x)},${round(point.y)}`;
    } else {
      const middle = previous.y + (point.y - previous.y) / 2;
      path += `C${round(previous.x)},${round(middle)} ${round(point.x)},${round(middle)} ${round(
        point.x,
      )},${round(point.y)}`;
    }
    previous = point;
  });
  return path;
}

/**
 * An edge arrives at a box side along the flow axis, its tip on the side. The line ends at the
 * head's base, so its last stretch runs straight along the axis into the head instead of still
 * bending under it, and no stroke shows through the head. The painter draws heads above the boxes
 * so the tip lands on the border instead of under it.
 */
function arrowEnd(side: Point, unit: Point): { base: Point; head: string } {
  const base = { x: side.x - unit.x * ARROW_LENGTH, y: side.y - unit.y * ARROW_LENGTH };
  const corner = (sign: number) =>
    `${round(base.x - unit.y * ARROW_HALF_WIDTH * sign)},${round(base.y + unit.x * ARROW_HALF_WIDTH * sign)}`;
  return { base, head: `${round(side.x)},${round(side.y)} ${corner(1)} ${corner(-1)}` };
}

/** Spreads the ends of several edges along one side of a box, ordered to avoid crossing. */
function portOffsets(count: number, crossSize: number): number[] {
  if (count <= 1) return Array.from({ length: count }, () => 0);
  const span = Math.min(crossSize * 0.6, (count - 1) * PORT_STEP);
  return Array.from({ length: count }, (_, index) => -span / 2 + (span * index) / (count - 1));
}

function filled(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}

/** Gives every edge that skips ranks a slot in each rank it passes. */
function routeEdges(
  forward: readonly [number, number][],
  back: ReadonlySet<number>,
  vertices: Vertex[],
): Route[] {
  return forward.map(([from, to], edge) => {
    const chain = [from];
    for (let step = vertices[from].rank + 1; step < vertices[to].rank; step++) {
      chain.push(vertices.length);
      vertices.push({
        node: -1,
        rank: step,
        lane: vertices[from].lane,
        main: 0,
        cross: DUMMY_SIZE,
      });
    }
    chain.push(to);
    return { edge, chain, back: back.has(edge) };
  });
}

/** Orders each rank by lane, then by the mean position of its neighbours, in alternating sweeps. */
function orderLayers(vertices: readonly Vertex[], routes: readonly Route[], rankCount: number) {
  const upward: number[][] = vertices.map(() => []);
  const downward: number[][] = vertices.map(() => []);
  for (const { chain } of routes) {
    for (let step = 1; step < chain.length; step++) {
      upward[chain[step]].push(chain[step - 1]);
      downward[chain[step - 1]].push(chain[step]);
    }
  }
  const layers: number[][] = Array.from({ length: rankCount }, () => []);
  vertices.forEach((vertex, id) => layers[vertex.rank].push(id));
  const position = filled(vertices.length, 0);
  const reorder = (layer: number[], neighbours: number[][]) => {
    const keyed = layer.map((id) => {
      const around = neighbours[id];
      const center =
        around.length > 0
          ? around.reduce((sum, other) => sum + position[other], 0) / around.length
          : position[id];
      return { id, lane: vertices[id].lane, center, was: position[id] };
    });
    keyed.sort((a, b) => a.lane - b.lane || a.center - b.center || a.was - b.was);
    keyed.forEach(({ id }, index) => {
      layer[index] = id;
      position[id] = index;
    });
  };
  for (const layer of layers) {
    layer.sort((a, b) => vertices[a].lane - vertices[b].lane || a - b);
    layer.forEach((id, index) => {
      position[id] = index;
    });
  }
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let step = 1; step < rankCount; step++) reorder(layers[step], upward);
    for (let step = rankCount - 2; step >= 0; step--) reorder(layers[step], downward);
  }
  return layers;
}

interface CrossLayout {
  center: number[];
  bands: { start: number; size: number }[];
  extent: number;
}

/** Cross axis: each band is as deep as its fullest rank, and each rank's cell is centred in it. */
function placeAcross(
  vertices: readonly Vertex[],
  layers: readonly number[][],
  bandCount: number,
  hasLanes: boolean,
  swimlanes: boolean,
  direction: FlowDirection,
): CrossLayout {
  const horizontal = direction === "right";
  const gap = NODE_GAP[direction];
  const cells = (band: number) =>
    layers.map((layer) => layer.filter((id) => vertices[id].lane === band));
  const cellSize = (members: number[]) =>
    members.reduce((sum, id) => sum + vertices[id].cross, 0) +
    Math.max(0, members.length - 1) * gap;
  const header = hasLanes && horizontal ? LANE_HEADER : 0;
  const padding = hasLanes ? BAND_PADDING : EDGE_PADDING;
  const bandGap = hasLanes ? BAND_GAP : 0;
  const center = filled(vertices.length, 0);
  const bands: { start: number; size: number }[] = [];
  let cursor = 0;
  for (let band = 0; band < bandCount; band++) {
    const rows = cells(band);
    const minimum = swimlanes && !horizontal ? MIN_LANE_WIDTH - padding * 2 : 0;
    const inner = Math.max(minimum, ...rows.map(cellSize));
    for (const members of rows) {
      let at = cursor + padding + header + (inner - cellSize(members)) / 2;
      for (const id of members) {
        center[id] = at + vertices[id].cross / 2;
        at += vertices[id].cross + gap;
      }
    }
    const size = padding * 2 + header + inner;
    bands.push({ start: cursor, size });
    cursor += size + bandGap;
  }
  return { center, bands, extent: cursor - bandGap };
}

interface MainLayout {
  bounds: (id: number) => { start: number; end: number };
  rankStart: number[];
  rankSize: number[];
  extent: number;
}

interface MainPadding {
  lead: number;
  tail: number;
  /** Ranks that end a stage, followed by the gap between two bands. */
  stageEnds: ReadonlySet<number>;
}

/** Main axis: ranks as wide as their widest box, gaps wide enough for the labels that sit in them. */
function placeAlong(
  vertices: readonly Vertex[],
  layers: readonly number[][],
  routes: readonly Route[],
  labels: readonly (string | undefined)[],
  { lead, tail, stageEnds }: MainPadding,
  direction: FlowDirection,
): MainLayout {
  const rankSize = layers.map((layer) =>
    Math.max(DUMMY_SIZE, ...layer.map((id) => vertices[id].main)),
  );
  const gapAfter = layers.map((_, step) =>
    stageEnds.has(step) ? STAGE_GAP[direction] : RANK_GAP[direction],
  );
  for (const { edge, chain } of routes) {
    const text = labels[edge];
    if (!text) continue;
    const size = edgeLabelSize(text);
    const needed = (direction === "right" ? size.width : size.height) + EDGE_ROOM * 2;
    const step = vertices[chain[0]].rank;
    gapAfter[step] = Math.max(gapAfter[step], needed);
  }
  const rankStart: number[] = [];
  let cursor = lead;
  rankSize.forEach((size, step) => {
    rankStart.push(cursor);
    cursor += size + (step < layers.length - 1 ? gapAfter[step] : 0);
  });
  const bounds = (id: number) => {
    const { rank: step, main, node } = vertices[id];
    if (node < 0) return { start: rankStart[step], end: rankStart[step] + rankSize[step] };
    const start = rankStart[step] + (rankSize[step] - main) / 2;
    return { start, end: start + main };
  };
  return { bounds, rankStart, rankSize, extent: cursor + tail };
}

/** The ends of a box's edges, spread along its side in the order of where they lead. */
function placePorts(vertices: readonly Vertex[], routes: readonly Route[], center: number[]) {
  const outPort = new Map<number, number>();
  const inPort = new Map<number, number>();
  const spread = (id: number, ends: Route[], toward: (route: Route) => number) => {
    const ordered = ends.toSorted((a, b) => center[toward(a)] - center[toward(b)]);
    return portOffsets(ordered.length, vertices[id].cross).map((offset, index) => ({
      edge: ordered[index].edge,
      at: center[id] + offset,
    }));
  };
  vertices.forEach((vertex, id) => {
    if (vertex.node < 0) return;
    const outs = routes.filter(({ chain }) => chain[0] === id);
    const ins = routes.filter(({ chain }) => chain[chain.length - 1] === id);
    for (const { edge, at } of spread(id, outs, ({ chain }) => chain[1])) outPort.set(edge, at);
    for (const { edge, at } of spread(id, ins, ({ chain }) => chain[chain.length - 2])) {
      inPort.set(edge, at);
    }
  });
  return { outPort, inPort };
}

/**
 * Lanes are read one of two ways. When every edge moves forward through the lanes in the order
 * they are declared, the lanes are stages: bands across the flow, each holding a run of ranks, so
 * a pipeline reads straight down or across. Otherwise they are swimlanes: bands along the flow
 * that boxes keep to while edges pass between them.
 */
function layoutFlow(flow: FlowNode, direction: FlowDirection, textWidths: readonly number[]) {
  const horizontal = direction === "right";
  const ids = new Map(flow.nodes.map(({ id }, index) => [id, index]));
  // The parser guarantees every edge names an existing box.
  const edges = flow.edges.map(({ from, to, label }) => ({
    from: ids.get(from) ?? 0,
    to: ids.get(to) ?? 0,
    label,
  }));
  const back = backEdges(flow.nodes.length, edges);
  const forward = edges.map(({ from, to }, index): [number, number] =>
    back.has(index) ? [to, from] : [from, to],
  );

  const declaredLanes = flow.lanes ?? [];
  const hasLanes = declaredLanes.length > 0;
  const laneIndex = new Map(declaredLanes.map(({ id }, index) => [id, index]));
  const laneOf = flow.nodes.map(({ lane }) => laneIndex.get(lane ?? "") ?? -1);
  const staged =
    hasLanes &&
    laneOf.every((lane) => lane >= 0) &&
    forward.every(([from, to]) => laneOf[from] <= laneOf[to]);
  const swimlanes = hasLanes && !staged;
  const unlaned = laneOf.some((lane) => lane < 0);
  const bandCount = swimlanes ? declaredLanes.length + Number(unlaned) : 1;

  // A swimlane box without a lane goes to an unnamed band after the declared ones.
  const swimlaneOf = (node: number) => {
    if (!swimlanes) return 0;
    return laneOf[node] >= 0 ? laneOf[node] : declaredLanes.length;
  };
  const rank = rankNodes(flow.nodes.length, forward, staged ? laneOf : null);
  const rankCount = Math.max(...rank) + 1;
  const measured = flow.nodes.map(({ label }, node) => measureBox(label, textWidths[node]));
  const vertices: Vertex[] = flow.nodes.map((_, node) => ({
    node,
    rank: rank[node],
    lane: swimlaneOf(node),
    main: horizontal ? measured[node].width : measured[node].height,
    cross: horizontal ? measured[node].height : measured[node].width,
  }));
  const routes = routeEdges(forward, back, vertices);
  const layers = orderLayers(vertices, routes, rankCount);
  const across = placeAcross(vertices, layers, bandCount, hasLanes, swimlanes, direction);
  const stageRanks = declaredLanes.map((_lane, lane) => {
    const ranks = rank.filter((_rank, node) => laneOf[node] === lane);
    return ranks.length > 0 ? { low: Math.min(...ranks), high: Math.max(...ranks) } : null;
  });
  const padding: MainPadding = staged
    ? {
        lead: BAND_PADDING + (horizontal ? 0 : LANE_HEADER),
        tail: BAND_PADDING,
        stageEnds: new Set(stageRanks.flatMap((range) => (range ? [range.high] : []))),
      }
    : {
        lead: EDGE_PADDING + (swimlanes && !horizontal ? LANE_HEADER : 0),
        tail: EDGE_PADDING,
        stageEnds: new Set(),
      };
  const along = placeAlong(
    vertices,
    layers,
    routes,
    edges.map(({ label }) => label),
    padding,
    direction,
  );
  const ports = placePorts(vertices, routes, across.center);

  return {
    horizontal,
    edges,
    measured,
    vertices,
    routes,
    bands: across.bands,
    declaredLanes,
    swimlanes,
    staged,
    stageRanks,
    rank,
    rankStart: along.rankStart,
    rankSize: along.rankSize,
    crossCenter: across.center,
    crossExtent: across.extent,
    mainExtent: along.extent,
    mainBounds: along.bounds,
    outPort: ports.outPort,
    inPort: ports.inPort,
  };
}

type FlowLayout = ReturnType<typeof layoutFlow>;

function naturalWidth(layout: FlowLayout): number {
  return layout.horizontal ? layout.mainExtent : layout.crossExtent;
}

function swimlaneBands(
  layout: FlowLayout,
  { width, height, offset }: { width: number; height: number; offset: number },
): FlowLane[] {
  return layout.bands.map(({ start, size }, band) => {
    const label = layout.declaredLanes[band]?.label ?? "";
    if (layout.horizontal) {
      return {
        key: `${band}`,
        label: truncate(label, width - BAND_PADDING * 2, CHARACTER_WIDTH),
        box: { x: 0, y: round(start), width: round(width), height: round(size) },
        labelAt: { x: BAND_PADDING, y: round(start + BAND_PADDING + FONT_SIZE - 1) },
        labelAnchor: "start" as const,
      };
    }
    return {
      key: `${band}`,
      label: truncate(label, size - BAND_PADDING, CHARACTER_WIDTH),
      box: { x: round(start + offset), y: 0, width: round(size), height: round(height) },
      labelAt: { x: round(start + offset + size / 2), y: EDGE_PADDING + FONT_SIZE },
      labelAnchor: "middle" as const,
    };
  });
}

function stageBands(
  layout: FlowLayout,
  { width, height, offset }: { width: number; height: number; offset: number },
): FlowLane[] {
  return layout.declaredLanes.flatMap(({ label }, lane) => {
    const range = layout.stageRanks[lane];
    if (!range) return [];
    const start =
      layout.rankStart[range.low] - BAND_PADDING - (layout.horizontal ? 0 : LANE_HEADER);
    const end = layout.rankStart[range.high] + layout.rankSize[range.high] + BAND_PADDING;
    const size = end - start;
    if (layout.horizontal) {
      return {
        key: `${lane}`,
        label: truncate(label, size - BAND_PADDING, CHARACTER_WIDTH),
        box: { x: round(start + offset), y: 0, width: round(size), height: round(height) },
        labelAt: { x: round(start + offset + size / 2), y: BAND_PADDING + FONT_SIZE - 1 },
        labelAnchor: "middle" as const,
      };
    }
    return {
      key: `${lane}`,
      label: truncate(label, width - BAND_PADDING * 2, CHARACTER_WIDTH),
      box: { x: 0, y: round(start), width: round(width), height: round(size) },
      labelAt: { x: BAND_PADDING, y: round(start + BAND_PADDING + FONT_SIZE - 1) },
      labelAnchor: "start" as const,
    };
  });
}

function paintLanes(
  layout: FlowLayout,
  frame: { width: number; height: number; offset: number },
): FlowLane[] {
  if (layout.staged) return stageBands(layout, frame);
  if (layout.swimlanes) return swimlaneBands(layout, frame);
  return [];
}

const LABEL_SPACING = 4;

/**
 * Labels of edges leaving the same rank share one gap, and branches that leave one box start
 * close together, so their labels can overlap. Each gap's labels are packed apart across the
 * flow, keeping the group centred where the labels wanted to be.
 */
function separateLabels(
  edges: FlowEdge[],
  gapOf: readonly number[],
  horizontal: boolean,
  limit: number,
): void {
  const groups = new Map<number, { text: string; box: Box }[]>();
  edges.forEach(({ label }, index) => {
    if (!label) return;
    const group = groups.get(gapOf[index]) ?? [];
    group.push(label);
    groups.set(gapOf[index], group);
  });
  const startOf = (box: Box) => (horizontal ? box.y : box.x);
  const sizeOf = (box: Box) => (horizontal ? box.height : box.width);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => startOf(a.box) - startOf(b.box));
    const wanted = group.map(({ box }) => startOf(box));
    const placed: number[] = [];
    group.forEach((_label, index) => {
      const floor = index === 0 ? -Infinity : placed[index - 1] + sizeOf(group[index - 1].box);
      placed.push(Math.max(wanted[index], floor + (index === 0 ? 0 : LABEL_SPACING)));
    });
    const drift =
      (placed.reduce((sum, at) => sum + at, 0) - wanted.reduce((sum, at) => sum + at, 0)) /
      group.length;
    const last = group.length - 1;
    const shift = Math.min(
      Math.max(-drift, -placed[0]),
      limit - (placed[last] + sizeOf(group[last].box)),
    );
    group.forEach(({ box }, index) => {
      const at = round(placed[index] + shift);
      if (horizontal) box.y = at;
      else box.x = at;
    });
  }
}

function paintLayout(flow: FlowNode, layout: FlowLayout, available: number): FlowScene {
  const { horizontal, vertices, routes, crossCenter, mainBounds } = layout;
  const natural = naturalWidth(layout);
  const width = Math.max(natural, available);
  const height = horizontal ? layout.crossExtent : layout.mainExtent;
  const offset = (width - natural) / 2;
  const at = (main: number, cross: number): Point =>
    horizontal ? { x: main + offset, y: cross } : { x: cross + offset, y: main };

  const boxes: FlowBox[] = flow.nodes.map((node, index) => {
    const { start, end } = mainBounds(index);
    const half = vertices[index].cross / 2;
    const topLeft = at(start, crossCenter[index] - half);
    const bottomRight = at(end, crossCenter[index] + half);
    return {
      key: node.id,
      label: node.label,
      lines: layout.measured[index].lines,
      detail: node.detail,
      tone: node.tone ?? "neutral",
      box: {
        x: round(topLeft.x),
        y: round(topLeft.y),
        width: round(bottomRight.x - topLeft.x),
        height: round(bottomRight.y - topLeft.y),
      },
    };
  });

  const edges: FlowEdge[] = routes.map(({ edge, chain, back }) => {
    const first = chain[0];
    const last = chain[chain.length - 1];
    const points: Point[] = [at(mainBounds(first).end, layout.outPort.get(edge) ?? 0)];
    for (const id of chain.slice(1, -1)) {
      const { start, end } = mainBounds(id);
      points.push(at(start, crossCenter[id]), at(end, crossCenter[id]));
    }
    points.push(at(mainBounds(last).start, layout.inPort.get(edge) ?? 0));
    const labelText = layout.edges[edge].label;
    const middle = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
    // A back edge is routed with the flow and drawn against it, so its arrow lands on its target.
    const drawn = back ? points.toReversed() : points;
    const side = drawn[drawn.length - 1];
    const before = drawn[drawn.length - 2];
    const unit = horizontal
      ? { x: Math.sign(side.x - before.x), y: 0 }
      : { x: 0, y: Math.sign(side.y - before.y) };
    const end = arrowEnd(side, unit);
    const stroked = [...drawn.slice(0, -1), end.base];
    const label = labelText
      ? (() => {
          const size = edgeLabelSize(labelText);
          return {
            text: labelText,
            box: {
              x: round(middle.x - size.width / 2),
              y: round(middle.y - size.height / 2),
              ...size,
            },
          };
        })()
      : undefined;
    return {
      key: `${layout.edges[edge].from}>${layout.edges[edge].to}`,
      from: layout.edges[edge].from,
      to: layout.edges[edge].to,
      path: horizontal ? cubicPath(stroked) : verticalCubicPath(stroked),
      arrow: end.head,
      back,
      label,
    };
  });

  separateLabels(
    edges,
    routes.map(({ chain }) => vertices[chain[0]].rank),
    horizontal,
    horizontal ? height : width,
  );
  const lanes = paintLanes(layout, { width, height, offset });

  const names = flow.nodes.map(({ label }) => label);
  const targets: FlowTarget[] = boxes.map((box, index) => {
    const next = layout.edges.filter(({ from }) => from === index).map(({ to }) => names[to]);
    const previous = layout.edges.filter(({ to }) => to === index).map(({ from }) => names[from]);
    const parts = [box.label];
    if (box.detail) parts.push(box.detail);
    if (previous.length > 0) parts.push(`From ${previous.join(", ")}`);
    if (next.length > 0) parts.push(`To ${next.join(", ")}`);
    return {
      key: box.key,
      description: parts.join(". "),
      anchor: { x: round(box.box.x + box.box.width / 2), y: round(box.box.y + box.box.height / 2) },
      box: box.box,
    };
  });

  return {
    width: round(width),
    height: round(height),
    direction: horizontal ? "right" : "down",
    lanes: lanes.filter((lane) => lane.box.width > 0 && lane.box.height > 0),
    boxes,
    edges,
    targets,
  };
}

/**
 * Lays a flow out for a column `width` wide. It tries the asked-for direction, then the other one.
 * When neither fits it wraps labels narrower, first only in ranks that hold several boxes, then
 * everywhere, and keeps the first layout that fits. When none fits, the narrowest wins and the
 * scene scrolls sideways.
 */
export function buildFlowScene(flow: FlowNode, width: number): FlowScene {
  const preferred: FlowDirection = flow.direction ?? "right";
  const directions: FlowDirection[] = [preferred, preferred === "right" ? "down" : "right"];
  const wide = flow.nodes.map(() => TEXT_WIDTH);
  const first = layoutFlow(flow, preferred, wide);
  if (width <= 0 || naturalWidth(first) <= width) return paintLayout(flow, first, width);
  const perRank = new Map<number, number>();
  for (const rank of first.rank) perRank.set(rank, (perRank.get(rank) ?? 0) + 1);
  const crowded = first.rank.map((rank) =>
    (perRank.get(rank) ?? 0) > 1 ? NARROW_TEXT_WIDTH : TEXT_WIDTH,
  );
  const narrow = flow.nodes.map(() => NARROW_TEXT_WIDTH);
  let narrowest = first;
  for (const textWidths of [wide, crowded, narrow]) {
    for (const direction of directions) {
      if (textWidths === wide && direction === preferred) continue;
      const layout = layoutFlow(flow, direction, textWidths);
      if (naturalWidth(layout) <= width) return paintLayout(flow, layout, width);
      if (naturalWidth(layout) < naturalWidth(narrowest)) narrowest = layout;
    }
  }
  return paintLayout(flow, narrowest, width);
}

const HIT_SLOP = 4;

export function hitTestFlow(scene: FlowScene, x: number, y: number): number | null {
  const index = scene.targets.findIndex(
    ({ box }) =>
      x >= box.x - HIT_SLOP &&
      x <= box.x + box.width + HIT_SLOP &&
      y >= box.y - HIT_SLOP &&
      y <= box.y + box.height + HIT_SLOP,
  );
  return index < 0 ? null : index;
}
