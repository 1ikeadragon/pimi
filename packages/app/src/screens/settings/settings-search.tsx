import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { buildSettingContributions } from "@/command-center/settings-contributions";
import { buildContributionSections } from "@/command-center/results";
import { getCommandCenterIcon } from "@/command-center/icon";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { openSettingEntry } from "@/settings-index/open";
import { useSettingsIndex } from "@/settings-index/use-settings-index";
import { Search } from "lucide-react-native";

const RESULT_ICON = getCommandCenterIcon(Search);

/**
 * The Settings sidebar's search field. It filters the same index the command palette searches,
 * through the same scorer, so both list the same rows in the same order.
 */
export function useSettingsSearch() {
  const { t } = useTranslation();
  const { entries, serverId } = useSettingsIndex();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    if (!query.trim()) return [];
    const contributions = buildSettingContributions({
      entries,
      settingsTitle: t("settings.title"),
      icon: RESULT_ICON,
      open: (entry) => openSettingEntry(entry, serverId),
    });
    return buildContributionSections(contributions, query).flatMap((section) => section.results);
  }, [entries, query, serverId, t]);
  return { query, setQuery, rows };
}

export type SettingsSearchRows = ReturnType<typeof useSettingsSearch>["rows"];

export function SettingsSearchField({ onChangeText }: { onChangeText(text: string): void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.field}>
      <FormTextInput
        initialValue=""
        onChangeText={onChangeText}
        placeholder={t("settings.search.placeholder")}
        accessibilityLabel={t("settings.search.placeholder")}
        autoCapitalize="none"
        autoCorrect={false}
        testID="settings-search-input"
      />
    </View>
  );
}

function SettingsSearchRow({
  result,
  query,
}: {
  result: SettingsSearchRows[number];
  query: string;
}) {
  const presentation =
    result.kind === "contribution" && result.contribution.presentation.kind === "setting"
      ? result.contribution.presentation
      : null;
  const run = useCallback(() => void result.run(), [result]);
  if (!presentation) return null;
  const [page, ...rest] = presentation.path;
  const title = rest.length > 0 ? rest.join(" › ") : page;
  return (
    <PressHighlight
      accessibilityRole="button"
      onPress={run}
      style={styles.row}
      testID={`settings-search-result-${result.id}`}
    >
      <HighlightedText
        text={title}
        ranges={findHighlightRanges(query, title)}
        style={styles.title}
        numberOfLines={1}
      />
      {rest.length > 0 ? (
        <Text style={styles.page} numberOfLines={1}>
          {page}
        </Text>
      ) : null}
    </PressHighlight>
  );
}

export function SettingsSearchResults({
  rows,
  query,
}: {
  rows: SettingsSearchRows;
  query: string;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <Text style={styles.empty}>{t("shell.commandCenter.noMatches")}</Text>;
  }
  return (
    <View style={styles.results}>
      {rows.map((result) => (
        <SettingsSearchRow key={result.id} result={result} query={query} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  results: {
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[0.5],
  },
  row: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  page: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}));
