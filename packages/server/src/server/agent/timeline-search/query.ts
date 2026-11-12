import { CHAT_SEARCH_LIMITS } from "@pimi/protocol/chat-search";

const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

export type ParsedChatQuery = { ok: true; match: string } | { ok: false; reason: string };

/**
 * Turn what the user typed into an FTS5 MATCH expression. The text is never passed through:
 * every term becomes a double-quoted string (inner quotes doubled), so FTS operators, column
 * filters, `NEAR`, `*` and parentheses in the input are plain text. Terms are ANDed; a
 * "quoted phrase" stays a phrase; the last unquoted term also matches as a prefix, so results
 * appear while typing.
 */
export function parseChatQuery(raw: string): ParsedChatQuery {
  const query = raw.trim();
  if (query.length < CHAT_SEARCH_LIMITS.minQueryLength) {
    return { ok: false, reason: `Type at least ${CHAT_SEARCH_LIMITS.minQueryLength} characters.` };
  }
  if (query.length > CHAT_SEARCH_LIMITS.maxQueryLength) {
    return {
      ok: false,
      reason: `Search text is limited to ${CHAT_SEARCH_LIMITS.maxQueryLength} characters.`,
    };
  }
  const terms: Array<{ text: string; phrase: boolean }> = [];
  const pattern = /"([^"]*)"|(\S+)/gu;
  for (const match of query.matchAll(pattern)) {
    const phrase = match[1] !== undefined;
    const text = (match[1] ?? match[2] ?? "").trim();
    // FTS5 has nothing to match in a term made only of punctuation.
    if (text && HAS_WORD_CHARACTER.test(text)) terms.push({ text, phrase });
  }
  if (terms.length === 0) {
    return { ok: false, reason: "Search for words or numbers." };
  }
  const lastIndex = terms.length - 1;
  const parts = terms.map((term, index) => {
    const quoted = `"${term.text.replace(/"/g, '""')}"`;
    return index === lastIndex && !term.phrase ? `${quoted}*` : quoted;
  });
  return { ok: true, match: parts.join(" ") };
}

export const SNIPPET_OPEN = "";
export const SNIPPET_CLOSE = "";

/** Split an FTS snippet marked with private-use characters into one-line text and match ranges. */
export function splitSnippet(marked: string): { text: string; ranges: Array<[number, number]> } {
  let text = "";
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (const char of marked) {
    if (char === SNIPPET_OPEN) {
      start = text.length;
    } else if (char === SNIPPET_CLOSE) {
      if (start >= 0) ranges.push([start, text.length]);
      start = -1;
    } else if (/\s/u.test(char)) {
      // One line, one space between words: a snippet is a row label, and the ranges follow it.
      if (text.length > 0 && !text.endsWith(" ")) text += " ";
    } else {
      text += char;
    }
  }
  return { text, ranges };
}
