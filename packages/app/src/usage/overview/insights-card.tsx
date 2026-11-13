import { useCallback } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { Button } from "@/components/ui/button";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import type {
  UsageAgentTreeChat,
  UsageAggregate,
  UsageBreakdownRow,
  UsageRange,
} from "@pimi/protocol/messages";
import { type Insight } from "./insights";
import { providerLabel } from "./providers";

/**
 * Starts a chat draft that carries the range's aggregates as text: ids, titles and counters only,
 * never message content. The chat is an ordinary one on the user's default provider and uses
 * tokens like any other.
 */
function askAgent(input: {
  serverId: string;
  range: UsageRange;
  prompt: string;
  totals: UsageAggregate;
  models: readonly UsageBreakdownRow[];
  chats: readonly UsageAgentTreeChat[];
}) {
  const { serverId, range, prompt, totals, models, chats } = input;
  const aggregate = {
    range,
    totals,
    models: models.map((row) => ({ model: row.key, usage: row.usage })),
    topChats: chats.slice(0, 10).map((chat) => ({
      title: chat.title,
      provider: providerLabel(chat.provider),
      project: chat.project,
      outsidePimi: chat.outsidePimi,
      usage: chat.usage,
      subagents: chat.subagents.length,
    })),
  };
  const draftId = generateDraftId();
  useDraftStore.getState().saveDraftInput({
    draftKey: buildNewWorkspaceDraftKey(draftId),
    draft: { text: `${prompt}\n\n${JSON.stringify(aggregate, null, 2)}`, attachments: [] },
  });
  router.navigate(buildNewWorkspaceRoute({ serverId, draftId }));
}

export function UsageInsights({
  insights,
  ask,
}: {
  insights: readonly Insight[];
  ask: Omit<Parameters<typeof askAgent>[0], "prompt">;
}) {
  const { t } = useTranslation();
  const prompt = t("usageOverview.insights.askPrompt");
  const onAsk = useCallback(() => askAgent({ ...ask, prompt }), [ask, prompt]);
  return (
    <View style={styles.wrap} testID="usage-insights">
      {insights.length === 0 ? (
        <Text style={styles.muted}>{t("usageOverview.insights.none")}</Text>
      ) : (
        insights.map((insight) => (
          <Text key={insight.id} style={styles.tip} testID={`usage-insight-${insight.id}`}>
            {t(`usageOverview.insights.${insight.id}`, insight.values)}
          </Text>
        ))
      )}
      <View style={styles.ask}>
        <Button variant="outline" onPress={onAsk} testID="usage-ask-agent">
          {t("usageOverview.insights.askAgent")}
        </Button>
        <Text style={styles.muted}>{t("usageOverview.insights.askAgentHint")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: theme.spacing[3] },
  tip: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  ask: { gap: theme.spacing[2], alignItems: "flex-start" },
}));
