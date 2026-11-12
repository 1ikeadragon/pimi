import { defineSettingsPage } from "@/settings-index/define";
import type { OpenInSidePanePreferences } from "@/hooks/use-settings";

export const OPEN_LOCATION_SOURCES = [
  "explorerFiles",
  "diffs",
  "chatFiles",
  "diffFiles",
  "subagents",
] as const satisfies readonly (keyof OpenInSidePanePreferences)[];

const OPEN_WORDS = ["open", "side pane", "split", "main pane", "tab", "where"];

export const openLocationSettings = defineSettingsPage(
  { kind: "section", section: "general" },
  ({ t, isDesktopApp }) =>
    isDesktopApp
      ? [
          ...OPEN_LOCATION_SOURCES.map((source) => ({
            id: `general.open.${source}`,
            title: t(`settings.layout.openInSidePane.sources.${source}.label`),
            keywords: OPEN_WORDS,
          })),
          {
            id: "general.open.pullRequests",
            title: t("settings.layout.openInSidePane.sources.pullRequests.label"),
            keywords: [...OPEN_WORDS, "pr", "merge request", "review"],
          },
          {
            id: "general.open.serviceUrls",
            title: t("settings.layout.openInSidePane.sources.serviceUrls.label"),
            keywords: [...OPEN_WORDS, "links", "urls", "browser", "localhost", "scripts"],
          },
        ]
      : [],
);
