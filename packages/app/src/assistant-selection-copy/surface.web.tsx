import { LiveBackdrop } from "@/appearance/live/live-backdrop";
import { ChatAnnotationSelection } from "@/annotations/chat-selection.web";
import type { ChatNavigation } from "@/annotations/chat-reveal.web";
import { useCallback, type ClipboardEvent, type CSSProperties, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { createAssistantSelectionClipboardContent } from "./content.web";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  annotationTarget?: { serverId: string; agentId: string };
  annotationNavigation?: ChatNavigation;
  style?: StyleProp<ViewStyle>;
}

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };
const CHAT_BACKGROUND = { "pimi-background": "" };

export function AssistantSelectionCopySurface({
  children,
  style,
  annotationTarget,
  annotationNavigation,
}: AssistantSelectionCopySurfaceProps) {
  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const content = createAssistantSelectionClipboardContent(window.getSelection());
    if (!content) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", content.plainText);
    event.clipboardData.setData("text/html", content.html);
  }, []);

  return (
    <ChatAnnotationSelection target={annotationTarget} navigation={annotationNavigation}>
      <div onCopy={handleCopy} style={DISPLAY_CONTENTS}>
        <View style={style} dataSet={CHAT_BACKGROUND}>
          <LiveBackdrop />
          {children}
        </View>
      </div>
    </ChatAnnotationSelection>
  );
}
