import { useCallback } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageAgentTreeChat, UsageAggregate } from "@pimi/protocol/messages";
import { PressHighlight } from "@/components/ui/press-highlight";
import { openPimiUsageDetail } from "@/navigation/pimi-usage";
import { formatCostUsd, formatPercent, formatTokens } from "./format";
import { providerLabel } from "./providers";

const MAX_CHATS = 10;

/**
 * The chats that used the most tokens in the range, each with the subagents inside it. A chat's
 * total already includes its subagents, which is why they read "included in parent".
 */
export function UsageTopChats({
  chats,
  serverId,
  total,
}: {
  chats: readonly UsageAgentTreeChat[];
  serverId: string;
  total: number;
}) {
  return (
    <View style={styles.list} testID="usage-top-chats">
      {chats.slice(0, MAX_CHATS).map((chat) => (
        <ChatRow key={chat.id} chat={chat} serverId={serverId} total={total} />
      ))}
    </View>
  );
}

function figures(usage: UsageAggregate, locale: string | undefined, share?: string): string {
  return [formatTokens(usage.total, locale), formatCostUsd(usage, locale), share]
    .filter(Boolean)
    .join(" · ");
}

function ChatRow({
  chat,
  serverId,
  total,
}: {
  chat: UsageAgentTreeChat;
  serverId: string;
  total: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const share = total === 0 ? 0 : chat.usage.total / total;
  const openable = chat.agentId !== null;
  const { agentId } = chat;
  const open = useCallback(() => {
    if (agentId) openPimiUsageDetail({ tab: "sessions", serverId, agentId }, true);
  }, [agentId, serverId]);
  const head = (
    <>
      <View style={styles.title}>
        <Text style={styles.name} numberOfLines={1}>
          {chat.title ?? chat.project ?? t("usageOverview.chats.untitled")}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {[
            providerLabel(chat.provider),
            chat.project,
            chat.outsidePimi ? t("usageOverview.breakdown.outside") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <Text style={styles.figures}>
        {figures(chat.usage, locale, formatPercent(share, locale))}
      </Text>
    </>
  );
  return (
    <View style={styles.chat}>
      {openable ? (
        <PressHighlight
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={t("usageOverview.chats.open")}
          style={styles.head}
          testID={`usage-chat-${chat.id}`}
        >
          {head}
        </PressHighlight>
      ) : (
        <View style={styles.head} testID={`usage-chat-${chat.id}`}>
          {head}
        </View>
      )}
      {chat.subagents.slice(0, 5).map((subagent) => (
        <View key={subagent.id} style={styles.sub}>
          <Text style={styles.meta} numberOfLines={1}>
            {subagent.title ??
              (subagent.kind === "pimi"
                ? t("usageOverview.chats.pimiSubagent")
                : t("usageOverview.chats.providerSubagent"))}
            {` · ${t("usageOverview.chats.includedInParent")}`}
          </Text>
          <Text style={styles.meta}>
            {figures(
              subagent.usage,
              locale,
              formatPercent(
                chat.usage.total === 0 ? 0 : subagent.usage.total / chat.usage.total,
                locale,
              ),
            )}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing[3] },
  chat: { gap: theme.spacing[1] },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  title: { flexShrink: 1, gap: 2 },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  figures: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  sub: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingStart: theme.spacing[4],
  },
}));
