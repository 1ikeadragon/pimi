import type { StyleProp, TextStyle } from "react-native";
import { BARE_URL } from "@/components/markdown/source";

const URL_PATTERN = new RegExp(BARE_URL, "g");

export interface UserMessageTextProps {
  message: string;
  style: StyleProp<TextStyle>;
  dataSet: Record<string, string>;
}

export interface TextRun {
  /** Offset in the message; unique per run, so it keys the rendered run. */
  start: number;
  text: string;
  url: string | null;
}

export function splitRuns(message: string): TextRun[] {
  const runs: TextRun[] = [];
  let cursor = 0;
  for (const match of message.matchAll(URL_PATTERN)) {
    if (match.index > cursor)
      runs.push({ start: cursor, text: message.slice(cursor, match.index), url: null });
    runs.push({ start: match.index, text: match[0], url: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length) runs.push({ start: cursor, text: message.slice(cursor), url: null });
  return runs;
}
