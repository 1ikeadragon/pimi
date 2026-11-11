import type { AutomationTemplate } from "../automation-templates";

export const WEEKDAY_PR_REVIEW_TEMPLATE: AutomationTemplate = {
  id: "weekday-pr-review",
  name: "Weekday PR review",
  description: "Find likely bugs in open pull requests.",
  cadence: { type: "cron", expression: "0 9 * * 1-5" },
  prompt: `Review the open pull requests in this repository that are not drafts and have commits from
the last 24 hours. For each one, read the diff and the code around it and look for likely
bugs and security problems.

Report per pull request: its number and title, then each finding with file, line, what goes
wrong, and what triggers it. If a pull request looks sound, say what you checked. If no pull
request matches, or you cannot reach the repository's pull requests, say that in the first
line and stop.

Leave the repository and every pull request unchanged.`,
};
