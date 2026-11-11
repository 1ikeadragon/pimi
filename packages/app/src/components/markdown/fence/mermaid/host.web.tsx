import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Code, PanelTopOpen, Workflow } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import type { Theme } from "@/styles/theme";
import type { MarkdownFenceRendererProps } from "./types";
import { useOpenChatVisualInTab } from "../open-in-tab";
import { MermaidIframeRuntime, type MermaidRenderedMessage } from "./iframe-runtime.web";
import { useMermaidRenderModel } from "./use-render-model";
import { getDiagramBoxStyle } from "./presentation";

interface MermaidFenceHostImplProps extends MarkdownFenceRendererProps {
  colorScheme?: "light" | "dark";
}

function MermaidFenceHostImpl({
  code,
  phase,
  inheritedStyles,
  textStyle,
  colorScheme = "dark",
}: MermaidFenceHostImplProps) {
  const { t } = useTranslation();
  const { state, request, rendered, renderFailed } = useMermaidRenderModel({
    source: code,
    phase,
    colorScheme,
  });
  const [hasRuntimeContent, setHasRuntimeContent] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const showSourcePress = useCallback(() => setShowSource(true), []);
  const showDiagramPress = useCallback(() => setShowSource(false), []);
  const handleRendered = useCallback(
    (message: MermaidRenderedMessage) => {
      setHasRuntimeContent(true);
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
  const tabVisual = useMemo(
    () => (visible ? { kind: "mermaid" as const, source: visible.source } : null),
    [visible],
  );
  const openInTab = useOpenChatVisualInTab(tabVisual, t("message.diagram.diagram"));
  const canShowDiagram = visible !== null && hasRuntimeContent;
  const diagramVisible = canShowDiagram && !showSource;
  const [columnWidth, setColumnWidth] = useState(0);
  const measureColumn = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const measured = Math.floor(nativeEvent.layout.width);
    // A hidden retained panel reports zero; keep the last real width.
    if (measured > 0) setColumnWidth(measured);
  }, []);
  const padding = typeof textStyle.padding === "number" ? textStyle.padding : 0;
  // Mermaid lays a gantt chart out across the width of its frame, so a gantt drawn in the narrow
  // measuring frame, or shrunk to a phone column, overprints its labels. A gantt gets a frame at
  // least GANTT_MIN_WIDTH wide and scrolls sideways when the column is narrower.
  const ganttWidth = GANTT_SOURCE.test(code)
    ? Math.max(columnWidth - padding * 2, GANTT_MIN_WIDTH)
    : null;
  // A diagram wider than the column is drawn smaller to fit it, so the box takes the height the
  // drawing ends up with. At the diagram's full height a phone shows a small drawing in a tall
  // empty box.
  const runtimeHeight = Math.max(
    fittedDiagramHeight(visible, ganttWidth ?? columnWidth - padding * 2) + padding * 2,
    1,
  );
  const actions = useMemo(
    () => [
      {
        icon: Code,
        label: t("message.diagram.viewSource"),
        onPress: showSourcePress,
      },
      ...(openInTab
        ? [
            {
              icon: PanelTopOpen,
              label: t("message.visualization.openInTab"),
              onPress: openInTab,
              testID: "chat-visual-open-in-tab",
            },
          ]
        : []),
    ],
    [openInTab, showSourcePress, t],
  );
  const diagramStyle = useMemo(
    () => [
      getDiagramBoxStyle(textStyle),
      containerStyle,
      { height: Math.min(runtimeHeight, MAX_PREVIEW_HEIGHT), minHeight: MIN_DIAGRAM_BOX_HEIGHT },
      ganttWidth === null ? null : { width: ganttWidth + padding * 2 },
    ],
    [ganttWidth, padding, runtimeHeight, textStyle],
  );
  const diagramSize = useMemo(() => {
    if (visible) return { width: visible.width, height: visible.height };
    return ganttWidth === null ? MEASURING_SIZE : { ...MEASURING_SIZE, width: ganttWidth };
  }, [ganttWidth, visible]);
  const sourceVisible = !diagramVisible;
  let viewportStyle: StyleProp<ViewStyle> = diagramStyle;
  if (!diagramVisible) {
    viewportStyle = ganttWidth === null ? measuringStyle : [measuringStyle, { width: ganttWidth }];
  }
  const scrollStyle = ganttWidth !== null && diagramVisible ? ganttScrollStyle : boundaryStyle;

  return (
    <>
      <View onLayout={measureColumn} style={columnProbeStyle} />
      {sourceVisible ? (
        <View style={sourceContainerStyle}>
          <HighlightedCodeBlock
            code={code}
            language="mermaid"
            inheritedStyles={inheritedStyles}
            textStyle={textStyle}
          />
          {showSource && canShowDiagram ? (
            <Pressable
              accessibilityLabel={t("message.diagram.viewDiagram")}
              accessibilityRole="button"
              hitSlop={4}
              onPress={showDiagramPress}
              style={controlStyles.sourceButton}
            >
              {({ hovered }) => (
                <Workflow
                  size={14}
                  color={hovered ? controlStyles.iconHovered.color : controlStyles.icon.color}
                />
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <div inert={!diagramVisible} style={scrollStyle}>
        <ZoomableViewport
          accessibilityLabel={t("message.diagram.diagram")}
          actions={actions}
          contentSize={diagramSize}
          style={viewportStyle}
          testID="mermaid-viewport"
          wheelActivation="modifier"
        >
          <MermaidIframeRuntime
            request={request}
            onRendered={handleRendered}
            onRenderFailed={renderFailed}
          />
        </ZoomableViewport>
      </div>
    </>
  );
}

function fittedDiagramHeight(
  diagram: { width: number; height: number } | null,
  available: number,
): number {
  if (!diagram) return 240;
  if (available <= 0 || diagram.width <= available) return diagram.height;
  return Math.ceil((diagram.height * available) / diagram.width);
}

const columnProbeStyle: ViewStyle = { alignSelf: "stretch", height: 0 };
const MEASURING_SIZE = { width: 240, height: 240 };
/**
 * The toolbar overlays the top of the box (8px offset + 32px compact buttons) and the box clips
 * with `overflow: hidden`, so a shorter box leaves the buttons half-clipped and unclickable.
 */
const MIN_DIAGRAM_BOX_HEIGHT = 56;
const MAX_PREVIEW_HEIGHT = 480;
const boundaryStyle: React.CSSProperties = { display: "contents" };
/** A diagram that starts with `gantt`, after any front matter, directive or comment lines. */
const GANTT_SOURCE = /^\s*gantt\b/m;
/** Wide enough for a year of month ticks and task labels beside their bars. */
const GANTT_MIN_WIDTH = 760;
const ganttScrollStyle: React.CSSProperties = { overflowX: "auto", overflowY: "hidden" };
const sourceContainerStyle: ViewStyle = { position: "relative" };
/**
 * The viewport's own root is `flex: 1`, so as a flex item it has `flex-basis: 0%` and that basis
 * replaces the height below. In the markdown column there is no free space to grow into, so the
 * box collapses and the diagram is scaled down to fit a couple of pixels. Size it from the height.
 */
const containerStyle: ViewStyle = {
  flexBasis: "auto",
  flexGrow: 0,
  flexShrink: 0,
  overflow: "hidden",
  position: "relative",
};
const measuringStyle: ViewStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  height: 240,
  opacity: 0,
  pointerEvents: "none",
};
const controlStyles = StyleSheet.create((theme) => ({
  sourceButton: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  icon: { color: theme.colors.foregroundMuted },
  iconHovered: { color: theme.colors.foreground },
}));
const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
const ThemedMermaidFenceHost = withUnistyles(MermaidFenceHostImpl);

export function MermaidFenceHost(props: MarkdownFenceRendererProps) {
  return <ThemedMermaidFenceHost {...props} uniProps={mapColorScheme} />;
}
