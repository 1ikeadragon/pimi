import {
  MAX_WATCHED_NESTED_CHECKOUTS,
  type NestedChangedFile,
  type NestedChangesRepository,
} from "@pimi/protocol/messages";

export interface RepositoryExpansion {
  expanded: boolean;
  /** Orders expansions by recency; the daemon watches the most recent few. */
  sequence: number;
}

export type ExpansionOverrides = Readonly<Record<string, RepositoryExpansion>>;

export type SourceControlRow =
  | { kind: "group"; key: string; repository: NestedChangesRepository; expanded: boolean }
  | { kind: "section"; key: string; staged: boolean }
  | { kind: "file"; key: string; repository: NestedChangesRepository; file: NestedChangedFile }
  | { kind: "error"; key: string; message: string }
  | { kind: "truncated"; key: string }
  | { kind: "clean"; key: string; count: number; expanded: boolean }
  | { kind: "clean_repository"; key: string; repository: NestedChangesRepository };

export interface SourceControlModel {
  rows: SourceControlRow[];
  repositoryCount: number;
  changeCount: number;
  /** Repositories whose first status has not arrived. */
  checkingCount: number;
  /** Oldest `checkedAt` across repositories that were checked; null when none was. */
  oldestCheckedAt: number | null;
  /** Roots with changes or an error, in display order. */
  groupRoots: string[];
}

function byName(a: NestedChangesRepository, b: NestedChangesRepository): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

function hasContent(repository: NestedChangesRepository): boolean {
  return repository.files.length > 0 || repository.error !== null;
}

/** The repositories a group row is shown for, in display order. */
export function listChangedRepositories(
  repositories: readonly NestedChangesRepository[],
): NestedChangesRepository[] {
  return repositories.filter(hasContent).sort(byName);
}

/**
 * Expanded roots, least to most recently expanded. Until the user expands or collapses a group,
 * the first few changed repositories are open: the same number the daemon watches live, so the
 * default view is the one that stays current.
 */
export function resolveExpandedRoots(
  changed: readonly NestedChangesRepository[],
  overrides: ExpansionOverrides,
): string[] {
  const defaults = new Set(changed.slice(0, MAX_WATCHED_NESTED_CHECKOUTS).map((r) => r.root));
  return changed
    .filter((repository) => overrides[repository.root]?.expanded ?? defaults.has(repository.root))
    .map((repository) => repository.root)
    .sort((a, b) => (overrides[a]?.sequence ?? 0) - (overrides[b]?.sequence ?? 0));
}

function fileRows(repository: NestedChangesRepository): SourceControlRow[] {
  const staged = repository.files.filter((file) => file.staged);
  const unstaged = repository.files.filter((file) => !file.staged);
  const both = staged.length > 0 && unstaged.length > 0;
  const rows: SourceControlRow[] = [];
  const append = (files: NestedChangedFile[], isStaged: boolean) => {
    if (files.length === 0) return;
    if (both) {
      rows.push({
        kind: "section",
        key: `${repository.root}\0section\0${isStaged}`,
        staged: isStaged,
      });
    }
    for (const file of files) {
      rows.push({
        kind: "file",
        key: `${repository.root}\0${isStaged}\0${file.path}`,
        repository,
        file,
      });
    }
  };
  append(staged, true);
  append(unstaged, false);
  return rows;
}

export function buildSourceControlModel({
  repositories,
  expandedRoots,
  cleanExpanded,
}: {
  repositories: readonly NestedChangesRepository[];
  expandedRoots: readonly string[];
  cleanExpanded: boolean;
}): SourceControlModel {
  const expanded = new Set(expandedRoots);
  const changed = listChangedRepositories(repositories);
  const clean = repositories
    .filter((repository) => !hasContent(repository) && repository.checkedAt !== null)
    .sort(byName);
  const rows: SourceControlRow[] = [];
  for (const repository of changed) {
    const isExpanded = expanded.has(repository.root);
    rows.push({ kind: "group", key: repository.root, repository, expanded: isExpanded });
    if (repository.error !== null) {
      rows.push({ kind: "error", key: `${repository.root}\0error`, message: repository.error });
    }
    if (isExpanded) {
      rows.push(...fileRows(repository));
      if (repository.truncated) {
        rows.push({ kind: "truncated", key: `${repository.root}\0truncated` });
      }
    }
  }
  if (clean.length > 0) {
    rows.push({ kind: "clean", key: "clean", count: clean.length, expanded: cleanExpanded });
    if (cleanExpanded) {
      for (const repository of clean) {
        rows.push({ kind: "clean_repository", key: `${repository.root}\0clean`, repository });
      }
    }
  }
  const checkedAt = repositories.flatMap((r) => (r.checkedAt === null ? [] : [r.checkedAt]));
  return {
    rows,
    repositoryCount: repositories.length,
    changeCount: repositories.reduce((sum, repository) => sum + repository.files.length, 0),
    checkingCount: repositories.filter((repository) => repository.checkedAt === null).length,
    oldestCheckedAt: checkedAt.length > 0 ? Math.min(...checkedAt) : null,
    groupRoots: changed.map((repository) => repository.root),
  };
}
