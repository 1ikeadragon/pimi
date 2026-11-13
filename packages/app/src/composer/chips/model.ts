import { annotationChipLabel, type AnnotationAttachment } from "@/annotations/model";
import { i18n } from "@/i18n/i18next";
import type { AgentAttachment } from "@pimi/protocol/messages";

/**
 * A chip is one Private Use Area code unit in the draft text: `U+E000 + slot`. The slot is the
 * annotation's identity inside its draft. One code unit means cut, paste, Backspace and selection
 * math treat a chip like any other character, and its position in the text is its position in the
 * message. The characters never leave the client; `serializeChipText` rewrites them for the wire.
 */
const CHIP_BASE = 0xe000;
export const MAX_CHIPS = 32;
/** The inside of a character class matching any chip, for building larger patterns. */
export const CHIP_CHARACTER_CLASS = `\\u${CHIP_BASE.toString(16)}-\\u${(CHIP_BASE + MAX_CHIPS - 1).toString(16)}`;
export const CHIP_CHARACTERS = new RegExp(`[${CHIP_CHARACTER_CLASS}]`, "g");

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
  for (const match of text.matchAll(CHIP_CHARACTERS)) {
    positions.push({ slot: chipSlot(match[0]), index: match.index });
  }
  return positions;
}

export function stripChips(text: string): string {
  return text.replace(CHIP_CHARACTERS, "");
}

/** The text reduced to its chips, for commands that consume the typed words and keep the chips. */
export function chipsOnly(text: string): string {
  return chipPositions(text)
    .map((chip) => chipChar(chip.slot))
    .join("");
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
    super(i18n.t("chips.limitReached", { count: MAX_CHIPS }));
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
  const serialized = text.replace(CHIP_CHARACTERS, (char) => {
    const annotation = bySlot.get(chipSlot(char));
    if (!annotation || placed.includes(annotation)) return "";
    placed.push(annotation);
    return chipMarker(placed.length);
  });
  const unplaced = annotations.filter((annotation) => !placed.includes(annotation));
  return { text: serialized, annotations: [...placed, ...unplaced] };
}

export interface ChipTextChange {
  /** Text with chips that need it rewritten or dropped: strays, and duplicates given new slots. */
  text: string;
  annotations: AnnotationAttachment[];
  /** Annotations whose chip is gone from the text, kept so undo can bring the chip back. */
  detached: AnnotationAttachment[];
}

/**
 * Brings a draft's annotations in line with an edit of its text. A chip that vanished detaches its
 * annotation; one that came back (undo) reattaches it; one that appeared twice (copy and paste) is
 * cloned with a new id and slot; one that names no annotation is dropped. Annotations whose chip
 * was never in the text are left alone: the composer is still about to place it.
 */
export function reconcileAfterTextChange(input: {
  prevText: string;
  nextText: string;
  annotations: readonly AnnotationAttachment[];
  detached: readonly AnnotationAttachment[];
  newId: () => string;
}): ChipTextChange {
  const annotations = [...input.annotations];
  let detached = [...input.detached];
  const wasPlaced = new Set(chipPositions(input.prevText).map((chip) => chip.slot));
  const claimed = new Set<number>();
  const taken = () => new Set([...annotations, ...detached].map((annotation) => annotation.slot));
  const text = input.nextText.replace(CHIP_CHARACTERS, (char) => {
    const slot = chipSlot(char);
    const live = annotations.find((annotation) => annotation.slot === slot);
    const stashed = detached.find((annotation) => annotation.slot === slot);
    const source = live ?? stashed;
    if (!source) return "";
    if (!claimed.has(slot)) {
      claimed.add(slot);
      if (!live && stashed) {
        detached = detached.filter((annotation) => annotation !== stashed);
        annotations.push(stashed);
      }
      return char;
    }
    const freeSlot = lowestFreeSlot(taken());
    if (freeSlot === null) return "";
    annotations.push({ ...source, id: input.newId(), slot: freeSlot });
    claimed.add(freeSlot);
    return chipChar(freeSlot);
  });
  const kept: AnnotationAttachment[] = [];
  for (const annotation of annotations) {
    const vanished = wasPlaced.has(annotation.slot) && !claimed.has(annotation.slot);
    if (vanished) detached.push(annotation);
    else kept.push(annotation);
  }
  return { text, annotations: kept, detached };
}

