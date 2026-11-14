import { useCallback } from "react";
import { StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Composer } from "@/composer";
import type { MessagePayload } from "@/composer/types";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { ComposerEditingSession } from "@/composer/editing-session";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { COMPACT_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useTranslation } from "@/i18n/use-translation";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useSessionStore } from "@/stores/session-store";
import { ParentAgentCallout } from "@/subagents/parent";

const inputAreaStyles = RNStyleSheet.create({
  wrapper: { width: "100%", flexShrink: 1, flexGrow: 1 },
});

/**
 * The composer of a provider subagent's pane. A message goes to the daemon, which delivers it to
 * the child through the provider's own channel; the reply shows up in the child's timeline, so
 * the draft clears on acceptance and nothing is appended locally.
 */
export function ProviderSubagentComposer({
  serverId,
  parentAgentId,
  subagentId,
  streamId,
  cwd,
  isPaneFocused,
  editingSession,
}: {
  serverId: string;
  parentAgentId: string;
  subagentId: string;
  streamId: string;
  cwd: string;
  isPaneFocused: boolean;
  editingSession: ComposerEditingSession;
}) {
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout, isBelow: isCompactLayout } = useContainerWidthBelow(COMPACT_CONTENT_WIDTH, {
    initialIsBelow: isCompactFormFactor,
  });
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const draft = useAgentInputDraft({
    draftKey: buildDraftStoreKey({ serverId, agentId: streamId }),
  });

  const handleSubmit = useCallback(
    async (payload: MessagePayload) => {
      if (!client) throw new Error(t("subagents.message.notConnected"));
      if (payload.attachments.length > 0) throw new Error(t("subagents.message.textOnly"));
      await client.sendProviderSubagentMessage(parentAgentId, subagentId, payload.text);
    },
    [client, parentAgentId, subagentId, t],
  );

  return (
    <View style={inputAreaStyles.wrapper} onLayout={onLayout}>
      <Composer
        agentId={streamId}
        serverId={serverId}
        isPaneFocused={isPaneFocused}
        onSubmitMessage={handleSubmit}
        blurOnSubmit={false}
        textSource={draft.textSource}
        onChangeText={draft.editText}
        textReplacement={draft.textReplacement}
        attachments={draft.attachments}
        onChangeAttachments={draft.setAttachments}
        cwd={cwd}
        clearDraft={draft.clear}
        editingSession={editingSession}
        autoFocus
        placeholder={t("subagents.message.placeholder")}
        isCompactLayout={isCompactLayout}
      />
    </View>
  );
}

/** Stands in for the composer when the provider has no way to reach its subagents. */
export function ProviderSubagentComposerUnavailable({
  serverId,
  parentAgentId,
  provider,
}: {
  serverId: string;
  parentAgentId: string;
  provider: string;
}) {
  const { t } = useTranslation();
  return (
    <View>
      <Text style={styles.reason} testID="provider-subagent-composer-disabled">
        {t("subagents.message.unavailable", { provider })}
      </Text>
      <ParentAgentCallout serverId={serverId} parentAgentId={parentAgentId} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  reason: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
