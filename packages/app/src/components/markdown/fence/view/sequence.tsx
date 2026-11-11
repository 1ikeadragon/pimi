import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Path, Polygon } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SequenceNode, SequenceStep, ViewTone } from "@pimi/protocol/chat-view";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";

/**
 * A sequence diagram: one column per participant, one row per step, time running down. Rows are
 * ordinary views, so a long message wraps under its own arrow instead of shrinking the diagram,
 * and the same layout serves a phone and a desktop. Only the arrows are drawn.
 */

/** Average advance of a 12px UI-font glyph, the estimate the flow layout uses. */
const CHARACTER_WIDTH = 6.8;
const ARROW_HEIGHT = 12;
const ARROW_LENGTH = 7;
const ARROW_HALF_WIDTH = 3.5;
const SELF_HEIGHT = 18;
const SELF_REACH = 18;
const REPLY_DASH = "4 3";
/** How far each nested group frame sits inside the one around it. */
const FRAME_INSET = 6;
/** Room between a message and the lifeline it starts from when it does not fit over its arrow. */
const LABEL_GAP = 8;

type Row =
  | { kind: "open"; key: string; depth: number; label: string }
  | { kind: "close"; key: string; depth: number }
  | { kind: "note"; key: string; depth: number; text: string }
  | {
      kind: "message";
      key: string;
      depth: number;
      number: number;
      from: number;
      to: number;
      label: string;
      reply: boolean;
      tone: ViewTone;
    };

/** Steps as rows. A group becomes the row that opens its frame, its steps, and the closing row. */
function buildRows(node: SequenceNode): Row[] {
  const columns = new Map(node.participants.map(({ id }, index) => [id, index]));
  const rows: Row[] = [];
  let messages = 0;
  const walk = (steps: readonly SequenceStep[], depth: number, path: string) => {
    steps.forEach((step, position) => {
      const key = `${path}${position}`;
      if ("steps" in step) {
        rows.push({ kind: "open", key: `${key}:open`, depth: depth + 1, label: step.group });
        walk(step.steps, depth + 1, `${key}.`);
        rows.push({ kind: "close", key: `${key}:close`, depth: depth + 1 });
      } else if ("note" in step) {
        rows.push({ kind: "note", key, depth, text: step.note });
      } else {
        messages += 1;
        rows.push({
          kind: "message",
          key,
          depth,
          number: messages,
          from: columns.get(step.from) ?? 0,
          to: columns.get(step.to) ?? 0,
          label: step.label,
          reply: step.reply ?? false,
          tone: step.tone ?? "neutral",
        });
      }
    });
  };
  walk(node.steps, 0, "");
  return rows;
}

function Arrow({
  width,
  from,
  to,
  reply,
  color,
}: {
  width: number;
  from: number;
  to: number;
  reply: boolean;
  color?: string;
}) {
  if (!color) return null;
  const dash = reply ? REPLY_DASH : undefined;
  if (from === to) {
    // A message to itself leaves the lifeline and comes back, on the side with more room.
    const side = from <= width / 2 ? 1 : -1;
    const out = from + side * SELF_REACH;
    const bottom = SELF_HEIGHT - ARROW_HALF_WIDTH - 1;
    const tip = from + side * 1;
    return (
      <Svg width={width} height={SELF_HEIGHT}>
        <Path
          d={`M ${from} 3 H ${out} V ${bottom} H ${tip + side * ARROW_LENGTH}`}
          fill="none"
          stroke={color}
          strokeWidth={1.25}
          strokeDasharray={dash}
        />
        <Polygon
          points={`${tip},${bottom} ${tip + side * ARROW_LENGTH},${bottom - ARROW_HALF_WIDTH} ${tip + side * ARROW_LENGTH},${bottom + ARROW_HALF_WIDTH}`}
          fill={color}
        />
      </Svg>
    );
  }
  const direction = to > from ? 1 : -1;
  const y = ARROW_HEIGHT / 2;
  const tip = to - direction;
  const neck = tip - direction * ARROW_LENGTH;
  return (
    <Svg width={width} height={ARROW_HEIGHT}>
      <Line
        x1={from}
        y1={y}
        x2={neck}
        y2={y}
        stroke={color}
        strokeWidth={1.25}
        strokeDasharray={dash}
      />
      <Polygon
        points={`${tip},${y} ${neck},${y - ARROW_HALF_WIDTH} ${neck},${y + ARROW_HALF_WIDTH}`}
        fill={color}
      />
    </Svg>
  );
}

