import type { CommandCenterScope } from "@/stores/keyboard-shortcuts-store";
import {
  categoryOf,
  type CommandCenterCategory,
  type CommandCenterContribution,
} from "./contributions";

/**
 * What the palette is searching right now. A mode is chosen by the store's scope (a chip, set by a
 * shortcut) or by the first character typed in the default palette (a prefix, as in VS Code).
 * Nothing else picks a mode: no guessing from what the text looks like.
 */
export type PaletteMode = "all" | "files" | "code" | "commands" | "slash";

interface PaletteModeDefinition {
  /** Typed first in the default palette, it switches to this mode and is not part of the search. */
  prefix: string | null;
  /**
   * The contribution categories listed, or null when the mode lists none. `all` lists contribution
   * rows beside workspaces, agents and files; `commands` and `slash` list contributions alone.
   */
  categories: readonly CommandCenterCategory[] | null;
  /** List every row of those categories with nothing typed. Settings stay out of an empty list. */
  listsAllWhenEmpty: boolean;
}

export const PALETTE_MODES: Record<PaletteMode, PaletteModeDefinition> = {
  all: { prefix: null, categories: ["command", "setting"], listsAllWhenEmpty: false },
  files: { prefix: null, categories: null, listsAllWhenEmpty: false },
  code: { prefix: "%", categories: null, listsAllWhenEmpty: false },
  commands: { prefix: ">", categories: ["command", "setting"], listsAllWhenEmpty: true },
  slash: { prefix: "/", categories: ["slash"], listsAllWhenEmpty: true },
};

const PREFIXED_MODES = (Object.keys(PALETTE_MODES) as PaletteMode[]).filter(
  (mode) => PALETTE_MODES[mode].prefix !== null,
);

export interface ResolvedPaletteMode {
  mode: PaletteMode;
  /** What the user is searching for: the typed text without its mode prefix. */
  text: string;
}

export function resolvePaletteMode(scope: CommandCenterScope, query: string): ResolvedPaletteMode {
  if (scope) return { mode: scope, text: query };
  for (const mode of PREFIXED_MODES) {
    const prefix = PALETTE_MODES[mode].prefix;
    if (prefix && query.startsWith(prefix)) return { mode, text: query.slice(prefix.length) };
  }
  return { mode: "all", text: query };
}

/** The contributions a mode lists. */
export function selectModeContributions(
  contributions: readonly CommandCenterContribution[],
  mode: PaletteMode,
): readonly CommandCenterContribution[] {
  const { categories } = PALETTE_MODES[mode];
  if (!categories) return [];
  return contributions.filter((contribution) => categories.includes(categoryOf(contribution)));
}

/** Whether a listed row shows with nothing typed. Settings never do, so they cannot bury commands. */
export function showsWhenEmpty(
  mode: PaletteMode,
  contribution: CommandCenterContribution,
): boolean {
  if (contribution.visibility === "always") return true;
  return PALETTE_MODES[mode].listsAllWhenEmpty && categoryOf(contribution) !== "setting";
}
