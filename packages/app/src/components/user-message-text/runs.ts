import type { StyleProp, TextStyle } from "react-native";
import type { AnnotationAttachmentMetadata } from "@pimi/protocol/messages";
import { BARE_URL } from "@/components/markdown/source";

const URL_PATTERN = new RegExp(BARE_URL, "g");

const CHIP_MARKER = /\[annotation (\d+)\]/g;

export type SentAnnotations = ReadonlyMap<number, AnnotationAttachmentMetadata>;

export const NO_SENT_ANNOTATIONS: SentAnnotations = new Map();

export interface UserMessageTextProps {
  message: string;
  /** The annotations the message carries, by the N of their `[annotation N]` marker. */
  annotations: SentAnnotations;
  style: StyleProp<TextStyle>;
  dataSet: Record<string, string>;
}

export interface TextRun {
  /** Offset in the message; unique per run, so it keys the rendered run. */
  start: number;
  text: string;
  url: string | null;
  /** N of an `[annotation N]` marker drawn as a chip. */
  chip: number | null;
}

/** The markers in the text that have an annotation to draw, first occurrence of each. */
export function placedChipRefs(message: string, annotations: SentAnnotations): Set<number> {
  const placed = new Set<number>();
  for (const match of message.matchAll(CHIP_MARKER)) {
    const ref = Number(match[1]);
    if (annotations.has(ref)) placed.add(ref);
  }
  return placed;
}

function splitChips(
  text: string,
  offset: number,
  drawn: Set<number>,
  annotations: SentAnnotations,
) {
  const runs: TextRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CHIP_MARKER)) {
    const ref = Number(match[1]);
    if (!annotations.has(ref) || drawn.has(ref)) continue;
    drawn.add(ref);
    if (match.index > cursor)
      runs.push({
        start: offset + cursor,
        text: text.slice(cursor, match.index),
        url: null,
        chip: null,
      });
    runs.push({ start: offset + match.index, text: match[0], url: null, chip: ref });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length)
    runs.push({ start: offset + cursor, text: text.slice(cursor), url: null, chip: null });
  return runs;
}

export function splitRuns(message: string, annotations: SentAnnotations): TextRun[] {
  const runs: TextRun[] = [];
  const drawn = new Set<number>();
  let cursor = 0;
  for (const match of message.matchAll(URL_PATTERN)) {
    if (match.index > cursor)
      runs.push(...splitChips(message.slice(cursor, match.index), cursor, drawn, annotations));
    runs.push({ start: match.index, text: match[0], url: match[0], chip: null });
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length)
    runs.push(...splitChips(message.slice(cursor), cursor, drawn, annotations));
  return runs;
}
