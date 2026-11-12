import { memo, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import Svg, { Path, Polygon } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Bot, Plus, Split, Zap, type LucideIcon } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  AutomationEdge,
  AutomationEdgeBranch,
  AutomationRunStepStatus,
} from "@pimi/protocol/automation/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  connectableTargets,
  isTriggerNode,
  TRIGGER_NODE_ID,
  type AutomationEditorState,
  type EditorProblem,
  type EditorSelection,
  type EditorStep,
} from "@/automations/automation-editor-model";
import {
  handlePoint,
  linkPath,
  NODE_HEIGHT,
  NODE_WIDTH,
  type CanvasDirection,
  type CanvasEdge,
  type CanvasLayout,
  type CanvasNodeBox,
  type HandleBranch,
  type Point,
} from "@/automations/automation-editor-layout";
import { PressHighlight } from "@/components/ui/press-highlight";
import { identityForeground } from "@/styles/identity-colors";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useCanvasDragConnect, type CanvasDragLine } from "./automation-canvas-input";

// Module-scope themed icons so menu `leading` props are stable elements.
const ThemedBot = withUnistyles(Bot);
const ThemedSplit = withUnistyles(Split);
const menuIconProps = (theme: Theme) => ({ size: 14, color: theme.colors.foregroundMuted });
const agentMenuIcon = <ThemedBot uniProps={menuIconProps} />;
const checkMenuIcon = <ThemedSplit uniProps={menuIconProps} />;

/*
 * Drawn in the chat flow diagram's style (components/markdown/fence/view/flow.tsx): a card with a
 * light tint and border in the kind's colour, an icon tile on the leading side, dashed links.
 */
const BODY_TINT = 0.1;
const FOCUSED_BODY_TINT = 0.2;
const DIMMED_NODE = 0.35;
const DIMMED_EDGE = 0.2;
const EDGE_DASH = "6 4";
const EDGE_WIDTH = 1.5;
const FOCUSED_EDGE_WIDTH = 2;
const HANDLE_SIZE = 22;
const EDGE_BUTTON_SIZE = 20;
const TILE_WIDTH = 36;

type NodeKind = "trigger" | "agent" | "condition";

const KIND_ICON: Record<NodeKind, LucideIcon> = {
  trigger: Zap,
  agent: Bot,
  condition: Split,
};

export interface CanvasNodeText {
  title: string;
  subtitle: string;
}

export interface AutomationEditorCanvasProps {
  state: Pick<AutomationEditorState, "steps" | "edges" | "selection" | "problemsByTarget">;
  direction: CanvasDirection;
  /** From `layoutAutomationGraph`; the host sizes its viewport from it. */
  layout: CanvasLayout;
  /** The title and second line of each node, the trigger under `TRIGGER_NODE_ID`. */
  nodeText: ReadonlyMap<string, CanvasNodeText>;
  /** Step results of the run shown over the graph, or null for none. */
  runStatuses: ReadonlyMap<string, AutomationRunStepStatus> | null;
  editable: boolean;
  onSelect: (selection: EditorSelection) => void;
  onAddAfter: (
    kind: EditorStep["kind"],
    from: { nodeId: string; branch?: AutomationEdgeBranch },
  ) => void;
  onInsert: (kind: EditorStep["kind"], edge: AutomationEdge) => void;
  onDisconnect: (edge: AutomationEdge) => void;
  onConnect: (from: string, to: string, branch: AutomationEdgeBranch | undefined) => void;
}

function nodeKind(nodeId: string, steps: readonly EditorStep[]): NodeKind {
  if (isTriggerNode(nodeId)) {
    return "trigger";
  }
  return steps.find((step) => step.id === nodeId)?.kind ?? "agent";
}

function selectedNodeId(selection: EditorSelection): string | null {
  if (selection.kind === "trigger") {
    return TRIGGER_NODE_ID;
  }
  return selection.kind === "step" ? selection.id : null;
}

