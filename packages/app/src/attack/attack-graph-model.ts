import type { AttackCoverage, Finding, FindingSeverity } from "@pimi/protocol/attack/types";
import type { AttackRunAgent } from "./use-attack-run-agents";

export const MAX_GRAPH_AGENTS = 8;
export const MAX_GRAPH_ROUTES = 40;
export const MAX_GRAPH_FINDINGS = 60;

export const SEVERITY_RANK: Record<FindingSeverity, number> = { blocker: 3, major: 2, minor: 1 };

/** Path only, lowercase, no trailing slash: the same key the daemon files coverage under. */
export function normalizeRoute(raw: string): string {
  const trimmed = raw.trim();
  let path = trimmed;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    path = trimmed.split(/[?#]/)[0] ?? trimmed;
  }
  const lowered = path.toLowerCase().replace(/\/+$/, "");
  return lowered.length > 0 ? lowered : "/";
}

export type GraphColumn = 0 | 1 | 2 | 3;

export interface GraphNode {
  id: string;
  column: GraphColumn;
  row: number;
  kind: "lead" | "agent" | "route" | "finding" | "more";
  label: string;
  /** The worst severity of the findings on a route, or a finding's own. */
  severity: FindingSeverity | null;
  agentId?: string;
  finding?: Finding;
  route?: { key: string; visits: number; agentCount: number; findingCount: number };
  /** For a `more` node: how many items it stands for. */
  hidden?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface AttackGraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rows: number;
}

export interface MatrixCell {
  visited: boolean;
  severity: FindingSeverity | null;
}

export interface MatrixAgent {
  id: string;
  role: string;
}

export interface MatrixRow {
  route: string;
  cells: MatrixCell[];
}

export interface AttackCoverageMatrix {
  agents: MatrixAgent[];
  rows: MatrixRow[];
  hiddenRoutes: number;
  hiddenAgents: number;
}

interface RouteInfo {
  key: string;
  firstAt: string;
  visits: number;
  agentIds: Set<string>;
  findings: Finding[];
  worst: FindingSeverity | null;
}

function worse(left: FindingSeverity | null, right: FindingSeverity): FindingSeverity {
  return left === null || SEVERITY_RANK[right] > SEVERITY_RANK[left] ? right : left;
}

// Routes come from the browser (coverage) and from findings (which also name files). Order is
// first-seen, so a new finding never moves a route that is already drawn.
function collectRoutes(coverage: AttackCoverage, findings: readonly Finding[]): RouteInfo[] {
  const byKey = new Map<string, RouteInfo>();
  for (const [route, entry] of Object.entries(coverage)) {
    const key = normalizeRoute(route);
    const info = byKey.get(key) ?? {
      key,
      firstAt: entry.firstAt,
      visits: 0,
      agentIds: new Set<string>(),
      findings: [],
      worst: null,
    };
    info.visits += entry.visits;
    for (const id of entry.agentIds) info.agentIds.add(id);
    if (entry.firstAt < info.firstAt) info.firstAt = entry.firstAt;
    byKey.set(key, info);
  }
  for (const finding of findings) {
    const key = normalizeRoute(finding.route);
    const info = byKey.get(key) ?? {
      key,
      firstAt: finding.createdAt,
      visits: 0,
      agentIds: new Set<string>(),
      findings: [],
      worst: null,
    };
    info.findings.push(finding);
    info.worst = worse(info.worst, finding.severity);
    if (finding.agentId) info.agentIds.add(finding.agentId);
    byKey.set(key, info);
  }
  return [...byKey.values()];
}

// Routes with findings are kept first when more than the cap exist; the rest fold. The drawn
// ones keep first-seen order.
function pickRoutes(routes: RouteInfo[], cap: number): { shown: RouteInfo[]; hidden: number } {
  if (routes.length <= cap) {
    return { shown: routes.sort((a, b) => a.firstAt.localeCompare(b.firstAt)), hidden: 0 };
  }
  const ranked = [...routes].sort(
    (a, b) =>
      (b.worst ? SEVERITY_RANK[b.worst] : 0) - (a.worst ? SEVERITY_RANK[a.worst] : 0) ||
      b.visits - a.visits ||
      a.firstAt.localeCompare(b.firstAt),
  );
  const shown = ranked.slice(0, cap).sort((a, b) => a.firstAt.localeCompare(b.firstAt));
  return { shown, hidden: routes.length - cap };
}

function orderedAgents(agents: readonly AttackRunAgent[]) {
  const lead = agents.find((item) => item.isLead) ?? null;
  const others = agents
    .filter((item) => !item.isLead)
    .sort((a, b) => a.agent.createdAt.getTime() - b.agent.createdAt.getTime());
  return { lead, others };
}

/**
 * The attack graph as four fixed columns: lead, agents, routes, findings. Every position follows
 * from order of arrival, so the picture only grows downward. At most 8 agents, 40 routes and 60
 * findings are drawn; the rest fold into one "+N more" node per column.
 */
export function buildAttackGraph(input: {
  agents: readonly AttackRunAgent[];
  coverage: AttackCoverage;
  findings: readonly Finding[];
  leadLabel: string;
  moreLabel: (count: number) => string;
}): AttackGraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const { lead, others } = orderedAgents(input.agents);

  const leadId = lead ? `agent:${lead.agent.id}` : "lead";
  nodes.push({
    id: leadId,
    column: 0,
    row: 0,
    kind: "lead",
    label: lead?.role ?? input.leadLabel,
    severity: null,
    agentId: lead?.agent.id,
  });

  const shownAgents = others.slice(0, MAX_GRAPH_AGENTS - 1);
  const hiddenAgents = others.length - shownAgents.length;
  const agentNodeId = new Map<string, string>();
  if (lead) agentNodeId.set(lead.agent.id, leadId);
  shownAgents.forEach((item, row) => {
    const id = `agent:${item.agent.id}`;
    agentNodeId.set(item.agent.id, id);
    nodes.push({
      id,
      column: 1,
      row,
      kind: "agent",
      label: item.role,
      severity: null,
      agentId: item.agent.id,
    });
    edges.push({ from: leadId, to: id });
  });
  const moreAgentsId = "more:agents";
  if (hiddenAgents > 0) {
    nodes.push({
      id: moreAgentsId,
      column: 1,
      row: shownAgents.length,
      kind: "more",
      label: input.moreLabel(hiddenAgents),
      severity: null,
      hidden: hiddenAgents,
    });
    edges.push({ from: leadId, to: moreAgentsId });
  }
  // An agent the graph does not draw (folded or gone) is drawn as the "+N more" node.
  const agentSource = (agentId: string): string | null =>
    agentNodeId.get(agentId) ?? (hiddenAgents > 0 ? moreAgentsId : null);

  const routes = collectRoutes(input.coverage, input.findings);
  const { shown: shownRoutes, hidden: hiddenRoutes } = pickRoutes(routes, MAX_GRAPH_ROUTES);
  const routeNodeId = new Map<string, string>();
  const moreRoutesId = "more:routes";
  shownRoutes.forEach((info, row) => {
    const id = `route:${info.key}`;
    routeNodeId.set(info.key, id);
    nodes.push({
      id,
      column: 2,
      row,
      kind: "route",
      label: info.key,
      severity: info.worst,
      route: {
        key: info.key,
        visits: info.visits,
        agentCount: info.agentIds.size,
        findingCount: info.findings.length,
      },
    });
    const sources = new Set<string>();
    for (const agentId of info.agentIds) {
      const source = agentSource(agentId);
      if (source) sources.add(source);
    }
    if (sources.size === 0) sources.add(leadId);
    for (const source of sources) edges.push({ from: source, to: id });
  });
  if (hiddenRoutes > 0) {
    nodes.push({
      id: moreRoutesId,
      column: 2,
      row: shownRoutes.length,
      kind: "more",
      label: input.moreLabel(hiddenRoutes),
      severity: null,
      hidden: hiddenRoutes,
    });
    edges.push({ from: leadId, to: moreRoutesId });
  }

  // Findings follow their route's row, then arrival order.
  const routeRow = new Map(shownRoutes.map((info, row) => [info.key, row]));
  const orderedFindings = [...input.findings].sort(
    (a, b) =>
      (routeRow.get(normalizeRoute(a.route)) ?? shownRoutes.length) -
        (routeRow.get(normalizeRoute(b.route)) ?? shownRoutes.length) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  const shownFindings = orderedFindings.slice(0, MAX_GRAPH_FINDINGS);
  shownFindings.forEach((finding, row) => {
    const id = `finding:${finding.id}`;
    nodes.push({
      id,
      column: 3,
      row,
      kind: "finding",
      label: finding.title,
      severity: finding.severity,
      finding,
    });
    const from = routeNodeId.get(normalizeRoute(finding.route)) ?? moreRoutesId;
    if (from !== moreRoutesId || hiddenRoutes > 0) edges.push({ from, to: id });
  });
  const hiddenFindings = orderedFindings.length - shownFindings.length;
  if (hiddenFindings > 0) {
    nodes.push({
      id: "more:findings",
      column: 3,
      row: shownFindings.length,
      kind: "more",
      label: input.moreLabel(hiddenFindings),
      severity: null,
      hidden: hiddenFindings,
    });
  }

  const rows = Math.max(1, ...nodes.map((node) => node.row + 1));
  return { nodes, edges, rows };
}

/**
 * Rows are routes, columns are agents. A cell is untouched, visited (the agent's tab reached the
 * route) or the worst severity among that agent's findings on the route.
 */
export function buildCoverageMatrix(input: {
  agents: readonly AttackRunAgent[];
  coverage: AttackCoverage;
  findings: readonly Finding[];
}): AttackCoverageMatrix {
  const { lead, others } = orderedAgents(input.agents);
  const ordered = [...(lead ? [lead] : []), ...others];
  const shown = ordered.slice(0, MAX_GRAPH_AGENTS);
  const routes = collectRoutes(input.coverage, input.findings);
  const { shown: shownRoutes, hidden } = pickRoutes(routes, MAX_GRAPH_ROUTES);
  const visitedBy = new Map<string, Set<string>>();
  for (const [route, entry] of Object.entries(input.coverage)) {
    const key = normalizeRoute(route);
    const set = visitedBy.get(key) ?? new Set<string>();
    for (const id of entry.agentIds) set.add(id);
    visitedBy.set(key, set);
  }
  const rows: MatrixRow[] = shownRoutes.map((info) => ({
    route: info.key,
    cells: shown.map((item) => {
      let severity: FindingSeverity | null = null;
      for (const finding of info.findings) {
        if (finding.agentId === item.agent.id) severity = worse(severity, finding.severity);
      }
      return { visited: visitedBy.get(info.key)?.has(item.agent.id) ?? false, severity };
    }),
  }));
  return {
    agents: shown.map((item) => ({ id: item.agent.id, role: item.role })),
    rows,
    hiddenRoutes: hidden,
    hiddenAgents: ordered.length - shown.length,
  };
}