const ThemedArrow = withUnistyles(Arrow);

const ARROW_COLORS: Record<ViewTone, (theme: Theme) => { color: string }> = {
  neutral: (theme) => ({ color: theme.colors.foregroundMuted }),
  positive: (theme) => ({ color: theme.colors.statusSuccess }),
  negative: (theme) => ({ color: theme.colors.statusDanger }),
  warning: (theme) => ({ color: theme.colors.statusWarning }),
};

/** The sides of every group frame this row sits inside. */
function Frames({ depth }: { depth: number }) {
  return Array.from({ length: depth }, (_, level) => (
    <View
      // eslint-disable-next-line react/no-array-index-key
      key={level}
      style={[
        styles.frameSides,
        inlineUnistylesStyle({ left: level * FRAME_INSET, right: level * FRAME_INSET }),
      ]}
    />
  ));
}

/**
 * Where a message sits above its arrow: centred over the arrow when it fits there, otherwise
 * starting from the arrow's end nearer the edge so it wraps across the rest of the diagram.
 */
function labelPlacement(label: string, low: number, high: number, width: number) {
  const estimate = (label.length + 3) * CHARACTER_WIDTH;
  if (estimate <= high - low - 2 * LABEL_GAP) {
    return { marginLeft: low, width: high - low, textAlign: "center" } as const;
  }
  if ((low + high) / 2 <= width / 2) {
    return { marginLeft: low + LABEL_GAP, alignSelf: "flex-start", textAlign: "left" } as const;
  }
  // Wrapped lines still start together; the block as a whole ends at the arrow.
  return {
    marginRight: width - high + LABEL_GAP,
    alignSelf: "flex-end",
    textAlign: "left",
  } as const;
}

function MessageRow({
  row,
  width,
  centers,
  names,
}: {
  row: Extract<Row, { kind: "message" }>;
  width: number;
  centers: number[];
  names: string[];
}) {
  const from = centers[row.from];
  const to = centers[row.to];
  const tones = {
    neutral: null,
    positive: styles.tonePositive,
    negative: styles.toneNegative,
    warning: styles.toneWarning,
  };
  return (
    <View
      style={styles.messageRow}
      accessibilityLabel={`${names[row.from]} to ${names[row.to]}: ${row.label}`}
      testID="chat-view-sequence-message"
    >
      <Frames depth={row.depth} />
      <Text
        selectable
        style={[
          styles.message,
          tones[row.tone],
          inlineUnistylesStyle(
            labelPlacement(row.label, Math.min(from, to), Math.max(from, to), width),
          ),
        ]}
      >
        <Text style={styles.number}>{row.number} </Text>
        {row.label}
      </Text>
      <ThemedArrow
        width={width}
        from={from}
        to={to}
        reply={row.reply}
        uniProps={ARROW_COLORS[row.tone]}
      />
    </View>
  );
}

function RowView({
  row,
  width,
  centers,
  names,
}: {
  row: Row;
  width: number;
  centers: number[];
  names: string[];
}) {
  if (row.kind === "message") {
    return <MessageRow row={row} width={width} centers={centers} names={names} />;
  }
  const inset = (row.depth - 1) * FRAME_INSET;
  if (row.kind === "open") {
    return (
      <View style={styles.openRow}>
        <Frames depth={row.depth - 1} />
        <View style={[styles.frameTop, inlineUnistylesStyle({ marginHorizontal: inset })]}>
          <Text style={styles.groupLabel}>{row.label}</Text>
        </View>
      </View>
    );
  }
  if (row.kind === "close") {
    return (
      <View style={styles.closeRow}>
        <Frames depth={row.depth - 1} />
        <View style={[styles.frameBottom, inlineUnistylesStyle({ marginHorizontal: inset })]} />
      </View>
    );
  }
  return (
    <View style={styles.noteRow}>
      <Frames depth={row.depth} />
      <View
        style={[
          styles.note,
          inlineUnistylesStyle({ marginHorizontal: row.depth * FRAME_INSET + LABEL_GAP }),
        ]}
      >
        <Text selectable style={styles.noteText}>
          {row.text}
        </Text>
      </View>
    </View>
  );
}

