// Adapted from T3 Code apps/web/src/lib/assistantTextSelection.ts (MIT, © 2026 T3 Tools Inc.).
import type { AnnotationTextSelector } from "./model";

const CONTEXT_LENGTH = 32;
const EXCLUDED =
  '[data-pimi-markdown-ignore="true"], [aria-hidden="true"], [hidden], button, [role="button"], input, textarea, select, svg, script, style, template, noscript';
const BLOCKS =
  "address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul";

interface TextChunk {
  node: Text;
  start: number;
  end: number;
}

interface TextStream {
  text: string;
  chunks: TextChunk[];
}

interface TextMatch {
  start: number;
  end: number;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** The message's rendered text in reading order, with a line break between blocks. */
function readText(contents: readonly HTMLElement[]): TextStream {
  const parts: string[] = [];
  const chunks: TextChunk[] = [];
  let length = 0;
  let separator = false;

  function append(node: Text) {
    if (separator && length > 0) {
      parts.push("\n");
      length += 1;
    }
    separator = false;
    chunks.push({ node, start: length, end: length + node.data.length });
    parts.push(node.data);
    length += node.data.length;
  }
  function visit(node: Node) {
    if (node instanceof Text) {
      if (node.data.length > 0) append(node);
      return;
    }
    if (!(node instanceof Element) || node.matches(EXCLUDED)) return;
    const block = node.matches(BLOCKS);
    if (block || node.tagName === "BR") separator = true;
    for (const child of node.childNodes) visit(child);
    if (block) separator = true;
  }

  for (const content of contents) {
    separator = true;
    visit(content);
  }
  return { text: parts.join(""), chunks };
}

function createTextSelector(
  text: string,
  rawStart: number,
  rawEnd: number,
): AnnotationTextSelector | null {
  const quote = text.slice(rawStart, rawEnd);
  if (quote.trim().length === 0) return null;

  const normalized = normalizeWhitespace(text);
  let start = normalizeWhitespace(text.slice(0, rawStart)).length;
  const startsInsideWhitespace =
    rawStart > 0 && /\s/.test(text.charAt(rawStart - 1)) && /\s/.test(text.charAt(rawStart));
  if (startsInsideWhitespace) start -= 1;
  const end = normalizeWhitespace(text.slice(0, rawEnd)).length;
  let prefixStart = Math.max(0, start - CONTEXT_LENGTH);
  let suffixEnd = Math.min(normalized.length, end + CONTEXT_LENGTH);
  if (splitsSurrogatePair(normalized, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(normalized, suffixEnd)) suffixEnd -= 1;
  return {
    text: quote,
    prefix: normalized.slice(prefixStart, start),
    suffix: normalized.slice(end, suffixEnd),
  };
}

/**
 * Offsets into whitespace-normalized text. The surrounding context picks between repeated
 * quotes; a quote that appears once is found without it, which is how a draft saved without
 * context still resolves.
 */
function findSelectorText(text: string, selector: AnnotationTextSelector): TextMatch | null {
  const normalized = normalizeWhitespace(text);
  const quote = normalizeWhitespace(selector.text);
  if (quote.trim().length === 0) return null;
  const prefix = normalizeWhitespace(selector.prefix);
  const suffix = normalizeWhitespace(selector.suffix);

  let contextMatch: TextMatch | null = null;
  let contextCount = 0;
  let onlyQuote: TextMatch | null = null;
  let quoteCount = 0;
  for (
    let start = normalized.indexOf(quote);
    start !== -1;
    start = normalized.indexOf(quote, start + 1)
  ) {
    const end = start + quote.length;
    quoteCount += 1;
    onlyQuote = { start, end };
    const matchesContext =
      normalized.slice(Math.max(0, start - prefix.length), start) === prefix &&
      normalized.slice(end, end + suffix.length) === suffix;
    if (!matchesContext) continue;
    contextCount += 1;
    contextMatch = { start, end };
  }
  if (contextCount === 1) return contextMatch;
  return quoteCount === 1 ? onlyQuote : null;
}

function rawTextOffset(text: string, normalizedOffset: number): number {
  let offset = 0;
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const whitespace = /\s/.test(match[0].charAt(0));
    const length = whitespace ? 1 : match[0].length;
    if (normalizedOffset <= offset + length) {
      const inside =
        whitespace && normalizedOffset > offset ? match[0].length : normalizedOffset - offset;
      return match.index + inside;
    }
    offset += length;
  }
  return text.length;
}

/** The quote's current range in the rendered message, or null when it is no longer there. */
export function resolveSelectorRange(
  contents: readonly HTMLElement[],
  selector: AnnotationTextSelector,
): Range | null {
  const stream = readText(contents);
  const match = findSelectorText(stream.text, selector);
  if (!match) return null;
  const start = rawTextOffset(stream.text, match.start);
  const end = rawTextOffset(stream.text, match.end);
  const first = stream.chunks.find((chunk) => chunk.end > start);
  let last: TextChunk | undefined;
  for (const chunk of stream.chunks) {
    if (chunk.start < end) last = chunk;
  }
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, Math.max(0, start - first.start));
  range.setEnd(last.node, Math.min(last.node.length, end - last.start));
  return range.collapsed ? null : range;
}

/** A selector for the part of the message a selection covers. */
export function captureTextSelector(
  contents: readonly HTMLElement[],
  range: Range,
): AnnotationTextSelector | null {
  const stream = readText(contents);
  let rawStart: number | null = null;
  let rawEnd = 0;
  for (const chunk of stream.chunks) {
    if (!range.intersectsNode(chunk.node)) continue;
    const start = range.startContainer === chunk.node ? range.startOffset : 0;
    const end = range.endContainer === chunk.node ? range.endOffset : chunk.end - chunk.start;
    if (start === end) continue;
    rawStart ??= chunk.start + start;
    rawEnd = chunk.start + end;
  }
  if (rawStart === null) return null;
  return createTextSelector(stream.text, rawStart, rawEnd);
}