/** The selected node and its direct neighbours stay lit; the rest dims. */
function litNodes(layout: CanvasLayout, focused: string | null): Set<string> | null {
  if (!focused) {
    return null;
  }
  const lit = new Set([focused]);
  for (const { edge } of layout.edges) {
    if (edge.from === focused) lit.add(edge.to);
    if (edge.to === focused) lit.add(edge.from);
  }
  return lit;
}

/**
 * The automation's graph: the trigger, its steps and their links, laid out automatically. Press a
 * node to inspect it; the + on a node's outgoing side adds the next step, the + on a link puts a
 * step between, and on web a drag from a node's handle onto another node links them.
 */
export function AutomationEditorCanvas(props: AutomationEditorCanvasProps): ReactElement {
  const { state, direction, layout, nodeText, runStatuses, editable } = props;
  const { t } = useTranslation();
  const focused = selectedNodeId(state.selection);
  const lit = useMemo(() => litNodes(layout, focused), [focused, layout]);
  const rootRef = useRef<View>(null);
  const [dragLine, setDragLine] = useState<CanvasDragLine | null>(null);
  const kindOf = useCallback((nodeId: string) => nodeKind(nodeId, state.steps), [state.steps]);
  const handleOrigin = useCallback(
    (nodeId: string, branch: AutomationEdgeBranch | undefined): Point | null => {
      const box = layout.nodes.get(nodeId);
      if (!box) return null;
      const handleBranch: HandleBranch =
        kindOf(nodeId) === "condition" ? (branch ?? "true") : "always";
      return handlePoint(box, handleBranch, layout.direction);
    },
    [kindOf, layout],
  );
  useCanvasDragConnect(rootRef, {
    canvasWidth: layout.width,
    handleOrigin,
    onDrag: setDragLine,
    onConnect: props.onConnect,
  });
  const sizeStyle = useMemo(
    () => inlineUnistylesStyle({ width: layout.width, height: layout.height }),
    [layout.height, layout.width],
  );
  const handleBackgroundPress = useCallback(() => props.onSelect({ kind: "none" }), [props]);
  const dragPath = dragLine ? linkPath(dragLine.from, dragLine.to, direction).path : null;

  return (
    <View ref={rootRef} style={sizeStyle} testID="automation-canvas">
      <PressHighlight
        style={StyleSheet.absoluteFill}
        onPress={handleBackgroundPress}
        accessible={false}
        testID="automation-canvas-background"
      />
      <Svg width={layout.width} height={layout.height} style={styles.svg} pointerEvents="none">
        {layout.edges.map((canvasEdge) => (
          <EdgeShape
            key={canvasEdge.key}
            canvasEdge={canvasEdge}
            dimmed={lit !== null && !(lit.has(canvasEdge.edge.from) && lit.has(canvasEdge.edge.to))}
            focused={
              focused !== null &&
              (canvasEdge.edge.from === focused || canvasEdge.edge.to === focused)
            }
            runStatus={runStatuses?.get(canvasEdge.edge.to) ?? null}
            branch={
              kindOf(canvasEdge.edge.from) === "condition"
                ? (canvasEdge.edge.branch ?? "true")
                : "always"
            }
          />
        ))}
        {dragPath ? (
          <Path
            d={dragPath}
            stroke={styles.dragStroke.color}
            strokeWidth={FOCUSED_EDGE_WIDTH}
            strokeDasharray={EDGE_DASH}
            fill="none"
          />
        ) : null}
      </Svg>
      {[...layout.nodes.values()].map((box) => {
        const text = nodeText.get(box.id) ?? { title: box.id, subtitle: "" };
        return (
          <CanvasNode
            key={box.id}
            box={box}
            kind={kindOf(box.id)}
            title={text.title}
            subtitle={text.subtitle}
            selected={focused === box.id}
            dimmed={lit !== null && !lit.has(box.id)}
            problems={state.problemsByTarget.get(box.id) ?? null}
            runStatus={runStatuses?.get(box.id) ?? null}
            onSelect={props.onSelect}
          />
        );
      })}
      {editable
        ? layout.edges.map((canvasEdge) => (
            <EdgeButton
              key={`button:${canvasEdge.key}`}
              canvasEdge={canvasEdge}
              onInsert={props.onInsert}
              onDisconnect={props.onDisconnect}
              removable={!isTriggerNode(canvasEdge.edge.from)}
            />
          ))
        : null}
      {editable
        ? [...layout.nodes.values()].flatMap((box) => {
            const kind = kindOf(box.id);
            const branches: HandleBranch[] = kind === "condition" ? ["true", "false"] : ["always"];
            return branches.map((branch) => (
              <NodeHandle
                key={`handle:${box.id}:${branch}`}
                box={box}
                kind={kind}
                branch={branch}
                direction={layout.direction}
                state={state}
                yesLabel={t("automationEditor.nodes.yes")}
                noLabel={t("automationEditor.nodes.no")}
                onAddAfter={props.onAddAfter}
                onConnect={props.onConnect}
              />
            ));
          })
        : null}
    </View>
  );
}

