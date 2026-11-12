import type { AttackRun, Finding } from "@pimi/protocol/attack/types";

// The prompt "Fix it" seeds a normal agent with. Agent-facing text, so it is not translated.
export function buildFixPrompt(run: AttackRun, finding: Finding): string {
  const evidence = finding.evidence
    .filter((item) => item.kind !== "screenshot")
    .map((item) => `- ${item.caption}\n${"excerpt" in item ? item.excerpt : ""}`)
    .join("\n");
  return `An Attack run found a ${finding.severity} defect in this app (${run.target}). Fix it in this repository.

Title: ${finding.title}
Where: ${finding.route}
Category: ${finding.category}

What goes wrong:
${finding.description}

Reproduce:
${finding.repro}
${evidence ? `\nEvidence:\n${evidence}\n` : ""}
Find the cause, make the smallest change that fixes it, and run the reproduction again to confirm it no longer happens. Do not widen the change beyond this defect. Summarise what you changed and what you verified.`;
}
