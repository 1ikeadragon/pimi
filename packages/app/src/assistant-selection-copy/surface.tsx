import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { ChatFindProps } from "@/agent-stream/chat-find/types";
import { ChatAnnotateProvider } from "@/annotations/chat-annotate";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  annotationTarget?: { serverId: string; agentId: string };
  annotationNavigation?: Pick<
    ChatFindProps,
    "viewportRef" | "revealLoadedMessage" | "visibleMessageIds"
  >;
  style?: StyleProp<ViewStyle>;
}

export function AssistantSelectionCopySurface({
  children,
  annotationTarget,
  style,
}: AssistantSelectionCopySurfaceProps) {
  return (
    <ChatAnnotateProvider target={annotationTarget}>
      <View style={style}>{children}</View>
    </ChatAnnotateProvider>
  );
}
