// Pimi addition to the Paseo fork. Apache-2.0.
import { z } from "zod";

export const PimiTaskFields = z.object({
  title: z.string().trim().min(1).max(100),
  brief: z.string().trim().min(1).max(2400),
});

export const PimiExperimentFields = z.object({
  title: z.string().trim().min(1).max(55),
  hypothesis: z.string().trim().min(1).max(1600),
});

export const PimiTaskProposalInput = PimiTaskFields.extend({
  experiments: z.array(PimiExperimentFields).max(4).optional(),
});

export const PimiTaskSource = z.object({
  serverId: z.string().trim().min(1).max(256),
  agentId: z.string().trim().min(1).max(256),
});

export const PimiTaskProposal = PimiTaskProposalInput.extend({
  id: z.uuid(),
  source: PimiTaskSource,
});

export type PimiTaskProposal = z.infer<typeof PimiTaskProposal>;
export type PimiDestination =
  | { view: "tasks" | "worktrees" | "review-home" }
  | { view: "review"; path: string; serverId?: string }
  | { view: "task-draft"; proposal: PimiTaskProposal };

export const PIMI_TASK_PROPOSAL_TOOL = "propose_pimi_task";
export const PimiTaskProposalResult = z.object({ pimiTaskProposal: PimiTaskProposal });
export const PIMI_REVIEW_SUGGESTION_TOOL = "suggest_pimi_review";
export const PimiReviewSuggestionInput = z.object({
  summary: z.string().trim().min(1).max(300).optional(),
});
export const PimiReviewSuggestion = PimiReviewSuggestionInput.extend({
  path: z.string().min(1),
  source: PimiTaskSource,
});
export type PimiReviewSuggestion = z.infer<typeof PimiReviewSuggestion>;
export const PimiReviewSuggestionResult = z.object({ pimiReviewSuggestion: PimiReviewSuggestion });

function matchesToolName(name: string, tool: string): boolean {
  return (
    name === tool ||
    name === `paseo.${tool}` ||
    name === `mcp__paseo__${tool}` ||
    name === `paseo_${tool}`
  );
}

export function isPimiTaskProposalTool(name: string): boolean {
  return matchesToolName(name, PIMI_TASK_PROPOSAL_TOOL);
}

export function isPimiReviewSuggestionTool(name: string): boolean {
  return matchesToolName(name, PIMI_REVIEW_SUGGESTION_TOOL);
}

export function isPimiActionTool(name: string): boolean {
  return isPimiTaskProposalTool(name) || isPimiReviewSuggestionTool(name);
}
