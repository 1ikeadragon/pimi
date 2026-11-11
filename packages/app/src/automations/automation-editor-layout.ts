import type { AutomationEdge, AutomationEdgeBranch } from "@pimi/protocol/automation/types";
import { rootStepIds, TRIGGER_NODE_ID, type EditorStep } from "./automation-editor-model";

/**
 * Lays the editor's graph out by rank: the trigger first, then each step one rank after the
 * furthest step before it, so every link points forward. Desktop flows left to right; a phone
 * flows top to bottom. There are no stored positions; the layout follows the graph.
 */

export type CanvasDirection = "right" | "down";

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 72;
const PADDING = 56;
const RANK_GAP: Record<CanvasDirection, number> = { right: 112, down: 88 };
const SIBLING_GAP: Record<CanvasDirection, number> = { right: 40, down: 28 };

export interface Point {
  x: number;
  y: number;
}

export interface CanvasNodeBox extends Point {
  id: string;
}

export interface CanvasEdge {
  key: string;
  edge: AutomationEdge;
  path: string;
  start: Point;
  end: Point;
  mid: Point;
  /** The arrowhead at `end`, as a polygon's points. */
  arrow: string;
}

export interface CanvasLayout {
  direction: CanvasDirection;
  width: number;
  height: number;
  nodes: Map<string, CanvasNodeBox>;
  edges: CanvasEdge[];
}

export type HandleBranch = AutomationEdgeBranch | "always";

export function edgeKey(edge: AutomationEdge): string {
  return `${edge.from}->${edge.to}:${edge.branch ?? ""}`;
}

const BRANCH_OFFSET: Record<HandleBranch, number> = { true: 0.3, false: 0.7, always: 0.5 };

/** Where a node's outgoing link leaves it. A check has two: yes and no. */
export function handlePoint(box: Point, branch: HandleBranch, direction: CanvasDirection): Point {
  const along = BRANCH_OFFSET[branch];
  return direction === "right"
    ? { x: box.x + NODE_WIDTH, y: box.y + NODE_HEIGHT * along }
    : { x: box.x + NODE_WIDTH * along, y: box.y + NODE_HEIGHT };
}

function inputPoint(box: Point, direction: CanvasDirection): Point {
  return direction === "right"
    ? { x: box.x, y: box.y + NODE_HEIGHT / 2 }
    : { x: box.x + NODE_WIDTH / 2, y: box.y };
}

/** Steps' ranks by longest path from the trigger (rank 0). Steps on a loop get the rank after the deepest step before them that is not. */
function rankSteps(
  steps: readonly EditorStep[],
  edges: readonly AutomationEdge[],
): Map<string, number> {
  const ids = steps.map((step) => step.id);
  const known = new Set(ids);
  const live = edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of live) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const rank = new Map<string, number>();
  const ready = ids.filter((id) => indegree.get(id) === 0);
  for (const id of ready) {
    rank.set(id, 1);
  }
  while (ready.length > 0) {
    const id = ready.shift()!;
    for (const edge of live) {
      if (edge.from !== id) {
        continue;
      }
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 1, (rank.get(id) ?? 1) + 1));
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) {
        ready.push(edge.to);
      }
    }
  }
  for (const id of ids) {
    if (!rank.has(id)) {
      rank.set(id, 1);
    }
  }
  return rank;
}

function cubicMid(a: Point, b: Point, c: Point, d: Point): Point {
  return { x: (a.x + 3 * b.x + 3 * c.x + d.x) / 8, y: (a.y + 3 * b.y + 3 * c.y + d.y) / 8 };
}

export function linkPath(
  start: Point,
  end: Point,
  direction: CanvasDirection,
): {
  path: string;
  mid: Point;
} {
  const span = direction === "right" ? end.x - start.x : end.y - start.y;
  const bend = Math.max(40, Math.abs(span) / 2);
  const c1 =
    direction === "right" ? { x: start.x + bend, y: start.y } : { x: start.x, y: start.y + bend };
  const c2 = direction === "right" ? { x: end.x - bend, y: end.y } : { x: end.x, y: end.y - bend };
  return {
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    mid: cubicMid(start, c1, c2, end),
  };
}

