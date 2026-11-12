import type { ComponentType } from "react";
import type { ShortcutKey } from "@/utils/format-shortcut";

export interface CommandCenterIconProps {
  size: number;
}

export type CommandCenterIcon = ComponentType<CommandCenterIconProps>;

/**
 * What a row is, declared by whoever registers it. The palette scopes (`>` commands and
 * settings, `/` slash commands) select rows by this, never by guessing from the title.
 * Omitted means "command".
 */
export type CommandCenterCategory = "command" | "setting" | "slash";

interface CommandCenterContributionBase {
  id: string;
  category?: CommandCenterCategory;
  group: string;
  groupRank: number;
  rank: number;
  keywords: readonly string[];
  visibility: "always" | "query";
  run(): void | Promise<void>;
}

export type CommandCenterContribution =
  | (CommandCenterContributionBase & {
      presentation: {
        kind: "action";
        title: string;
        subtitle?: string;
        sectionTitle?: string;
        icon?: CommandCenterIcon;
        shortcutKeys?: ShortcutKey[][];
      };
    })
  | (CommandCenterContributionBase & {
      presentation: {
        kind: "choice";
        path: readonly [string, ...string[]];
        icon?: CommandCenterIcon;
        selected: boolean;
        testId?: string;
      };
    })
  | (CommandCenterContributionBase & {
      presentation: {
        kind: "setting";
        /** [page, field]: the page the field lives on, then the field's own title. */
        path: readonly [string, ...string[]];
        icon?: CommandCenterIcon;
      };
    });

export function categoryOf(contribution: CommandCenterContribution): CommandCenterCategory {
  return contribution.category ?? "command";
}

export interface CommandCenterContributionSnapshot {
  contributions: readonly CommandCenterContribution[];
}

export interface CommandCenterRegistrationOwner {
  sourceId: string;
  token: symbol;
}

export interface CommandCenterRegistration {
  owner: CommandCenterRegistrationOwner;
  contributions: readonly CommandCenterContribution[];
}
