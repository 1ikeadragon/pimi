import { validateAutomationGraph, type AutomationIssue } from "../automation/validate.js";
import { FLOW_NAME_PATTERN, MAX_FLOW_NAME_LENGTH, type FlowDefinition } from "./types.js";

export function validateFlowDefinition(definition: FlowDefinition): AutomationIssue[] {
  const issues: AutomationIssue[] = [];
  const name = definition.name;
  if (!name.trim()) {
    issues.push({ path: "name", message: "Name is required", code: "name_required" });
  } else if (name.length > MAX_FLOW_NAME_LENGTH || !FLOW_NAME_PATTERN.test(name)) {
    issues.push({
      path: "name",
      message: `Name must be lowercase letters, digits, - and _ (at most ${MAX_FLOW_NAME_LENGTH}), such as research-report`,
      code: "bad_name",
    });
  }
  issues.push(...validateAutomationGraph(definition.flow, { triggerKind: null, allowInput: true }));
  return issues;
}