const EdgeShape = memo(function EdgeShape({
  canvasEdge,
  dimmed,
  focused,
  runStatus,
  branch,
}: {
  canvasEdge: CanvasEdge;
  dimmed: boolean;
  focused: boolean;
  runStatus: AutomationRunStepStatus | null;
  branch: HandleBranch;
}): ReactElement {
  let color = styles.edgeStroke.color;
  if (branch === "true") color = styles.yesStroke.color;
  if (branch === "false") color = styles.noStroke.color;
  // A link the shown run took is drawn solid.
  const taken = runStatus !== null && runStatus !== "pending" && runStatus !== "skipped";
  const opacity = dimmed ? DIMMED_EDGE : 1;
  return (
    <>
      <Path
        d={canvasEdge.path}
        stroke={color}
        strokeOpacity={opacity}
        strokeWidth={focused ? FOCUSED_EDGE_WIDTH : EDGE_WIDTH}
        strokeDasharray={taken ? undefined : EDGE_DASH}
        fill="none"
      />
      <Polygon points={canvasEdge.arrow} fill={color} fillOpacity={opacity} />
    </>
  );
});

function useNodeStyles(kind: NodeKind) {
  switch (kind) {
    case "trigger":
      return { border: styles.borderTrigger, tint: styles.tintTrigger, tile: styles.tileTrigger };
    case "condition":
      return { border: styles.borderCheck, tint: styles.tintCheck, tile: styles.tileCheck };
    default:
      return { border: styles.borderAgent, tint: styles.tintAgent, tile: styles.tileAgent };
  }
}

const RUN_STATUS_STYLE: Record<
  AutomationRunStepStatus,
  "muted" | "success" | "danger" | "warning"
> = {
  pending: "muted",
  running: "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted",
  skipped: "muted",
};

