/**
 * The JavaScript view of a project-search pattern. The daemon finds matching lines with
 * `git grep`; this module locates the matches inside a line and expands replacements, so the
 * daemon's replace and the app's preview run the same code.
 */

export interface WorkspaceSearchPattern {
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
}

// Git's `-w` treats ASCII letters, digits and `_` as word characters, so this does too.
const NOT_WORD_BEFORE = "(?<![A-Za-z0-9_])";
const NOT_WORD_AFTER = "(?![A-Za-z0-9_])";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** A global RegExp for the pattern, or null when JavaScript cannot compile it. */
export function createWorkspaceSearchRegExp(pattern: WorkspaceSearchPattern): RegExp | null {
  const source = pattern.isRegex ? pattern.query : escapeRegExp(pattern.query);
  const wrapped = pattern.wholeWord ? `${NOT_WORD_BEFORE}(?:${source})${NOT_WORD_AFTER}` : source;
  try {
    return new RegExp(wrapped, pattern.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

/** Non-empty match spans in `line`, [start, end) in UTF-16 units. */
export function findMatchRanges(regex: RegExp, line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * The text that replaces one match. A regex search reads `$$`, `$&`, `$1`..`$99` and `$<name>`;
 * a plain-text search inserts the replacement as typed.
 */
export function expandReplacement(
  match: RegExpExecArray,
  replacement: string,
  isRegex: boolean,
): string {
  if (!isRegex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (token, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return match[0];
    if (key.startsWith("<")) return match.groups?.[key.slice(1, -1)] ?? token;
    const index = Number(key);
    if (index >= 1 && index < match.length) return match[index] ?? "";
    return token;
  });
}
