import { createHash } from "node:crypto";

// Two reports are the same finding when they name the same route, category and title once the
// title is lowercased and stripped to words. The lead and the findings store both rely on this,
// so a repeated report raises a count instead of adding a row.
export function normalizeFindingRoute(route: string): string {
  const trimmed = route.trim();
  let path = trimmed;
  try {
    const parsed = new URL(trimmed);
    path = parsed.pathname;
  } catch {
    path = trimmed.split(/[?#]/)[0] ?? trimmed;
  }
  const lowered = path.toLowerCase().replace(/\/+$/, "");
  return lowered.length > 0 ? lowered : "/";
}

export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function findingSignature(input: {
  route: string;
  category: string;
  title: string;
}): string {
  const material = [
    normalizeFindingRoute(input.route),
    input.category,
    normalizeFindingTitle(input.title),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}
