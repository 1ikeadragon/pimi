import type {
  AutomationConditionNode,
  AutomationConditionOperator,
  AutomationDefinition,
  AutomationFlow,
  AutomationPullRequestEvent,
} from "./types.js";

export type AutomationIssueCode =
  | "name_required"
  | "project_required"
  | "pr_repo"
  | "pr_events"
  | "no_steps"
  | "too_many_steps"
  | "bad_step_id"
  | "duplicate_step_id"
  | "edge_missing_step"
  | "self_edge"
  | "duplicate_edge"
  | "branch_required"
  | "branch_not_allowed"
  | "cycle"
  | "missing_prompt"
  | "missing_provider"
  | "bad_reference"
  | "check_needs_before"
  | "check_needs_after"
  | "check_needs_input"
  | "check_needs_value"
  | "invalid_pattern";

// `code` and `nodeId` let an editor place and word the issue itself; `message` is the English
// text the daemon, CLI and agent tools show.
export interface AutomationIssue {
  path: string;
  message: string;
  code: AutomationIssueCode;
  nodeId?: string;
  /** The `{{...}}` reference a `bad_reference` issue is about, without the braces. */
  ref?: string;
}

export const MAX_AUTOMATION_NODES = 24;
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const STEP_REF_PATTERN = /^steps\.([A-Za-z0-9_-]+)\.output$/;

// Fields of a pull-request trigger a step can read as `{{trigger.<field>}}`.
export const PULL_REQUEST_TEMPLATE_FIELDS = [
  "repo",
  "number",
  "title",
  "url",
  "author",
  "headSha",
  "headRef",
  "baseRef",
  "action",
] as const;

export function stepOutputReference(nodeId: string): string {
  return `{{steps.${nodeId}.output}}`;
}

/** The `{{...}}` references in a step's text, trimmed, in order of appearance. */
export function readTemplateReferences(text: string): string[] {
  return [...text.matchAll(TEMPLATE_PATTERN)].map((match) => match[1].trim());
}

export interface AutomationTemplateContext {
  /** Output of each finished upstream step; null when the step was skipped or wrote nothing. */
  steps: ReadonlyMap<string, string | null>;
  pullRequest: AutomationPullRequestEvent | null;
}

// An unknown reference stays as written, so a typo shows up in the agent's prompt instead of
// silently vanishing. Validation rejects unknown references before a run gets here.
export function renderAutomationTemplate(text: string, context: AutomationTemplateContext): string {
  return text.replace(TEMPLATE_PATTERN, (whole, rawRef: string) => {
    const ref = rawRef.trim();
    const step = STEP_REF_PATTERN.exec(ref);
    if (step) {
      return context.steps.has(step[1]) ? (context.steps.get(step[1]) ?? "") : whole;
    }
    if (ref.startsWith("trigger.")) {
      const field = ref.slice("trigger.".length);
      if (!(PULL_REQUEST_TEMPLATE_FIELDS as readonly string[]).includes(field)) {
        return whole;
      }
      const pr = context.pullRequest;
      return pr ? String(pr[field as keyof AutomationPullRequestEvent]) : "";
    }
    return whole;
  });
}

/** `is_empty` and `not_empty` test the input alone; every other operator compares with `value`. */
export function conditionOperatorNeedsValue(operator: AutomationConditionOperator): boolean {
  return operator !== "is_empty" && operator !== "not_empty";
}

export function evaluateAutomationCondition(node: AutomationConditionNode, input: string): boolean {
  const subject = input.trim();
  const expected = node.value.trim();
  switch (node.operator) {
    case "contains":
      return subject.toLowerCase().includes(expected.toLowerCase());
    case "not_contains":
      return !subject.toLowerCase().includes(expected.toLowerCase());
    case "equals":
      return subject.toLowerCase() === expected.toLowerCase();
    case "not_equals":
      return subject.toLowerCase() !== expected.toLowerCase();
    case "starts_with":
      return subject.toLowerCase().startsWith(expected.toLowerCase());
    case "ends_with":
      return subject.toLowerCase().endsWith(expected.toLowerCase());
    case "matches":
      return new RegExp(node.value, "i").test(subject);
    case "is_empty":
      return subject.length === 0;
    case "not_empty":
      return subject.length > 0;
  }
}

