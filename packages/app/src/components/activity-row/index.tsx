import { ChevronRight, FileSymlink } from "lucide-react-native";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { bySizing } from "@/components/ui/control-sizing";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useTranslation } from "@/i18n/use-translation";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ActivityText } from "./activity-text";
import { useDetailWheelBlocker } from "./use-detail-wheel-blocker";

/** Where a row's text starts, from the message text edge: glyph column, then the gap. */
export const ACTIVITY_ROW_TEXT_OFFSET = 28;

export type ActivityRowState = "idle" | "running" | "failed" | "canceled";

type GlyphComponent = ComponentType<{ size?: number; color?: string }>;

export interface ActivityRowProps {
  icon: GlyphComponent;
  /** What the step did, or is doing: "Read", "Running". */
  verb: string;
  /** What it did it to: a path, a query, a command. */
  target?: string;
  targetMono?: boolean;
  /** Short text after the label, such as a task count. */
  meta?: string;
  diffStat?: { additions: number; deletions: number };
  state?: ActivityRowState;
  isExpanded: boolean;
  /** The details are rows on their own rail, so they start at the glyph column. */
  nested?: boolean;
  onToggle?: () => void;
  onOpenFile?: () => void;
  onDetailHoverChange?: (hovered: boolean) => void;
  /** Hover or press-in on the header: warm whatever opening the row will need. */
  onPrefetch?: () => void;
  renderDetails?: () => ReactNode;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  testID?: string;
}

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface ThemedGlyphProps {
  icon: GlyphComponent;
  tone: "muted" | "danger";
}

const mutedGlyphs = new WeakMap<GlyphComponent, GlyphComponent>();
const dangerGlyphs = new WeakMap<GlyphComponent, GlyphComponent>();

function themedGlyph(icon: GlyphComponent, tone: ThemedGlyphProps["tone"]): GlyphComponent {
  const cache = tone === "muted" ? mutedGlyphs : dangerGlyphs;
  const existing = cache.get(icon);
  if (existing) return existing;
  const created = withUnistyles(icon, tone === "muted" ? mutedMapping : dangerMapping);
  cache.set(icon, created);
  return created;
}

const ThemedChevron = withUnistyles(ChevronRight, mutedMapping);
const ThemedOpenFile = withUnistyles(FileSymlink, mutedMapping);
const ThemedOpenFileHovered = withUnistyles(FileSymlink, foregroundMapping);

const TrailingMeta = memo(function TrailingMeta({
  diffStat,
  text,
  failed,
}: {
  diffStat: ActivityRowProps["diffStat"];
  text: string | undefined;
  failed: boolean;
}) {
  return (
    <>
      {diffStat ? (
        <View style={styles.meta}>
          <DiffStat additions={diffStat.additions} deletions={diffStat.deletions} />
        </View>
      ) : null}
      {text ? (
        <Text style={[styles.meta, styles.metaText, failed && styles.metaFailed]} numberOfLines={1}>
          {text}
        </Text>
      ) : null}
    </>
  );
});

function RowChevron({ visible, expanded }: { visible: boolean; expanded: boolean }) {
  return (
    <View
      style={[styles.chevron, !visible && styles.chevronHidden, expanded && styles.chevronOpen]}
      pointerEvents="none"
    >
      <ThemedChevron size={ICON_SIZE.sm} />
    </View>
  );
}

function OpenFileButton({ visible, onOpenFile }: { visible: boolean; onOpenFile: () => void }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation?.();
      onOpenFile();
    },
    [onOpenFile],
  );
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  return (
    <PressHighlight
      style={[styles.openFile, !visible && styles.openFileHidden]}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      accessibilityRole="button"
      accessibilityLabel={t("message.actions.openFile")}
      testID="tool-call-open-file"
      hitSlop={6}
    >
      {hovered ? (
        <ThemedOpenFileHovered size={ICON_SIZE.sm} />
      ) : (
        <ThemedOpenFile size={ICON_SIZE.sm} />
      )}
    </PressHighlight>
  );
}

function useTrailingText(state: ActivityRowState, meta: string | undefined): string | undefined {
  const { t } = useTranslation();
  if (state === "failed") return t("activity.failed");
  if (state === "canceled") return t("activity.stopped");
  return meta;
}

function useRowAccessibility(input: {
  verb: string;
  target: string | undefined;
  trailing: string | undefined;
  state: ActivityRowState;
  isInteractive: boolean;
  isExpanded: boolean;
}) {
  const { verb, target, trailing, state, isInteractive, isExpanded } = input;
  const label = target ? `${verb} ${target}` : verb;
  const showsStatus = state === "failed" || state === "canceled";
  return {
    accessibilityRole: isInteractive ? ("button" as const) : undefined,
    accessibilityLabel: showsStatus && trailing ? `${label}, ${trailing}` : label,
    accessibilityState: useMemo(
      () => (isInteractive ? { expanded: isExpanded } : undefined),
      [isExpanded, isInteractive],
    ),
  };
}

