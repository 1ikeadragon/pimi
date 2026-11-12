const TOOL_TOKEN_REGEX = /[a-z0-9]+/g;
const STANDARD_NAMESPACE_SEPARATOR_REGEX = /[.:/]/;

export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function tokenizeToolName(name: string): string[] {
  const normalized = normalizeToolName(name);
  return normalized.match(TOOL_TOKEN_REGEX) ?? [];
}

export function getToolLeafName(name: string): string | null {
  const tokens = tokenizeToolName(name);
  return tokens.length > 0 ? tokens[tokens.length - 1] : null;
}

export function isSpeakToolName(name: string): boolean {
  return getToolLeafName(name) === "speak";
}

export function isLikelyNamespacedToolName(name: string): boolean {
  const normalized = normalizeToolName(name);
  if (STANDARD_NAMESPACE_SEPARATOR_REGEX.test(normalized)) {
    return true;
  }
  if (!normalized.includes("__")) {
    return false;
  }

  // Keep `__` handling strict to avoid false positives on arbitrary custom names.
  const segments = normalized.split("__").filter((segment) => segment.length > 0);
  if (segments.length >= 3) {
    return true;
  }
  if (segments.length === 2 && segments[1].includes("_")) {
    return true;
  }
  return false;
}

export function isPaseoToolName(name: string): boolean {
  return !isSpeakToolName(name) && getPaseoToolLeafName(name) !== null;
}

function isPimiNamespace(name: string): boolean {
  return name === "pimi" || name.startsWith("pimi_");
}

export function getPaseoToolLeafName(name: string): string | null {
  // OMP displays bridged MCP tools as "server / tool".
  const normalized = normalizeToolName(name).replace(/\s+\/\s+/, ".");
  if (normalized.includes("__")) {
    const segments = normalized.split("__").filter((s) => s.length > 0);
    if (segments.length >= 3 && segments[0] === "mcp" && isPimiNamespace(segments[1])) {
      return segments.slice(2).join("__");
    }
    return null;
  }
  if (normalized.includes(".")) {
    const firstSegment = normalized.split(".")[0];
    if (isPimiNamespace(firstSegment)) {
      return normalized.split(".").slice(1).join(".");
    }
    return null;
  }
  return null;
}

export function isLikelyExternalToolName(name: string): boolean {
  const normalized = normalizeToolName(name);
  if (!normalized) {
    return false;
  }
  if (isSpeakToolName(normalized)) {
    return true;
  }
  return isLikelyNamespacedToolName(normalized);
}