/** Node ids in an order where every edge points forward, or null when the graph has a cycle. */
export function topologicalOrder(flow: AutomationFlow): string[] | null {
  const indegree = new Map(flow.nodes.map((node) => [node.id, 0]));
  const next = new Map<string, string[]>(flow.nodes.map((node) => [node.id, []]));
  for (const edge of flow.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) {
      continue;
    }
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    next.get(edge.from)?.push(edge.to);
  }
  const ready = flow.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const target of next.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
      }
    }
  }
  return order.length === flow.nodes.length ? order : null;
}

/** Every node `nodeId` depends on, directly or through other nodes. */
export function upstreamNodeIds(flow: AutomationFlow, nodeId: string): Set<string> {
  const found = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of flow.edges) {
      if (edge.to === current && !found.has(edge.from)) {
        found.add(edge.from);
        stack.push(edge.from);
      }
    }
  }
  return found;
}

/** Every node that depends on `nodeId`, directly or through other nodes. */
export function downstreamNodeIds(flow: AutomationFlow, nodeId: string): Set<string> {
  const found = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of flow.edges) {
      if (edge.from === current && !found.has(edge.to)) {
        found.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  return found;
}

function validateReferences(input: {
  definition: AutomationDefinition;
  nodeId: string;
  path: string;
  text: string;
  issues: AutomationIssue[];
}): void {
  const { definition, nodeId, path, text, issues } = input;
  const upstream = upstreamNodeIds(definition.flow, nodeId);
  for (const ref of readTemplateReferences(text)) {
    const step = STEP_REF_PATTERN.exec(ref);
    if (step) {
      if (!upstream.has(step[1])) {
        issues.push({
          path,
          message: `{{${ref}}} in step ${nodeId} must name a step that runs before it`,
          code: "bad_reference",
          nodeId,
          ref,
        });
      }
      continue;
    }
    if (ref.startsWith("trigger.")) {
      const field = ref.slice("trigger.".length);
      if (definition.trigger.kind !== "pull_request") {
        issues.push({
          path,
          message: `{{${ref}}} needs a pull request trigger`,
          code: "bad_reference",
          nodeId,
          ref,
        });
      } else if (!(PULL_REQUEST_TEMPLATE_FIELDS as readonly string[]).includes(field)) {
        issues.push({
          path,
          message: `{{${ref}}} is not a trigger field; use one of ${PULL_REQUEST_TEMPLATE_FIELDS.join(", ")}`,
          code: "bad_reference",
          nodeId,
          ref,
        });
      }
      continue;
    }
    issues.push({
      path,
      message: `{{${ref}}} in step ${nodeId} is not a reference; use {{steps.<id>.output}} or {{trigger.<field>}}`,
      code: "bad_reference",
      nodeId,
      ref,
    });
  }
}

function validateFlowShape(definition: AutomationDefinition, issues: AutomationIssue[]): boolean {
  const { flow } = definition;
  if (flow.nodes.length === 0) {
    issues.push({ path: "flow.nodes", message: "Add at least one step", code: "no_steps" });
    return false;
  }
  if (flow.nodes.length > MAX_AUTOMATION_NODES) {
    issues.push({
      path: "flow.nodes",
      message: `An automation has at most ${MAX_AUTOMATION_NODES} steps`,
      code: "too_many_steps",
    });
  }
  const kinds = new Map<string, string>();
  for (const node of flow.nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) {
      issues.push({
        path: `flow.nodes.${node.id}`,
        message: `Step id "${node.id}" may use only letters, digits, - and _`,
        code: "bad_step_id",
        nodeId: node.id,
      });
    }
    if (kinds.has(node.id)) {
      issues.push({
        path: `flow.nodes.${node.id}`,
        message: `Duplicate step id ${node.id}`,
        code: "duplicate_step_id",
        nodeId: node.id,
      });
    }
    kinds.set(node.id, node.kind);
  }
  const seenEdges = new Set<string>();
  let edgesValid = true;
  for (const edge of flow.edges) {
    const path = `flow.edges.${edge.from}->${edge.to}`;
    if (!kinds.has(edge.from) || !kinds.has(edge.to)) {
      issues.push({
        path,
        message: `Edge ${edge.from} -> ${edge.to} names a missing step`,
        code: "edge_missing_step",
      });
      edgesValid = false;
      continue;
    }
    if (edge.from === edge.to) {
      issues.push({
        path,
        message: `Step ${edge.from} cannot depend on itself`,
        code: "self_edge",
        nodeId: edge.from,
      });
      edgesValid = false;
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.branch ?? ""}`;
    if (seenEdges.has(key)) {
      issues.push({
        path,
        message: `Duplicate edge ${edge.from} -> ${edge.to}`,
        code: "duplicate_edge",
        nodeId: edge.from,
      });
    }
    seenEdges.add(key);
    const fromCondition = kinds.get(edge.from) === "condition";
    if (fromCondition && !edge.branch) {
      issues.push({
        path,
        message: `Edge from condition ${edge.from} needs a true or false branch`,
        code: "branch_required",
        nodeId: edge.from,
      });
    }
    if (!fromCondition && edge.branch) {
      issues.push({
        path,
        message: `Only edges from a condition take a branch`,
        code: "branch_not_allowed",
        nodeId: edge.from,
      });
    }
  }
  if (edgesValid && topologicalOrder(flow) === null) {
    issues.push({
      path: "flow.edges",
      message: "The steps form a loop; a flow must not cycle",
      code: "cycle",
    });
    return false;
  }
  return edgesValid;
}

function validateTrigger(definition: AutomationDefinition, issues: AutomationIssue[]): void {
  const trigger = definition.trigger;
  if (trigger.kind !== "pull_request") {
    return;
  }
  if (!REPO_PATTERN.test(trigger.repo.trim())) {
    issues.push({
      path: "trigger.repo",
      message: "Repository must be owner/name",
      code: "pr_repo",
    });
  }
  if (trigger.events.length === 0) {
    issues.push({
      path: "trigger.events",
      message: "Pick at least one pull request event",
      code: "pr_events",
    });
  }
}

function isValidPattern(source: string): boolean {
  try {
    return RegExp(source, "i") instanceof RegExp;
  } catch {
    return false;
  }
}

export function validateAutomationDefinition(definition: AutomationDefinition): AutomationIssue[] {
  const issues: AutomationIssue[] = [];
  if (!definition.name.trim()) {
    issues.push({ path: "name", message: "Name is required", code: "name_required" });
  }
  if (!definition.project.cwd.trim()) {
    issues.push({ path: "project.cwd", message: "Project is required", code: "project_required" });
  }
  validateTrigger(definition, issues);
  if (!validateFlowShape(definition, issues)) {
    return issues;
  }
  for (const node of definition.flow.nodes) {
    const path = `flow.nodes.${node.id}`;
    if (node.kind === "agent") {
      if (!node.prompt.trim()) {
        issues.push({
          path: `${path}.prompt`,
          message: `Step ${node.id} needs a prompt`,
          code: "missing_prompt",
          nodeId: node.id,
        });
      }
      if (!node.provider.trim()) {
        issues.push({
          path: `${path}.provider`,
          message: `Step ${node.id} needs a provider`,
          code: "missing_provider",
          nodeId: node.id,
        });
      }
      validateReferences({
        definition,
        nodeId: node.id,
        path: `${path}.prompt`,
        text: node.prompt,
        issues,
      });
      continue;
    }
    if (!definition.flow.edges.some((edge) => edge.to === node.id)) {
      issues.push({
        path,
        message: `Condition ${node.id} needs a step before it to test`,
        code: "check_needs_before",
        nodeId: node.id,
      });
    }
    if (!definition.flow.edges.some((edge) => edge.from === node.id)) {
      issues.push({
        path,
        message: `Condition ${node.id} needs a step after it`,
        code: "check_needs_after",
        nodeId: node.id,
      });
    }
    if (!node.input.trim()) {
      issues.push({
        path: `${path}.input`,
        message: `Condition ${node.id} needs an input`,
        code: "check_needs_input",
        nodeId: node.id,
      });
    }
    if (conditionOperatorNeedsValue(node.operator) && !node.value.trim()) {
      issues.push({
        path: `${path}.value`,
        message: `Condition ${node.id} needs text to compare with`,
        code: "check_needs_value",
        nodeId: node.id,
      });
    }
    if (node.operator === "matches" && !isValidPattern(node.value)) {
      issues.push({
        path: `${path}.value`,
        message: `Condition ${node.id} has an invalid pattern`,
        code: "invalid_pattern",
        nodeId: node.id,
      });
    }
    validateReferences({
      definition,
      nodeId: node.id,
      path: `${path}.input`,
      text: node.input,
      issues,
    });
  }
  return issues;
}
