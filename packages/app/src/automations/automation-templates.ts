// Pimi addition to the Paseo fork. Apache-2.0.
import type { Cadence } from "@pimi/protocol/schedule/cadence";
import { WEEKDAY_PR_REVIEW_TEMPLATE } from "./templates/weekday-pr-review";
import { WEEKLY_PROJECT_DIGEST_TEMPLATE } from "./templates/weekly-project-digest";

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  cadence: Extract<Cadence, { type: "cron" }>;
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  WEEKDAY_PR_REVIEW_TEMPLATE,
  WEEKLY_PROJECT_DIGEST_TEMPLATE,
];
