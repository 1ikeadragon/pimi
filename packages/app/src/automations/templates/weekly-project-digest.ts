import type { AutomationTemplate } from "../automation-templates";

export const WEEKLY_PROJECT_DIGEST_TEMPLATE: AutomationTemplate = {
  id: "weekly-project-digest",
  name: "Weekly project digest",
  description: "Summarize what shipped and what needs attention.",
  cadence: { type: "cron", expression: "0 9 * * 1" },
  prompt: `Write a short digest of what changed in this project over the past seven days, for someone who was away.

Read the default branch's commits from that period. Group the changes by what a user or a developer would notice: new behaviour, fixes, and internal changes worth knowing about. Lead with the two or three that matter most. Link the commit or pull request for each item when you can.

Then list follow-ups you can verify from the repository itself, such as work marked unfinished in the code or a change that was reverted. Do not guess at plans.

If nothing changed, say so in one line. Leave the repository unchanged.`,
};
