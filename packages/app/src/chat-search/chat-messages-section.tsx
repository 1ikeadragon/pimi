import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles, type UnistylesThemes } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useProviderIcon } from "@/components/provider-icons";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useIndexRunStore } from "./index-run-store";
import { ChatHitSnippet } from "./chat-hit-snippet";
import { useChatContentSearch, type ChatContentHit } from "./use-chat-content-search";

type Theme = UnistylesThemes[keyof UnistylesThemes];

const providerIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function ChatHitRow({ hit, query }: { hit: ChatContentHit; query: string }): ReactElement {
  const providerIcon = useProviderIcon(hit.provider, hit.serverId);
  const ProviderIcon = useMemo(
    () => withUnistyles(providerIcon, providerIconMapping),
    [providerIcon],
  );
  const { t } = useTranslation();
  const when = useTimeAgo(new Date(hit.timestamp));
  const open = useCallback(() => {
    navigateToAgent({
      serverId: hit.serverId,
      agentId: hit.agentId,
      workspaceId: hit.workspaceId,
      reveal: { epoch: hit.epoch, seq: hit.seq, query, snippet: hit.snippet.text },
    });
  }, [hit, query]);
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );
  return (
    <PressHighlight
      style={style}
      onPress={open}
      accessibilityRole="button"
      testID={`sessions-message-hit-${hit.agentId}-${hit.seq}`}
    >
      <View style={styles.rowTitle}>
        <ProviderIcon size={14} />
        <Text style={styles.title} numberOfLines={1}>
          {hit.title ?? t("sessions.messages.untitledChat")}
        </Text>
        <Text style={styles.meta}>{when}</Text>
      </View>
      <ChatHitSnippet hit={hit} style={styles.snippet} numberOfLines={2} />
    </PressHighlight>
  );
}

/**
 * "Messages": hits for what was said in chats, under the title matches of the Sessions screen.
 * Renders nothing until the query is long enough to search.
 */
export function ChatMessagesSection({
  query,
  serverIds,
}: {
  query: string;
  serverIds: readonly string[];
}): ReactElement | null {
  const { t } = useTranslation();
  // A finished index run changes what a query finds; searching again picks that up.
  const finishedRuns = useIndexRunStore((state) => state.finished);
  const run = useIndexRunStore((state) => state.run);
  const startIndexing = useIndexRunStore((state) => state.start);
  const search = useChatContentSearch({
    enabled: true,
    query,
    serverIds,
    refreshKey: finishedRuns,
  });
  const indexRun = { run, start: () => startIndexing(serverIds) };
  if (query.trim().length < 2) return null;
  const unindexed = search.unindexedChats;
  return (
    <View style={styles.section} testID="sessions-messages-section">
      <Text style={styles.header}>{t("sessions.messages.header")}</Text>
      {search.hits.map((hit) => (
        <ChatHitRow key={`${hit.serverId}:${hit.agentId}:${hit.seq}`} hit={hit} query={query} />
      ))}
      {search.loading ? <Text style={styles.note}>{t("sessions.messages.searching")}</Text> : null}
      {!search.loading && search.hits.length === 0 ? (
        <Text style={styles.note} testID="sessions-messages-empty">
          {search.error ?? t("sessions.messages.empty")}
        </Text>
      ) : null}
      {search.hasMore ? (
        <View style={styles.footer}>
          <Button variant="ghost" onPress={search.loadMore} disabled={search.loading}>
            {t("sessions.messages.loadMore")}
          </Button>
        </View>
      ) : null}
      {indexRun.run?.running ? (
        <Text style={styles.note} testID="sessions-index-progress">
          {t("sessions.messages.indexing", { done: indexRun.run.done, total: indexRun.run.total })}
        </Text>
      ) : null}
      {indexRun.run?.error ? <Text style={styles.note}>{indexRun.run.error}</Text> : null}
      {unindexed > 0 && !indexRun.run?.running ? (
        <View style={styles.footer}>
          <Text style={styles.note}>{t("sessions.messages.unindexed", { count: unindexed })}</Text>
          <Button variant="ghost" onPress={indexRun.start} testID="sessions-index-older-chats">
            {t("sessions.messages.indexOlder", { count: unindexed })}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[1],
  },
  header: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
  row: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[1],
  },
  rowHovered: { backgroundColor: theme.colors.surface2 },
  rowPressed: { backgroundColor: theme.colors.surface3 },
  rowTitle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  snippet: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
  footer: { alignItems: "flex-start", gap: theme.spacing[1] },
}));