function arrowAt(end: Point, direction: CanvasDirection): string {
  if (direction === "right") {
    return `${end.x},${end.y} ${end.x - 8},${end.y - 4.5} ${end.x - 8},${end.y + 4.5}`;
  }
  return `${end.x},${end.y} ${end.x - 4.5},${end.y - 8} ${end.x + 4.5},${end.y - 8}`;
}

export function layoutAutomationGraph(input: {
  steps: readonly EditorStep[];
  edges: readonly AutomationEdge[];
  direction: CanvasDirection;
}): CanvasLayout {
  const { steps, edges, direction } = input;
  const rank = rankSteps(steps, edges);
  const ranks: string[][] = [[TRIGGER_NODE_ID]];
  for (const step of steps) {
    const r = rank.get(step.id) ?? 1;
    (ranks[r] ??= []).push(step.id);
  }
  // One barycenter pass: order each rank by where its parents sit, to uncross most links.
  const index = new Map<string, number>([[TRIGGER_NODE_ID, 0]]);
  const roots = new Set(rootStepIds(steps, edges));
  for (let r = 1; r < ranks.length; r += 1) {
    const layer = ranks[r] ?? [];
    const weight = (id: string): number => {
      const parents = edges.filter((edge) => edge.to === id).map((edge) => edge.from);
      const positions = [
        ...parents.map((parent) => index.get(parent)).filter((value) => value !== undefined),
        ...(roots.has(id) ? [0] : []),
      ];
      return positions.length > 0
        ? positions.reduce((sum, value) => sum + value, 0) / positions.length
        : 0;
    };
    const weights = new Map(layer.map((id) => [id, weight(id)]));
    layer.sort((a, b) => (weights.get(a) ?? 0) - (weights.get(b) ?? 0));
    ranks[r] = layer;
    layer.forEach((id, position) => index.set(id, position));
  }

  const mainSize = direction === "right" ? NODE_WIDTH : NODE_HEIGHT;
  const crossSize = direction === "right" ? NODE_HEIGHT : NODE_WIDTH;
  const rankGap = RANK_GAP[direction];
  const siblingGap = SIBLING_GAP[direction];
  const widest = Math.max(1, ...ranks.map((layer) => layer?.length ?? 0));
  const crossExtent = widest * crossSize + (widest - 1) * siblingGap;
  const nodes = new Map<string, CanvasNodeBox>();
  ranks.forEach((layer, r) => {
    const items = layer ?? [];
    const span = items.length * crossSize + (items.length - 1) * siblingGap;
    const start = PADDING + (crossExtent - span) / 2;
    items.forEach((id, position) => {
      const main = PADDING + r * (mainSize + rankGap);
      const cross = start + position * (crossSize + siblingGap);
      nodes.set(id, direction === "right" ? { id, x: main, y: cross } : { id, x: cross, y: main });
    });
  });
  const rankCount = Math.max(1, ranks.length);
  const mainExtent = rankCount * mainSize + (rankCount - 1) * rankGap;
  const width = PADDING * 2 + (direction === "right" ? mainExtent : crossExtent);
  const height = PADDING * 2 + (direction === "right" ? crossExtent : mainExtent);

  const kindOf = new Map(steps.map((step) => [step.id, step.kind]));
  const drawn: AutomationEdge[] = [
    ...[...roots].map((to) => ({ from: TRIGGER_NODE_ID, to })),
    ...edges,
  ];
  const canvasEdges: CanvasEdge[] = [];
  for (const edge of drawn) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const branch: HandleBranch =
      kindOf.get(edge.from) === "condition" ? (edge.branch ?? "true") : "always";
    const start = handlePoint(from, branch, direction);
    const end = inputPoint(to, direction);
    const { path, mid } = linkPath(start, end, direction);
    canvasEdges.push({
      key: edgeKey(edge),
      edge,
      path,
      start,
      end,
      mid,
      arrow: arrowAt(end, direction),
    });
  }
  return { direction, width, height, nodes, edges: canvasEdges };
}
