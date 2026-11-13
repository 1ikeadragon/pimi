import type { AnnotationAttachment } from "@/annotations/model";

/**
 * A chip is one Private Use Area code unit in the draft text: `U+E000 + slot`. The slot is the
 * annotation's identity inside its draft. One code unit means cut, paste, Backspace and selection
 * math treat a chip like any other character, and its position in the text is its position in the
 * message. The characters never leave the client; `serializeChipText` rewrites them for the wire.
 */
const CHIP_BASE = 0xe000;
export const MAX_CHIPS = 32;
const CHIP_PATTERN = /[-]/g;

export function chipChar(slot: number): string {
  return String.fromCharCode(CHIP_BASE + slot);
}

export function isChipChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= CHIP_BASE && code < CHIP_BASE + MAX_CHIPS;
}

export function chipSlot(char: string): number {
  return char.charCodeAt(0) - CHIP_BASE;
}

export interface ChipPosition {
  slot: number;
  index: number;
}

export function chipPositions(text: string): ChipPosition[] {
  const positions: ChipPosition[] = [];
  for (const match of text.matchAll(CHIP_PATTERN)) {
    positions.push({ slot: chipSlot(match[0]), index: match.index });
  }
  return positions;
}

export function stripChips(text: string): string {
  return text.replace(CHIP_PATTERN, "");
}

export function lowestFreeSlot(used: Iterable<number>): number | null {
  const taken = new Set(used);
  for (let slot = 0; slot < MAX_CHIPS; slot += 1) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

export class AnnotationLimitError extends Error {
  constructor() {
    super(`A message can carry at most ${MAX_CHIPS} annotations`);
    this.name = "AnnotationLimitError";
  }
}

export function annotationsOf<T extends { kind: string }>(
  attachments: readonly T[],
): Array<T & AnnotationAttachment> {
  return attachments.filter(
    (attachment): attachment is T & AnnotationAttachment => attachment.kind === "annotation",
  );
}

export function chipMarker(ref: number): string {
  return `[annotation ${ref}]`;
}

export interface SerializedChipText {
  text: string;
  /** Annotations in ref order: the chips as they sit in the text, then any without a chip. */
  annotations: AnnotationAttachment[];
}

/**
 * Rewrites each chip to `[annotation N]`, numbered in text order, and orders the annotations to
 * match. A chip with no annotation, or a second chip for an annotation already placed, is dropped.
 * An annotation with no chip is still sent, numbered after the placed ones, with no marker.
 */
export function serializeChipText(
  text: string,
  annotations: readonly AnnotationAttachment[],
): SerializedChipText {
  const bySlot = new Map(annotations.map((annotation) => [annotation.slot, annotation]));
  const placed: AnnotationAttachment[] = [];
  const serialized = text.replace(CHIP_PATTERN, (char) => {
    const annotation = bySlot.get(chipSlot(char));
    if (!annotation || placed.includes(annotation)) return "";
    placed.push(annotation);
    return chipMarker(placed.length);
  });
  const unplaced = annotations.filter((annotation) => !placed.includes(annotation));
  return { text: serialized, annotations: [...placed, ...unplaced] };
}
