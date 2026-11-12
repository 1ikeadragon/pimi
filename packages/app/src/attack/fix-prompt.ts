import type { AttackRun, Finding } from "@pimi/protocol/attack/types";

// The prompt "Fix it" seeds a normal agent with. Agent-facing text, so it is not translated.
export function buildFixPrompt(run: AttackRun, finding: Finding): string {
  const evidence = finding.evidence
    .filter((item) => item.kind !== "screenshot")
    .map((item) => `- ${item.caption}\n${"excerpt" in item ? item.excerpt : ""}`)
    .join("\n");
  const notes = finding.annotationLabels
    .map((label) => run.annotations.find((item) => item.label === label))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .map((item) => {
      const lines = [`- ${item.label}: ${item.note.trim() || "(no note)"}`];
      lines.push(`  element: <${item.tag}> ${item.selector} on ${item.url}`);
      return lines.join("\n");
    })
    .join("\n");
  return `An Attack run found a ${finding.severity} defect in this app (${run.target}). Fix it in this repository.

Title: ${finding.title}
Where: ${finding.route}
Category: ${finding.category}

What goes wrong:
${finding.description}

Reproduce:
${finding.repro}
${evidence ? `\nEvidence:\n${evidence}\n` : ""}${notes ? `\nThe owner marked this element and wrote the note below before the run; the defect answers it:\n${notes}\n` : ""}
Find the cause, make the smallest change that fixes it, and run the reproduction again to confirm it no longer happens. Do not widen the change beyond this defect. Summarise what you changed and what you verified.`;
}