export interface ChipPlacement {
  text: string;
  caret: number;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Keeps the text's chips in line with the draft's annotations: a chip whose annotation is gone
 * (removed by a plugin or the tray) is dropped, and an annotation with no chip gets one at the
 * caret, padded with a space where it would touch a word. Returns null when nothing changes.
 */
export function reconcileAfterAttachmentsChange(input: {
  text: string;
  caret: number;
  annotations: readonly AnnotationAttachment[];
}): ChipPlacement | null {
  const slots = new Set(input.annotations.map((annotation) => annotation.slot));
  let caret = input.caret;
  let text = "";
  for (let index = 0; index < input.text.length; index += 1) {
    const char = input.text[index];
    if (isChipChar(char) && !slots.has(chipSlot(char))) {
      if (index < input.caret) caret -= 1;
      continue;
    }
    text += char;
  }
  const placed = new Set(chipPositions(text).map((chip) => chip.slot));
  for (const annotation of input.annotations) {
    if (placed.has(annotation.slot)) continue;
    const before = text[caret - 1];
    const after = text[caret];
    const lead = before && WORD_CHARACTER.test(before) ? " " : "";
    const trail = after && WORD_CHARACTER.test(after) ? " " : "";
    const insertion = `${lead}${chipChar(annotation.slot)}${trail}`;
    text = text.slice(0, caret) + insertion + text.slice(caret);
    caret += lead.length + 1;
  }
  return text === input.text ? null : { text, caret };
}

/** The draft's text with each chip spelled out as `[label]`, for places that cannot draw a chip. */
export function chipPreviewText(
  text: string,
  annotations: readonly AnnotationAttachment[],
): string {
  const bySlot = new Map(annotations.map((annotation) => [annotation.slot, annotation]));
  return text.replace(CHIP_CHARACTERS, (char) => {
    const annotation = bySlot.get(chipSlot(char));
    return annotation ? `[${annotationChipLabel(annotation)}]` : "";
  });
}

const SENT_MARKER = /\[annotation (\d+)\]/g;

export interface RestoredChips {
  /** The sent text with its markers turned back into chips (or dropped, when nothing backs them). */
  text: string;
  annotations: AnnotationAttachment[];
}

/**
 * Turns a sent message back into draft form: each `[annotation N]` marker that has its annotation
 * becomes a chip with a new id and slot. Without attachments (a message paged in from the daemon
 * carries text only) the markers are dropped, since nothing could open them.
 */
export function restoreSentChips(input: {
  text: string;
  attachments: readonly AgentAttachment[];
  /** Slots the draft already uses. */
  reserved: readonly number[];
  newId: () => string;
}): RestoredChips {
  const byRef = new Map<
    number,
    NonNullable<Extract<AgentAttachment, { type: "text" }>["annotation"]>
  >();
  for (const attachment of input.attachments) {
    if (attachment.type === "text" && attachment.annotation?.ref !== undefined)
      byRef.set(attachment.annotation.ref, attachment.annotation);
  }
  const annotations: AnnotationAttachment[] = [];
  const text = input.text.replace(SENT_MARKER, (marker, digits: string) => {
    const metadata = byRef.get(Number(digits));
    if (!metadata) return input.attachments.length === 0 ? "" : marker;
    const slot = lowestFreeSlot([
      ...input.reserved,
      ...annotations.map((annotation) => annotation.slot),
    ]);
    if (slot === null) return "";
    byRef.delete(Number(digits));
    annotations.push({
      kind: "annotation",
      id: input.newId(),
      slot,
      source: metadata.source,
      quote: metadata.quote,
      note: metadata.note,
      ...(metadata.selector ? { selector: metadata.selector } : {}),
    });
    return chipChar(slot);
  });
  return { text, annotations };
}

const NUMERAL_RANGES = [
  { first: 0x2460, count: 20 },
  { first: 0x3251, count: 12 },
] as const;

/** The circled numeral standing for a slot where the text input cannot draw a chip (native). */
export function circledNumeral(slot: number): string {
  const range = slot < NUMERAL_RANGES[0].count ? NUMERAL_RANGES[0] : NUMERAL_RANGES[1];
  const offset = range === NUMERAL_RANGES[0] ? slot : slot - NUMERAL_RANGES[0].count;
  return String.fromCharCode(range.first + offset);
}

function numeralSlot(char: string): number | null {
  const code = char.charCodeAt(0);
  const [first, second] = NUMERAL_RANGES;
  if (code >= first.first && code < first.first + first.count) return code - first.first;
  if (code >= second.first && code < second.first + second.count)
    return first.count + code - second.first;
  return null;
}

/** Chip characters to circled numerals, one for one, so offsets are the same in both forms. */
export function chipsToNumerals(text: string): string {
  return text.replace(CHIP_CHARACTERS, (char) => circledNumeral(chipSlot(char)));
}

/** The reverse: circled numerals typed or pasted by the user become chips too. */
export function numeralsToChips(text: string): string {
  let out = "";
  for (const char of text) {
    const slot = numeralSlot(char);
    out += slot === null ? char : chipChar(slot);
  }
  return out;
}
