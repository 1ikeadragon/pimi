import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { ChatFindProps } from "@/agent-stream/chat-find/types";

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
  style,
}: AssistantSelectionCopySurfaceProps) {
  return <View style={style}>{children}</View>;
}
