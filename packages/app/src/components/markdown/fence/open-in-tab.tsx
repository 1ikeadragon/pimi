import { useCallback } from "react";
import { PanelTopOpen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { rememberChatVisual, type ChatVisual } from "@/chat-visuals/store";
import { Button } from "@/components/ui/button";
import { useOptionalPaneContext } from "@/panels/pane-context";

/**
 * Opens a chat visual in its own workspace tab, where it gets the whole pane. Undefined where the
 * chat is not in a pane, or while the visual is not ready.
 */
export function useOpenChatVisualInTab(
  visual: ChatVisual | null,
  title: string,
): (() => void) | undefined {
  const openTab = useOptionalPaneContext()?.openTab;
  const open = useCallback(() => {
    if (!visual) return;
    openTab?.({ kind: "chat_visual", visualId: rememberChatVisual(visual), title });
  }, [openTab, title, visual]);
  return openTab && visual ? open : undefined;
}

/** The "Open in tab" action every chat visual card carries. */
export function OpenInTabButton({ onPress }: { onPress?: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={PanelTopOpen}
      accessibilityLabel={t("message.visualization.openInTabLabel")}
      disabled={!onPress}
      onPress={onPress}
      testID="chat-visual-open-in-tab"
    >
      {t("message.visualization.openInTab")}
    </Button>
  );
}
