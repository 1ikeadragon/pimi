import { FLOW_NAME_PATTERN, MAX_FLOW_NAME_LENGTH } from "../flow/types.js";
import { MAX_SAVED_PROMPT_TEXT_LENGTH, type SavedPromptDefinition } from "./types.js";

export type PromptIssueCode = "name_required" | "bad_name" | "text_required" | "text_too_long";

// `code` lets an editor word the issue itself; `message` is the English text the daemon shows.
export interface PromptIssue {
  field: "name" | "text";
  code: PromptIssueCode;
  message: string;
}

export function validatePromptDefinition(definition: SavedPromptDefinition): PromptIssue[] {
  const issues: PromptIssue[] = [];
  const name = definition.name;
  if (!name.trim()) {
    issues.push({ field: "name", code: "name_required", message: "Name is required" });
  } else if (name.length > MAX_FLOW_NAME_LENGTH || !FLOW_NAME_PATTERN.test(name)) {
    issues.push({
      field: "name",
      code: "bad_name",
      message: `Name must be lowercase letters, digits, - and _ (at most ${MAX_FLOW_NAME_LENGTH}), such as review-diff`,
    });
  }
  if (!definition.text.trim()) {
    issues.push({ field: "text", code: "text_required", message: "Prompt text is required" });
  } else if (definition.text.length > MAX_SAVED_PROMPT_TEXT_LENGTH) {
    issues.push({
      field: "text",
      code: "text_too_long",
      message: `Prompt text must be at most ${MAX_SAVED_PROMPT_TEXT_LENGTH} characters`,
    });
  }
  return issues;
}