function useRowHover(onPrefetch: (() => void) | undefined) {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => {
    setIsHovered(true);
    onPrefetch?.();
  }, [onPrefetch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  return { isHovered, handlePointerEnter, handlePointerLeave };
}

function RowDetails({
  children,
  nested,
  onHoverChange,
}: {
  children: ReactNode;
  nested: boolean | undefined;
  onHoverChange: ((hovered: boolean) => void) | undefined;
}) {
  const detailRef = useRef<View | null>(null);
  useDetailWheelBlocker({ detailRef, enabled: isWeb });
  const handlePointerEnter = useCallback(() => onHoverChange?.(true), [onHoverChange]);
  const handlePointerLeave = useCallback(() => onHoverChange?.(false), [onHoverChange]);
  return (
    <View
      ref={detailRef}
      style={[styles.detail, !nested && styles.detailIndented]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {children}
    </View>
  );
}

export const ActivityRow = memo(function ActivityRow({
  icon,
  verb,
  target,
  targetMono,
  meta,
  diffStat,
  state = "idle",
  isExpanded,
  nested,
  onToggle,
  onOpenFile,
  onDetailHoverChange,
  onPrefetch,
  renderDetails,
  isLastInSequence,
  disableOuterSpacing,
  testID,
}: ActivityRowProps) {
  const isCompact = useIsCompactFormFactor();
  const panelActive = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const { isHovered, handlePointerEnter, handlePointerLeave } = useRowHover(onPrefetch);

  const isInteractive = Boolean(onToggle);
  const running = state === "running";
  const failed = state === "failed";
  const detailContent = renderDetails && isExpanded ? renderDetails() : null;
  const trailing = useTrailingText(state, meta);
  const accessibility = useRowAccessibility({
    verb,
    target,
    trailing,
    state,
    isInteractive,
    isExpanded,
  });

  const Glyph = themedGlyph(icon, failed ? "danger" : "muted");
  const showChevron = isInteractive && (isHovered || isNative || isCompact || isExpanded);
  const pressableStyle = useMemo(
    () => [styles.pressable, isHovered && isInteractive && styles.pressableHovered],
    [isHovered, isInteractive],
  );

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        !disableOuterSpacing && isLastInSequence && styles.containerLastInSequence,
      ]}
    >
      <View
        style={styles.hoverTarget}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <PressHighlight
          style={pressableStyle}
          highlightStyle={isInteractive ? styles.highlight : undefined}
          disabled={!isInteractive}
          onPress={onToggle}
          onPressIn={onPrefetch}
          {...accessibility}
        >
          <View style={styles.glyph}>
            <Glyph size={ICON_SIZE.sm} />
          </View>
          <ActivityText
            verb={verb}
            target={target}
            targetMono={targetMono}
            emphasized={isHovered || isExpanded}
            running={running}
            shimmer={running && panelActive && !reduceMotion}
          />
          <TrailingMeta diffStat={diffStat} text={trailing} failed={failed} />
          {isInteractive ? <RowChevron visible={showChevron} expanded={isExpanded} /> : null}
        </PressHighlight>
        {onOpenFile ? <OpenFileButton visible={isHovered} onOpenFile={onOpenFile} /> : null}
      </View>
      {detailContent ? (
        <RowDetails nested={nested} onHoverChange={onDetailHoverChange}>
          {detailContent}
        </RowDetails>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {},
  containerLastInSequence: {
    marginBottom: theme.spacing[4],
  },
  // Hugs the row's content, with the pill's padding pulled back out so the glyph sits on the rail.
  hoverTarget: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginLeft: -theme.spacing[2],
  },
  pressable: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    height: bySizing({ touch: 36, pointer: 28 }),
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  pressableHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  highlight: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  glyph: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[3],
    flexShrink: 0,
  },
  meta: {
    marginLeft: theme.spacing[2],
    flexShrink: 0,
  },
  metaText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  metaFailed: {
    color: theme.colors.statusDanger,
  },
  chevron: {
    width: 14,
    height: 14,
    marginLeft: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronHidden: {
    opacity: 0,
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  openFile: {
    marginLeft: theme.spacing[1],
    flexShrink: 0,
    borderRadius: theme.borderRadius.md,
  },
  openFileHidden: {
    opacity: 0,
  },
  detail: {
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[2],
    minWidth: 0,
    ...(isWeb ? { cursor: "auto" as const, userSelect: "text" as const } : {}),
  },
  detailIndented: {
    marginLeft: ACTIVITY_ROW_TEXT_OFFSET,
  },
}));
