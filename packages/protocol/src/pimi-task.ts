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
  | { view: "tasks" | "worktrees" }
  | { view: "review"; path: string }
  | { view: "task-draft"; proposal: PimiTaskProposal };

export const PIMI_TASK_PROPOSAL_TOOL = "propose_pimi_task";
export const PimiTaskProposalResult = z.object({ pimiTaskProposal: PimiTaskProposal });

export function isPimiTaskProposalTool(name: string): boolean {
  return (
    name === PIMI_TASK_PROPOSAL_TOOL ||
    name === `paseo.${PIMI_TASK_PROPOSAL_TOOL}` ||
    name === `mcp__paseo__${PIMI_TASK_PROPOSAL_TOOL}` ||
    name === `paseo_${PIMI_TASK_PROPOSAL_TOOL}`
  );
}
