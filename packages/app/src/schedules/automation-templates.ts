// Pimi addition to the Paseo fork. Apache-2.0.
import type { ScheduleCadence } from "@pimi/protocol/schedule/types";

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  cadence: Extract<ScheduleCadence, { type: "cron" }>;
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: "weekday-pr-review",
    name: "Weekday PR review",
    description: "Find likely bugs in open pull requests.",
    prompt:
      "Review open, non-draft pull requests for this repository with commits from the last 24 hours. Read the diffs and nearby code. Report likely bugs or security issues with a file, line, and explanation. Say when no pull requests match or when repository access prevents review. Leave the repository and pull requests unchanged.",
    cadence: { type: "cron", expression: "0 9 * * 1-5" },
  },
  {
    id: "weekly-project-digest",
    name: "Weekly project digest",
    description: "Summarize what shipped and what needs attention.",
    prompt:
      "Read the default branch's commits from the past seven days. Group the user-facing changes and fixes into a short digest. Link to relevant commits or pull requests when available and flag any unfinished follow-ups you can verify. Leave the repository unchanged.",
    cadence: { type: "cron", expression: "0 9 * * 1" },
  },
];
