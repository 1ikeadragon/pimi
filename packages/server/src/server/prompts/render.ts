import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Templates sit next to this file in src and in dist (build:lib copies the folder).
const PROMPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/**
 * Renders prompts/<templateName>.md, replacing each {{name}} with vars[name].
 * Throws when the template names a variable that was not passed, or a passed
 * variable never appears in the template.
 */
export function renderTemplate(templateName: string, vars: Record<string, string>): string {
  const source = readFileSync(path.join(PROMPTS_DIR, `${templateName}.md`), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "");
  const used = new Set<string>();
  const rendered = source.replace(PLACEHOLDER, (_match, key: string) => {
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`Prompt template "${templateName}" needs variable "${key}"`);
    }
    used.add(key);
    return vars[key];
  });
  for (const key of Object.keys(vars)) {
    if (!used.has(key)) {
      throw new Error(`Prompt template "${templateName}" has no placeholder for variable "${key}"`);
    }
  }
  return rendered;
}
