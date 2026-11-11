import { useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import Svg, { Path, Text as SvgText } from "react-native-svg";
import { Bot, Diamond } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  AutomationEdge,
  AutomationEdgeBranch,
  AutomationRunStepStatus,
} from "@pimi/protocol/automation/types";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";

const BRANCH_LABEL: Record<AutomationEdgeBranch, string> = { true: "yes", false: "no" };

const ThemedBot = withUnistyles(Bot);
const ThemedDiamond = withUnistyles(Diamond);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const NODE_WIDTH = 148;
const NODE_HEIGHT = 56;
const GAP_X = 16;
const GAP_Y = 44;
const PADDING = 8;

export interface AutomationCanvasStep {
  id: string;
  kind: "agent" | "condition";
  title: string;
  subtitle: string;
}

interface AutomationFlowCanvasProps {
  steps: readonly AutomationCanvasStep[];
  edges: readonly AutomationEdge[];
  selectedStepId: string;
  /** Status of each step in the run being shown, keyed by step id. */
  stepStatuses?: Readonly<Record<string, AutomationRunStepStatus>>;
  /** While set, tapping another step picks it as the end of a new link from this step. */
  linkFromStepId: string | null;
  onPressStep: (stepId: string) => void;
}

interface CanvasLayout {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

// Layers top to bottom by longest path from a first step, so every link points down. The
// stored order breaks ties inside a layer. A cycle (which the form refuses) falls back to layer 0.
function layoutFlow(
  steps: readonly AutomationCanvasStep[],
  edges: readonly AutomationEdge[],
): CanvasLayout {
  const ids = steps.map((step) => step.id);
  const known = new Set(ids);
  const live = edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of live) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const depth = new Map(ids.map((id) => [id, 0]));
  const ready = ids.filter((id) => indegree.get(id) === 0);
  while (ready.length > 0) {
    const id = ready.shift()!;
    for (const edge of live) {
      if (edge.from !== id) {
        continue;
      }
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, (depth.get(id) ?? 0) + 1));
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) {
        ready.push(edge.to);
      }
    }
  }
  const layers: string[][] = [];
  for (const id of ids) {
    const layer = depth.get(id) ?? 0;
    (layers[layer] ??= []).push(id);
  }
  const widest = Math.max(1, ...layers.map((layer) => layer?.length ?? 0));
  const width = PADDING * 2 + widest * NODE_WIDTH + (widest - 1) * GAP_X;
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, row) => {
    const rowWidth = layer.length * NODE_WIDTH + (layer.length - 1) * GAP_X;
    const left = (width - rowWidth) / 2;
    layer.forEach((id, column) => {
      positions.set(id, {
        x: left + column * (NODE_WIDTH + GAP_X),
        y: PADDING + row * (NODE_HEIGHT + GAP_Y),
      });
    });
  });
  const rows = Math.max(1, layers.length);
  const height = PADDING * 2 + rows * NODE_HEIGHT + (rows - 1) * GAP_Y;
  return { positions, width, height };
}

const STATUS_LABEL: Record<AutomationRunStepStatus, string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

/**
 * The step graph, laid out automatically. Tap a step to edit it; links are added from the
 * editor below ("Link to…" then tap the target), so the canvas needs no drag gestures and works
 * the same on a phone.
 */
