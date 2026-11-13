import { useCallback, useMemo } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import { SPACING } from "@/styles/theme";
import { MermaidIframeRuntime, type MermaidRenderedMessage } from "./iframe-runtime.web";
import type { DiagramColorScheme } from "./render-model";
import { useMermaidRenderModel } from "./use-render-model";

// The chat already rendered this diagram, so the cache usually knows its size before the iframe
// has drawn it again.
const FALLBACK_SIZE = { width: 240, height: 240 };
const TAB_FIT = { padding: SPACING[6] };

/** A Mermaid diagram filling a workspace tab, fitted to the pane and free to pan and zoom. */
export function MermaidTabView({
  source,
  colorScheme,
}: {
  source: string;
  colorScheme: DiagramColorScheme;
}) {
  const { t } = useTranslation();
  const { state, request, rendered, renderFailed } = useMermaidRenderModel({
    source,
    phase: "complete",
    colorScheme,
  });
  const handleRendered = useCallback(
    (message: MermaidRenderedMessage) => {
      rendered({
        revision: message.revision,
        source: message.source,
        colorScheme: message.colorScheme,
        dimensions: { height: message.height, width: message.width },
      });
    },
    [rendered],
  );
  const visible = state.visible;
  const contentSize = useMemo(
    () => (visible ? { width: visible.width, height: visible.height } : FALLBACK_SIZE),
    [visible],
  );
  return (
    <ZoomableViewport
      accessibilityLabel={t("message.diagram.diagram")}
      contentSize={contentSize}
      fit={TAB_FIT}
      minScale={1}
      style={styles.viewport}
      testID="chat-visual-mermaid"
      wheelActivation="always"
    >
      <MermaidIframeRuntime
        request={request}
        onRendered={handleRendered}
        onRenderFailed={renderFailed}
      />
    </ZoomableViewport>
  );
}

const styles = StyleSheet.create(() => ({
  viewport: { flex: 1 },
}));
