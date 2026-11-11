import type {
  AutomationAgentNode,
  AutomationDefinition,
  AutomationFlow,
  AutomationOutputNode,
} from "./types.js";

export interface AutomationIssue {
  path: string;
  message: string;
}

export interface SingleAgentFlow {
  agent: AutomationAgentNode;
  output: AutomationOutputNode;
}

// Slice 1 runs one shape of flow: a single agent node feeding one chat output.
export function readSingleAgentFlow(flow: AutomationFlow): SingleAgentFlow | null {
  const agents = flow.nodes.filter((node) => node.kind === "agent");
  const outputs = flow.nodes.filter((node) => node.kind === "output");
  if (agents.length !== 1 || outputs.length !== 1 || flow.nodes.length !== 2) {
    return null;
  }
  const agent = agents[0];
  const output = outputs[0];
  if (
    flow.edges.length !== 1 ||
    flow.edges[0].from !== agent.id ||
    flow.edges[0].to !== output.id
  ) {
    return null;
  }
  return { agent, output };
}

export function validateAutomationDefinition(definition: AutomationDefinition): AutomationIssue[] {
  const issues: AutomationIssue[] = [];
  if (!definition.name.trim()) {
    issues.push({ path: "name", message: "Name is required" });
  }
  if (!definition.project.cwd.trim()) {
    issues.push({ path: "project.cwd", message: "Project is required" });
  }
  const ids = new Set<string>();
  for (const node of definition.flow.nodes) {
    if (ids.has(node.id)) {
      issues.push({ path: `flow.nodes.${node.id}`, message: `Duplicate node id ${node.id}` });
    }
    ids.add(node.id);
  }
  const single = readSingleAgentFlow(definition.flow);
  if (!single) {
    issues.push({
      path: "flow",
      message: "The flow must be one agent step connected to one chat output",
    });
    return issues;
  }
  if (!single.agent.prompt.trim()) {
    issues.push({ path: `flow.nodes.${single.agent.id}.prompt`, message: "Prompt is required" });
  }
  if (!single.agent.provider.trim()) {
    issues.push({
      path: `flow.nodes.${single.agent.id}.provider`,
      message: "Provider is required",
    });
  }
  return issues;
}
