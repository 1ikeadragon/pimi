// Pimi. PolyForm-Noncommercial-1.0.0.
import { basename } from "node:path";
import { PimiToolInputError } from "./agent/tools/types.js";
import { resolveProjectDisplayName, type PersistedProjectRecord } from "./workspace-registry.js";

const MIN_CONTAINS_LENGTH = 3;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function namesOf(project: PersistedProjectRecord): string[] {
  return [resolveProjectDisplayName(project), basename(project.rootPath)].map(normalize);
}

function listNames(projects: PersistedProjectRecord[]): string {
  return projects.map(resolveProjectDisplayName).join(", ");
}

/** Resolves a project id or the name a person said to one active project, or throws. */
export function resolveProjectReference(
  projects: PersistedProjectRecord[],
  reference: string,
): PersistedProjectRecord {
  const active = projects.filter((project) => !project.archivedAt);
  const byId = active.find((project) => project.projectId === reference);
  if (byId) return byId;

  const query = normalize(reference);
  let matches = query ? active.filter((project) => namesOf(project).includes(query)) : [];
  if (matches.length === 0 && query.length >= MIN_CONTAINS_LENGTH) {
    matches = active.filter((project) => namesOf(project).some((name) => name.includes(query)));
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new PimiToolInputError(
      `More than one project matches "${reference}": ${listNames(matches)}. Ask which one.`,
    );
  }
  throw new PimiToolInputError(
    `No project matches "${reference}". Projects: ${listNames(active)}.`,
  );
}
