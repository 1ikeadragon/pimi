import type { SettingEntry } from "@/settings-index/types";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

/** Below every command group, so a command wins a tie with a setting of the same quality. */
const SETTINGS_GROUP_RANK = 6;

export interface SettingsCommandCenterSource {
  entries: readonly SettingEntry[];
  /** "Settings": the first path part of a whole page. */
  settingsTitle: string;
  icon: CommandCenterIcon;
  open(entry: SettingEntry): void;
}

/**
 * One row per Settings page and per declared field, in declaration order. They stay out of the
 * empty list (`query`) so a long settings index never buries the commands.
 */
export function buildSettingContributions(
  source: SettingsCommandCenterSource,
): CommandCenterContribution[] {
  return source.entries.map((entry, rank) => ({
    id: entry.id,
    category: "setting",
    group: "settings",
    groupRank: SETTINGS_GROUP_RANK,
    rank,
    keywords: entry.keywords,
    visibility: "query",
    run: () => source.open(entry),
    presentation: {
      kind: "setting",
      path: entry.isPage ? [source.settingsTitle, entry.title] : [entry.pageTitle, entry.title],
      icon: source.icon,
    },
  }));
}