export function SequenceView({ node }: { node: SequenceNode }) {
  const [width, setWidth] = useState(0);
  const rows = useMemo(() => buildRows(node), [node]);
  const names = useMemo(() => node.participants.map(({ label }) => label), [node.participants]);
  const column = width / node.participants.length;
  const centers = useMemo(
    () => node.participants.map((_, index) => Math.round(column * (index + 0.5))),
    [column, node.participants],
  );
  const measure = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const measured = Math.floor(nativeEvent.layout.width);
    // A hidden retained panel reports zero; keep the last real width.
    if (measured > 0) setWidth(measured);
  }, []);
  return (
    <View style={styles.sequence} onLayout={measure} testID="chat-view-sequence">
      {width > 0 ? (
        <>
          <View style={styles.header}>
            {node.participants.map((participant) => (
              <View key={participant.id} style={styles.headerCell}>
                <View style={styles.participant}>
                  <Text style={styles.participantLabel} numberOfLines={4}>
                    {participant.label}
                  </Text>
                </View>
              </View>
            ))}
          </View>
          <View style={styles.body}>
            {centers.map((center, index) => (
              <View
                key={node.participants[index].id}
                style={[styles.lifeline, inlineUnistylesStyle({ left: center })]}
              />
            ))}
            {rows.map((row) => (
              <RowView key={row.key} row={row} width={width} centers={centers} names={names} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // ltr: arrows are positioned in pixels from the left edge.
  sequence: { alignSelf: "stretch", minWidth: 0, direction: "ltr" },
  header: { flexDirection: "row", alignItems: "stretch" },
  headerCell: { flex: 1, minWidth: 0, paddingHorizontal: 2, alignItems: "center" },
  participant: {
    alignSelf: "stretch",
    flexGrow: 1,
    maxWidth: 200,
    width: "100%",
    marginHorizontal: "auto",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    // Five columns on a phone leave about 60 px a name.
    paddingHorizontal: 2,
    paddingVertical: theme.spacing[1.5],
  },
  participantLabel: {
    color: theme.colors.foreground,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  body: { paddingTop: theme.spacing[2], paddingBottom: theme.spacing[2] },
  lifeline: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: theme.colors.border,
  },
  messageRow: { paddingTop: theme.spacing[1.5], paddingBottom: theme.spacing[1] },
  message: {
    color: theme.colors.foreground,
    // Hides the lifelines the text crosses.
    backgroundColor: theme.colors.surface1,
    fontSize: 12,
    lineHeight: 16,
    flexShrink: 1,
  },
  number: { color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  tonePositive: { color: theme.colors.statusSuccess },
  toneNegative: { color: theme.colors.statusDanger },
  toneWarning: { color: theme.colors.statusWarning },
  frameSides: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderColor: theme.colors.borderAccent,
    borderLeftWidth: 1,
    borderRightWidth: 1,
  },
  openRow: { paddingTop: theme.spacing[2] },
  frameTop: {
    flexDirection: "row",
    borderColor: theme.colors.borderAccent,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderTopLeftRadius: theme.borderRadius.md,
    borderTopRightRadius: theme.borderRadius.md,
  },
  groupLabel: {
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[1.5],
    borderTopLeftRadius: theme.borderRadius.md,
    borderBottomRightRadius: theme.borderRadius.md,
    flexShrink: 1,
  },
  closeRow: { paddingBottom: theme.spacing[2] },
  frameBottom: {
    height: 6,
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomLeftRadius: theme.borderRadius.md,
    borderBottomRightRadius: theme.borderRadius.md,
  },
  noteRow: { paddingVertical: theme.spacing[1] },
  note: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  noteText: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
}));
