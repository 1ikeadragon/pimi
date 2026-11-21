// Pimi. PolyForm-Noncommercial-1.0.0.
// The Commits tab: one row per commit (short sha, headline, author, age). Read-only: a row opens
// the commit on the forge. Read on first show; the daemon pages the first 100.
import { useCallback, useMemo } from "react";
import { FlatList, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { openExternalUrl } from "@/utils/open-external-url";
import { Notice } from "./notice";
import { commitsQuery, type ChangeRequestCommits } from "./queries";
import type { ChangeRequestSource } from "./types";
import { formatInboxAge } from "./inbox-row";

type Commit = ChangeRequestCommits["commits"][number];

const ROW_HEIGHT = 44;

function rowStyle({ hovered }: { hovered?: boolean }) {
  return [styles.row, Boolean(hovered) && styles.rowHovered];
}

function CommitRow({ commit }: { commit: Commit }) {
  const open = useCallback(() => void openExternalUrl(commit.url), [commit.url]);
  return (
    <PressHighlight
      onPress={open}
      accessibilityRole="link"
      style={rowStyle}
      testID={`review-commit-${commit.sha.slice(0, 7)}`}
    >
      <Text style={styles.sha}>{commit.sha.slice(0, 7)}</Text>
      <Text style={styles.headline} numberOfLines={1}>
        {commit.headline}
      </Text>
      <Text style={styles.author} numberOfLines={1}>
        {commit.author ?? ""}
      </Text>
      <Text style={styles.age}>{formatInboxAge(commit.committedAt)}</Text>
    </PressHighlight>
  );
}

export function ReviewCommits({ source }: { source: ChangeRequestSource }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(source.serverId);
  const connected = useHostRuntimeIsConnected(source.serverId);
  const result = useFetchQuery({ ...commitsQuery(source, client), enabled: !!client && connected });
  const renderItem = useCallback(({ item }: { item: Commit }) => <CommitRow commit={item} />, []);
  const keyExtractor = useCallback((commit: Commit) => commit.sha, []);
  const count = result.data?.commits.length ?? 0;
  const truncated = result.data?.truncated ?? false;
  const footer = useMemo(
    () =>
      truncated ? (
        <Text style={styles.note}>{t("reviewScreen.commits.truncated", { count })}</Text>
      ) : null,
    [truncated, count, t],
  );
  const { refetch } = result;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (result.error && !result.data) {
    return <Notice text={result.error.message} onRetry={retry} />;
  }
  if (!result.data) return <Notice text={t("reviewScreen.commits.loading")} busy />;
  const { commits } = result.data;
  if (commits.length === 0) return <Notice text={t("reviewScreen.commits.empty")} />;
  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={commits}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListFooterComponent={footer}
      testID="review-commits"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1, minHeight: 0 },
  content: {
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    padding: theme.spacing[3],
  },
  row: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  sha: {
    width: 56,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  headline: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  author: {
    maxWidth: 140,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  age: {
    width: 36,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  note: {
    padding: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
