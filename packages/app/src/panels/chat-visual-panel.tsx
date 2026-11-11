import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { invariant } from "@/utils/invariant";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AppWindow } from "lucide-react-native";
import type { ChatVega } from "@pimi/protocol/chat-vega";
import { readChatVisual, type ChatVisual } from "@/chat-visuals/store";
import { MermaidTabView } from "@/components/markdown/fence/mermaid/tab-view";
import { VegaPlot } from "@/components/markdown/fence/vega";
import { ViewNodeView } from "@/components/markdown/fence/view/registry";
import { FileHtmlPreview } from "@/file-panels/html-preview";
import { htmlPreviewTheme } from "@/file-panels/html-preview-theme";
import { ChatVisualViewport } from "@/panels/chat-visual-viewport";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import type { Theme } from "@/styles/theme";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const ThemedHtmlPreview = withUnistyles(FileHtmlPreview);
const ThemedMermaidTabView = withUnistyles(MermaidTabView);
const ThemedAppWindow = withUnistyles(AppWindow);
const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });

/**
 * A visual from a chat at full size. Each kind uses the renderer it has in the chat, given the
 * whole pane, so charts, flows and tables lay out again for its width. Views and Vega charts pan
 * and zoom in `ChatVisualViewport`; a Mermaid diagram has its own zoomable viewport, and an HTML
 * document scrolls inside its frame.
 */
function ChatVisualPanel() {
  const { target } = usePaneContext();
  invariant(target.kind === "chat_visual", "ChatVisualPanel requires chat_visual target");
  const visual = readChatVisual(target.visualId);
  if (!visual) return <Missing message="Open this visual again from its chat." />;
  return <ChatVisualBody visual={visual} title={target.title} />;
}

function ChatVisualBody({ visual, title }: { visual: ChatVisual; title: string }) {
  switch (visual.kind) {
    case "html":
      return (
        <View style={styles.fill} testID="chat-visual-panel">
          <ThemedHtmlPreview
            html={visual.html.html}
            title={title}
            testID="chat-visual-html"
            uniProps={htmlPreviewTheme}
          />
        </View>
      );
    case "mermaid":
      return (
        <View style={styles.fill} testID="chat-visual-panel">
          <ThemedMermaidTabView source={visual.source} uniProps={mapColorScheme} />
        </View>
      );
    case "vega":
      return <VegaTab vega={visual.vega} />;
    case "view":
      return (
        <View style={styles.fill} testID="chat-visual-panel">
          <ChatVisualViewport>
            <View style={styles.content}>
              <ViewNodeView node={visual.view.root} />
            </View>
          </ChatVisualViewport>
        </View>
      );
  }
}

function VegaTab({ vega }: { vega: ChatVega }) {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  if (failed) return <Missing message="Couldn’t draw this chart." />;
  return (
    <View style={styles.fill} testID="chat-visual-panel">
      <ChatVisualViewport>
        <View style={styles.content}>
          {vega.subtitle ? <Text style={styles.subtitle}>{vega.subtitle}</Text> : null}
          <VegaPlot spec={vega.spec} onFailed={fail} />
        </View>
      </ChatVisualViewport>
    </View>
  );
}

function Missing({ message }: { message: string }) {
  return (
    <View style={styles.missing} testID="chat-visual-missing">
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

function useChatVisualPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "chat_visual" }>,
): PanelDescriptor {
  return {
    label: target.title,
    subtitle: "Visual",
    tooltip: target.title,
    titleState: "ready",
    icon: ThemedAppWindow,
    statusBucket: null,
  };
}

export const chatVisualPanelRegistration = definePanel("chat_visual", {
  component: ChatVisualPanel,
  useDescriptor: useChatVisualPanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