const CanvasNode = memo(function CanvasNode({
  box,
  kind,
  title,
  subtitle,
  selected,
  dimmed,
  problems,
  runStatus,
  onSelect,
}: {
  box: CanvasNodeBox;
  kind: NodeKind;
  title: string;
  subtitle: string;
  selected: boolean;
  dimmed: boolean;
  problems: EditorProblem[] | null;
  runStatus: AutomationRunStepStatus | null;
  onSelect: (selection: EditorSelection) => void;
}): ReactElement {
  const { t } = useTranslation();
  const kindStyles = useNodeStyles(kind);
  const Icon = KIND_ICON[kind];
  const hasProblem = problems !== null && problems.length > 0;
  const nodeStyle = useMemo(
    () => [
      styles.node,
      kindStyles.border,
      inlineUnistylesStyle({ left: box.x, top: box.y, opacity: dimmed ? DIMMED_NODE : 1 }),
      selected && styles.nodeSelected,
      hasProblem && styles.nodeProblem,
    ],
    [box.x, box.y, dimmed, hasProblem, kindStyles.border, selected],
  );
  const tintStyle = useMemo(
    () => [
      StyleSheet.absoluteFill,
      kindStyles.tint,
      inlineUnistylesStyle({ opacity: selected ? FOCUSED_BODY_TINT : BODY_TINT }),
    ],
    [kindStyles.tint, selected],
  );
  const handlePress = useCallback(() => {
    onSelect(kind === "trigger" ? { kind: "trigger" } : { kind: "step", id: box.id });
  }, [box.id, kind, onSelect]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const statusTone = runStatus ? RUN_STATUS_STYLE[runStatus] : null;
  return (
    <PressHighlight
      style={nodeStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={accessibilityState}
      testID={`automation-node:${box.id}`}
    >
      <View style={tintStyle} pointerEvents="none" />
      <View style={[styles.tile, kindStyles.tile]}>
        <Icon size={16} color={styles.tileIcon.color} />
      </View>
      <View style={styles.nodeBody}>
        <Text style={styles.nodeTitle} numberOfLines={1}>
          {title}
        </Text>
        {hasProblem ? (
          <View style={styles.problemRow}>
            <AlertTriangle size={12} color={styles.problemText.color} />
            <Text style={styles.problemText} numberOfLines={1}>
              {problems?.[0]
                ? t(
                    `automationEditor.problems.${problemKey(problems[0])}`,
                    problemParams(problems[0]),
                  )
                : ""}
            </Text>
          </View>
        ) : (
          <Text style={styles.nodeSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {runStatus && statusTone ? (
        <View
          style={[styles.statusChip, styles[`chip_${statusTone}`]]}
          testID={`automation-node-status:${box.id}`}
        >
          <Text style={[styles.statusText, styles[`chipText_${statusTone}`]]}>
            {t(`automationEditor.runs.stepStatus.${runStatus}`)}
          </Text>
        </View>
      ) : null}
    </PressHighlight>
  );
});

/** The translation key under `automationEditor.problems` for a problem. */
export function problemKey(problem: EditorProblem): string {
  switch (problem.code) {
    case "bad_step_id":
    case "duplicate_step_id":
    case "edge_missing_step":
    case "self_edge":
    case "duplicate_edge":
      return "bad_link";
    case "cycle":
      return "loop_member";
    case "missing_provider":
      return "missing_model";
    default:
      return problem.code;
  }
}

export function problemParams(problem: EditorProblem): Record<string, string> {
  return { ref: problem.ref ?? "", detail: problem.cronError ?? problem.message };
}

function NodeHandle({
  box,
  kind,
  branch,
  direction,
  state,
  yesLabel,
  noLabel,
  onAddAfter,
  onConnect,
}: {
  box: CanvasNodeBox;
  kind: NodeKind;
  branch: HandleBranch;
  direction: CanvasDirection;
  state: AutomationEditorCanvasProps["state"];
  yesLabel: string;
  noLabel: string;
  onAddAfter: AutomationEditorCanvasProps["onAddAfter"];
  onConnect: AutomationEditorCanvasProps["onConnect"];
}): ReactElement {
  const { t } = useTranslation();
  const point = handlePoint(box, branch, direction);
  const edgeBranch = branch === "always" ? undefined : branch;
  const handleStyle = useMemo(
    () => [
      styles.handle,
      branch === "true" && styles.handleYes,
      branch === "false" && styles.handleNo,
      inlineUnistylesStyle({ left: point.x - HANDLE_SIZE / 2, top: point.y - HANDLE_SIZE / 2 }),
    ],
    [branch, point.x, point.y],
  );
  const labelStyle = useMemo(
    () => [
      styles.handleLabel,
      branch === "true" ? styles.yesText : styles.noText,
      direction === "right"
        ? inlineUnistylesStyle({ left: point.x + HANDLE_SIZE / 2 + 2, top: point.y - 18 })
        : inlineUnistylesStyle({ left: point.x - 30, top: point.y + HANDLE_SIZE / 2 }),
    ],
    [branch, direction, point.x, point.y],
  );
  const targets = useMemo(
    () => (kind === "trigger" ? [] : connectableTargets(state, box.id, edgeBranch)),
    [box.id, edgeBranch, kind, state],
  );
  const from = useMemo(
    () => ({ nodeId: box.id, ...(edgeBranch ? { branch: edgeBranch } : {}) }),
    [box.id, edgeBranch],
  );
  const addAgent = useCallback(() => onAddAfter("agent", from), [from, onAddAfter]);
  const addCheck = useCallback(() => onAddAfter("condition", from), [from, onAddAfter]);
  let branchLabel: string | null = null;
  if (branch === "true") {
    branchLabel = yesLabel;
  } else if (branch === "false") {
    branchLabel = noLabel;
  }
  return (
    <>
      {branchLabel ? (
        <Text style={labelStyle} pointerEvents="none">
          {branchLabel}
        </Text>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          style={handleStyle}
          accessibilityRole="button"
          accessibilityLabel={
            branchLabel
              ? t("automationEditor.nodes.addAfterBranch", { branch: branchLabel })
              : t("automationEditor.nodes.addAfter")
          }
          testID={`automation-handle:${box.id}:${branch}`}
        >
          <Plus size={12} color={styles.handleIcon.color} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          width={220}
          sheetTitle={t("automationEditor.nodes.addAfter")}
        >
          <DropdownMenuLabel>
            {branchLabel
              ? t("automationEditor.nodes.addAfterBranch", { branch: branchLabel })
              : t("automationEditor.nodes.addAfter")}
          </DropdownMenuLabel>
          <DropdownMenuItem
            leading={agentMenuIcon}
            onSelect={addAgent}
            testID="automation-add-agent"
          >
            {t("automationEditor.palette.agent")}
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={checkMenuIcon}
            onSelect={addCheck}
            testID="automation-add-check"
          >
            {t("automationEditor.palette.check")}
          </DropdownMenuItem>
          {targets.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("automationEditor.nodes.connectTo")}</DropdownMenuLabel>
              {targets.map((target) => (
                <ConnectItem
                  key={target.id}
                  from={box.id}
                  to={target.id}
                  branch={edgeBranch}
                  label={target.title || target.id}
                  onConnect={onConnect}
                />
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function ConnectItem({
  from,
  to,
  branch,
  label,
  onConnect,
}: {
  from: string;
  to: string;
  branch: AutomationEdgeBranch | undefined;
  label: string;
  onConnect: (from: string, to: string, branch: AutomationEdgeBranch | undefined) => void;
}): ReactElement {
  const handleSelect = useCallback(
    () => onConnect(from, to, branch),
    [branch, from, onConnect, to],
  );
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`automation-connect-${from}-${to}`}>
      {label}
    </DropdownMenuItem>
  );
}

function EdgeButton({
  canvasEdge,
  removable,
  onInsert,
  onDisconnect,
}: {
  canvasEdge: CanvasEdge;
  removable: boolean;
  onInsert: AutomationEditorCanvasProps["onInsert"];
  onDisconnect: AutomationEditorCanvasProps["onDisconnect"];
}): ReactElement {
  const { t } = useTranslation();
  const { edge, mid } = canvasEdge;
  const buttonStyle = useMemo(
    () => [
      styles.edgeButton,
      inlineUnistylesStyle({
        left: mid.x - EDGE_BUTTON_SIZE / 2,
        top: mid.y - EDGE_BUTTON_SIZE / 2,
      }),
    ],
    [mid.x, mid.y],
  );
  const insertAgent = useCallback(() => onInsert("agent", edge), [edge, onInsert]);
  const insertCheck = useCallback(() => onInsert("condition", edge), [edge, onInsert]);
  const remove = useCallback(() => onDisconnect(edge), [edge, onDisconnect]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={buttonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("automationEditor.nodes.insert")}
        testID={`automation-edge:${edge.from}:${edge.to}`}
      >
        <Plus size={11} color={styles.handleIcon.color} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        width={220}
        sheetTitle={t("automationEditor.nodes.insert")}
      >
        <DropdownMenuLabel>{t("automationEditor.nodes.insert")}</DropdownMenuLabel>
        <DropdownMenuItem
          leading={agentMenuIcon}
          onSelect={insertAgent}
          testID="automation-insert-agent"
        >
          {t("automationEditor.palette.agent")}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={checkMenuIcon}
          onSelect={insertCheck}
          testID="automation-insert-check"
        >
          {t("automationEditor.palette.check")}
        </DropdownMenuItem>
        {removable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={remove} testID="automation-remove-link">
              {t("automationEditor.nodes.removeLink")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { NODE_HEIGHT, NODE_WIDTH };

const styles = StyleSheet.create((theme) => {
  const hue = (name: "violet" | "amber" | "sky") => identityForeground(name, theme.colorScheme);
  return {
    svg: {
      position: "absolute",
      left: 0,
      top: 0,
    },
    edgeStroke: { color: theme.colors.foregroundMuted },
    yesStroke: { color: theme.colors.statusSuccess },
    noStroke: { color: theme.colors.statusDanger },
    dragStroke: { color: theme.colors.accent },
    node: {
      position: "absolute",
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      flexDirection: "row",
      overflow: "hidden",
      borderRadius: 8,
      borderWidth: 1.5,
      backgroundColor: theme.colors.surface1,
    },
    nodeSelected: {
      borderWidth: 2.5,
    },
    nodeProblem: {
      borderColor: theme.colors.statusDanger,
    },
    borderTrigger: { borderColor: hue("sky") },
    borderAgent: { borderColor: hue("violet") },
    borderCheck: { borderColor: hue("amber") },
    tintTrigger: { backgroundColor: hue("sky") },
    tintAgent: { backgroundColor: hue("violet") },
    tintCheck: { backgroundColor: hue("amber") },
    tile: {
      width: TILE_WIDTH,
      alignItems: "center",
      justifyContent: "center",
    },
    tileTrigger: { backgroundColor: hue("sky") },
    tileAgent: { backgroundColor: hue("violet") },
    tileCheck: { backgroundColor: hue("amber") },
    tileIcon: { color: theme.colors.surface1 },
    nodeBody: {
      flex: 1,
      minWidth: 0,
      justifyContent: "center",
      gap: 2,
      paddingHorizontal: theme.spacing[3],
    },
    nodeTitle: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      fontWeight: "500",
    },
    nodeSubtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    problemRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    problemText: {
      flexShrink: 1,
      color: theme.colors.statusDanger,
      fontSize: theme.fontSize.sm,
    },
    statusChip: {
      position: "absolute",
      top: 4,
      right: 4,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: theme.borderRadius.full,
      borderWidth: 1,
      backgroundColor: theme.colors.surface1,
    },
    statusText: {
      fontSize: 11,
      fontWeight: "500",
    },
    chip_muted: { borderColor: theme.colors.border },
    chip_success: { borderColor: theme.colors.statusSuccess },
    chip_danger: { borderColor: theme.colors.statusDanger },
    chip_warning: { borderColor: theme.colors.statusWarning },
    chipText_muted: { color: theme.colors.foregroundMuted },
    chipText_success: { color: theme.colors.statusSuccess },
    chipText_danger: { color: theme.colors.statusDanger },
    chipText_warning: { color: theme.colors.statusWarning },
    handle: {
      position: "absolute",
      width: HANDLE_SIZE,
      height: HANDLE_SIZE,
      borderRadius: HANDLE_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: theme.colors.foregroundMuted,
      backgroundColor: theme.colors.surface1,
    },
    handleYes: { borderColor: theme.colors.statusSuccess },
    handleNo: { borderColor: theme.colors.statusDanger },
    handleIcon: { color: theme.colors.foreground },
    handleLabel: {
      position: "absolute",
      width: 28,
      fontSize: 11,
      fontWeight: "500",
    },
    yesText: { color: theme.colors.statusSuccess },
    noText: { color: theme.colors.statusDanger, textAlign: "right" },
    edgeButton: {
      position: "absolute",
      width: EDGE_BUTTON_SIZE,
      height: EDGE_BUTTON_SIZE,
      borderRadius: EDGE_BUTTON_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
  };
});
