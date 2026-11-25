// The form two prompts are compared in: Recap's "go-to prompt" and prompt suggestions both count
// repeats, and must agree on what a repeat is.
export function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
}
