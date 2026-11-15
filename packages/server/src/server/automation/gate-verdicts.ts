export interface GateVerdict {
  pass: boolean;
  feedback: string;
}

export type SubmitVerdictOutcome = "recorded" | "not_a_judge" | "already_recorded";

// Verdicts judge agents file with the `submit_verdict` tool, keyed by the judge's agent id. A
// run opens a slot before it prompts the judge and takes the verdict after the turn. Only an
// agent with an open slot can file one, which is what scopes the tool to gate judges.
export class GateVerdictBoard {
  private readonly slots = new Map<string, GateVerdict | null>();

  open(agentId: string): void {
    this.slots.set(agentId, null);
  }

  submit(agentId: string, verdict: GateVerdict): SubmitVerdictOutcome {
    if (!this.slots.has(agentId)) {
      return "not_a_judge";
    }
    if (this.slots.get(agentId) !== null) {
      return "already_recorded";
    }
    this.slots.set(agentId, verdict);
    return "recorded";
  }

  take(agentId: string): GateVerdict | null {
    const verdict = this.slots.get(agentId) ?? null;
    this.slots.delete(agentId);
    return verdict;
  }

  discard(agentId: string): void {
    this.slots.delete(agentId);
  }
}
