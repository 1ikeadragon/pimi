const OPENERS: Record<string, string> = { "{": "}", "[": "]" };

/**
 * Removes closing brackets that have nothing to close: one that would end the document while
 * more of it follows, and one of the wrong kind for the bracket that is open. Brackets inside
 * strings are left alone. Nothing is added, so a block that is still streaming stays unfinished.
 */
function dropStrayClosers(source: string): string {
  const open: string[] = [];
  let kept = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      kept += character;
      if (character === "\\") {
        index += 1;
        kept += source[index] ?? "";
      } else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character in OPENERS) open.push(OPENERS[character]);
    else if (character === "}" || character === "]") {
      const endsDocument = open.length === 1 && source.slice(index + 1).trim() !== "";
      if (open.at(-1) !== character || endsDocument) continue;
      open.pop();
    }
    kept += character;
  }
  return kept;
}

/**
 * Parses the JSON of a visual block. A long spec written on one line often arrives with one
 * closing bracket too many in the middle, which ends the document early; that slip is repaired
 * so the reader gets the chart. Every caller still validates the result against its own schema.
 * Throws for anything else that is not JSON.
 */
export function parseBlockJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    const repaired = dropStrayClosers(source);
    if (repaired === source) throw error;
    return JSON.parse(repaired);
  }
}
