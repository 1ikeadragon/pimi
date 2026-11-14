// Pimi. PolyForm-Noncommercial-1.0.0.
// Stream S5: the text prefilled into the composer. The thread and check bodies travel as context
// attachments; the prompt only names what to fix and sets the guard rails.
import type { ReviewCheck, ReviewThread } from "../use-review-timeline";

export function describeThread(thread: ReviewThread): string {
  const where = thread.path
    ? `${thread.path}${thread.line ? `:${thread.line}` : ""}`
    : "a general discussion";
  return `${where}: ${thread.summary || "review thread"}`;
}

export function buildFixPrompt(input: {
  title: string;
  number: number;
  threads: readonly ReviewThread[];
  checks: readonly ReviewCheck[];
  note: string;
}): string {
  const lines = [`Fix the following on pull request #${input.number} (${input.title}).`, ""];
  if (input.checks.length > 0) {
    lines.push("Failing checks (log tail and annotations are attached):");
    for (const check of input.checks) lines.push(`- ${check.name}`);
    lines.push("");
  }
  if (input.threads.length > 0) {
    lines.push("Review threads (full conversation attached):");
    for (const thread of input.threads) lines.push(`- ${describeThread(thread)}`);
    lines.push("");
  }
  const note = input.note.trim();
  if (note) lines.push(note, "");
  lines.push("Make the changes locally. Do not commit, push, or comment on the pull request.");
  return lines.join("\n");
}
