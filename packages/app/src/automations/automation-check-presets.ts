import type { AutomationConditionOperator } from "@pimi/protocol/automation/types";

export type CheckPresetId =
  | "startsYes"
  | "pass"
  | "mention"
  | "notMention"
  | "anything"
  | "base"
  | "author";

export interface CheckPreset {
  id: CheckPresetId;
  operator: AutomationConditionOperator;
  value: string;
  /** Reads a pull request field instead of the previous step's reply. */
  input: string | null;
  pullRequestOnly: boolean;
  /** An instruction the source step's prompt needs for the check to work, by i18n key. */
  promptLine: "lineYesNo" | "linePassFail" | null;
}

export const CHECK_PRESETS: readonly CheckPreset[] = [
  {
    id: "startsYes",
    operator: "starts_with",
    value: "YES",
    input: null,
    pullRequestOnly: false,
    promptLine: "lineYesNo",
  },
  {
    id: "pass",
    operator: "starts_with",
    value: "PASS",
    input: null,
    pullRequestOnly: false,
    promptLine: "linePassFail",
  },
  {
    id: "mention",
    operator: "contains",
    value: "",
    input: null,
    pullRequestOnly: false,
    promptLine: null,
  },
  {
    id: "notMention",
    operator: "not_contains",
    value: "",
    input: null,
    pullRequestOnly: false,
    promptLine: null,
  },
  {
    id: "anything",
    operator: "not_empty",
    value: "",
    input: null,
    pullRequestOnly: false,
    promptLine: null,
  },
  {
    id: "base",
    operator: "equals",
    value: "",
    input: "{{trigger.baseRef}}",
    pullRequestOnly: true,
    promptLine: null,
  },
  {
    id: "author",
    operator: "equals",
    value: "",
    input: "{{trigger.author}}",
    pullRequestOnly: true,
    promptLine: null,
  },
];

/** Operators in the order the picker lists them. */
export const CHECK_OPERATORS: readonly AutomationConditionOperator[] = [
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "equals",
  "not_equals",
  "is_empty",
  "not_empty",
  "matches",
];

export const CUSTOM_SOURCE = "__custom__";

const STEP_OUTPUT = /^\{\{\s*steps\.([A-Za-z0-9_-]+)\.output\s*\}\}$/;

/** The step whose reply a check input reads, or null for a pull request field or custom text. */
export function sourceStepId(input: string): string | null {
  return STEP_OUTPUT.exec(input.trim())?.[1] ?? null;
}
