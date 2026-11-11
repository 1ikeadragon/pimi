import { styleText } from "node:util";

export type TextStyle = Parameters<typeof styleText>[0];

// chalk read --no-color from argv for callers that never see the parsed option; keep that.
const colorDisabledByFlag = process.argv.includes("--no-color");

/**
 * Colors text when stdout supports it, the way chalk decided: a TTY, FORCE_COLOR, TERM.
 * Node also honors NO_COLOR, which chalk ignored.
 */
export function style(format: TextStyle, text: string): string {
  if (colorDisabledByFlag) return text;
  return styleText(format, text, { stream: process.stdout });
}