export function AutomationFlowCanvas({
  steps,
  edges,
  selectedStepId,
  stepStatuses,
  linkFromStepId,
  onPressStep,
}: AutomationFlowCanvasProps): ReactElement {
  const layout = useMemo(() => layoutFlow(steps, edges), [steps, edges]);
  const sizeStyle = useMemo(
    () => ({ width: layout.width, height: layout.height }),
    [layout.height, layout.width],
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.scrollContent}
      testID="automation-flow-canvas"
    >
      <View style={sizeStyle}>
        <Svg width={layout.width} height={layout.height} style={styles.edges}>
          {edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) {
              return null;
            }
            const x1 = from.x + NODE_WIDTH / 2;
            const y1 = from.y + NODE_HEIGHT;
            const x2 = to.x + NODE_WIDTH / 2;
            const y2 = to.y;
            const bend = Math.max(GAP_Y / 2, (y2 - y1) / 2);
            const key = `${edge.from}->${edge.to}:${edge.branch ?? ""}`;
            return (
              <EdgePath
                key={key}
                d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`}
                label={edge.branch ? BRANCH_LABEL[edge.branch] : null}
                labelX={(x1 + x2) / 2 + 4}
                labelY={(y1 + y2) / 2}
              />
            );
          })}
        </Svg>
        {steps.map((step) => {
          const position = layout.positions.get(step.id);
          if (!position) {
            return null;
          }
          return (
            <CanvasNode
              key={step.id}
              step={step}
              x={position.x}
              y={position.y}
              selected={step.id === selectedStepId}
              linkTarget={linkFromStepId !== null && linkFromStepId !== step.id}
              status={stepStatuses?.[step.id] ?? null}
              onPress={onPressStep}
            />
          );
        })}
      </View>
    </ScrollView>
  );
}

function EdgePath({
  d,
  label,
  labelX,
  labelY,
}: {
  d: string;
  label: string | null;
  labelX: number;
  labelY: number;
}): ReactElement {
  return (
    <>
      <Path d={d} stroke={styles.edgeStroke.color} strokeWidth={1.5} fill="none" />
      {label ? (
        <SvgText x={labelX} y={labelY} fontSize={11} fill={styles.edgeLabel.color}>
          {label}
        </SvgText>
      ) : null}
    </>
  );
}

function CanvasNode({
  step,
  x,
  y,
  selected,
  linkTarget,
  status,
  onPress,
}: {
  step: AutomationCanvasStep;
  x: number;
  y: number;
  selected: boolean;
  linkTarget: boolean;
  status: AutomationRunStepStatus | null;
  onPress: (stepId: string) => void;
}): ReactElement {
  const nodeStyle = useMemo(
    () =>
      ({ pressed }: PressableStateCallbackType) => [
        styles.node,
        { left: x, top: y },
        selected && styles.nodeSelected,
        linkTarget && styles.nodeLinkTarget,
        status === "failed" && styles.nodeFailed,
        pressed && styles.nodePressed,
      ],
    [linkTarget, selected, status, x, y],
  );
  const handlePress = useCallback(() => onPress(step.id), [onPress, step.id]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const statusStyle = useMemo(
    () => [
      styles.status,
      status === "succeeded" && styles.statusSucceeded,
      status === "failed" && styles.statusFailed,
      status === "running" && styles.statusRunning,
    ],
    [status],
  );
  return (
    <PressHighlight
      style={nodeStyle}
      highlightStyle={styles.nodePressed}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Step ${step.title}`}
      accessibilityState={accessibilityState}
      testID={`automation-step-${step.id}`}
    >
      <View style={styles.nodeHeader}>
        {step.kind === "agent" ? (
          <ThemedBot size={12} uniProps={mutedColorMapping} />
        ) : (
          <ThemedDiamond size={12} uniProps={mutedColorMapping} />
        )}
        <Text style={styles.nodeTitle} numberOfLines={1}>
          {step.title}
        </Text>
      </View>
      <Text style={status ? statusStyle : styles.nodeSubtitle} numberOfLines={1}>
        {status ? STATUS_LABEL[status] : step.subtitle}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
  },
  edges: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  edgeStroke: {
    color: theme.colors.borderAccent,
  },
  edgeLabel: {
    color: theme.colors.foregroundMuted,
  },
  node: {
    position: "absolute",
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  nodeSelected: {
    borderColor: theme.colors.accent,
    borderWidth: 2,
  },
  nodeLinkTarget: {
    borderStyle: "dashed",
    borderColor: theme.colors.accent,
  },
  nodeFailed: {
    borderColor: theme.colors.statusDanger,
  },
  nodePressed: {
    backgroundColor: theme.colors.surface3,
  },
  nodeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  nodeTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  nodeSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusSucceeded: {
    color: theme.colors.statusSuccess,
  },
  statusFailed: {
    color: theme.colors.statusDanger,
  },
  statusRunning: {
    color: theme.colors.statusWarning,
  },
}));
