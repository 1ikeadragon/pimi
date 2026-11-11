import type { SyntaxNode, Tree } from "@lezer/common";
import { getLanguageForFile } from "./parsers.js";

/**
 * How an occurrence of an identifier relates to its declaration, judged by the syntax tree alone:
 * 0 is a declaration of the name (function, class, type, variable, member), 1 an import binding,
 * 2 a parameter or an object-literal key. `null` is a plain use.
 */
export type DeclarationTier = 0 | 1 | 2;

export interface OccurrenceClassifier {
  /** True when the offset is inside a comment, string, template text or regular expression. */
  isIgnored(offset: number): boolean;
  declarationTier(offset: number): DeclarationTier | null;
}

const IGNORED_NODE = /Comment|String|RegExp|Regex|CharLiteral|^Char$|Rune|Heredoc|JSXText/i;
const IGNORED_EXACT = new Set(["TemplateString"]);

const DEFINITION_NODES = new Set(["VariableDefinition", "TypeDefinition", "Definition", "DefName"]);
const IMPORT_PARENTS = new Set(["ImportGroup", "ImportDeclaration", "ImportStatement"]);
const PARAMETER_PARENTS = new Set(["ParamList", "CatchClause", "ParameterList", "Parameter"]);
const TYPE_DECLARATION_PARENTS = new Set([
  "StructItem",
  "EnumItem",
  "TraitItem",
  "TypeItem",
  "UnionItem",
  "ClassSpecifier",
  "StructSpecifier",
  "UnionSpecifier",
  "EnumSpecifier",
]);

/**
 * Parses `code` once so each occurrence can be classified. Null when the file's language has no
 * parser, which also covers prose and data files whose "references" would be noise.
 */
export function createOccurrenceClassifier(
  code: string,
  filename: string,
): OccurrenceClassifier | null {
  const language = getLanguageForFile(filename);
  if (!language) return null;
  const tree: Tree = language.parser.parse(code);
  const nodeAt = (offset: number) => tree.resolveInner(offset, 1);
  return {
    isIgnored(offset) {
      const name = nodeAt(offset).name;
      return IGNORED_NODE.test(name) || IGNORED_EXACT.has(name);
    },
    declarationTier(offset) {
      return declarationTierOf(nodeAt(offset));
    },
  };
}

function declarationTierOf(node: SyntaxNode): DeclarationTier | null {
  const parent = node.parent?.name ?? "";
  const name = node.name;
  if (name === "PropertyDefinition") return parent === "Property" ? 2 : 0;
  if (DEFINITION_NODES.has(name)) {
    if (IMPORT_PARENTS.has(parent)) return 1;
    return PARAMETER_PARENTS.has(parent) ? 2 : 0;
  }
  // Rust `use a::b` binds through BoundIdentifier; other BoundIdentifiers are declarations.
  if (name === "BoundIdentifier") return parent === "ScopedIdentifier" ? 1 : 0;
  if (name === "TypeIdentifier" && TYPE_DECLARATION_PARENTS.has(parent)) return 0;
  if (name === "VariableName") {
    if (parent === "FunctionDefinition" || parent === "ClassDefinition") return 0;
    // JavaScript `import { a }` binds a VariableName; in `import { a as b }` only `b` binds.
    if (IMPORT_PARENTS.has(parent)) return node.nextSibling?.name === "as" ? null : 1;
  }
  return null;
}
