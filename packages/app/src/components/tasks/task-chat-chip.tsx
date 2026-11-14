import { memo, useCallback, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { useProviderIcon } from "@/components/provider-icons";
import { isNative } from "@/constants/platform";
import { useTranslation } from "@/i18n/use-translation";
import type { TaskChat } from "@/tasks/use-chat-directory";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";

const GLYPH_SIZE = 14;

function ChatGlyph({ provider, serverId }: { provider: string; serverId: string }): ReactElement {
  const Icon = useProviderIcon(provider, serverId);
  return <Icon size={GLYPH_SIZE} color={styles.glyph.color} />;
}

/** A linked chat: provider glyph and title. Pressing it opens the chat. */
export const TaskChatChip = memo(function TaskChatChip({
  chat,
  testID,
}: {
  chat: TaskChat;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const open = useCallback(() => {
    router.push(
      buildHostAgentDetailRoute(chat.serverId, chat.agentId, chat.workspaceId ?? undefined),
    );
  }, [chat.agentId, chat.serverId, chat.workspaceId, router]);
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.chip,
      hovered && styles.chipHovered,
      pressed && styles.chipPressed,
    ],
    [],
  );
  return (
    <PressHighlight
      onPress={open}
      style={style}
      accessibilityRole={isNative ? "link" : "none"}
      accessibilityLabel={t("tasks.row.chat", { title: chat.title })}
      testID={testID}
    >
      <View pointerEvents="none" style={styles.glyphSlot}>
        <ChatGlyph provider={chat.provider} serverId={chat.serverId} />
      </View>
      <Text style={styles.title} numberOfLines={1}>
        {chat.title}
      </Text>
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => ({
  glyph: { color: theme.colors.foregroundMuted },
  chip: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 220,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    marginHorizontal: -theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  chipHovered: { backgroundColor: theme.colors.surface3 },
  chipPressed: { backgroundColor: theme.colors.surface3 },
  glyphSlot: {
    width: GLYPH_SIZE,
    height: GLYPH_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
