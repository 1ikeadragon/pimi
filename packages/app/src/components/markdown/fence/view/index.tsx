import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ChartNode, ChatView } from "@pimi/protocol/chat-view";
import { ChartView } from "./chart";
import { ViewNodeView } from "./registry";

/** The title an agent has written so far, read from a block that is not yet complete JSON. */
function pendingTitle(source: string): string | null {
  const match = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(source);
  if (!match) return null;
  try {
    const title: unknown = JSON.parse(match[1]);
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : null;
  } catch {
    // An escape the agent has only half written; the title appears with the next token.
    return null;
  }
}

function PendingView({ source }: { source: string }) {
  const { t } = useTranslation();
  const title = pendingTitle(source);
  return (
    <View style={styles.card} testID="chat-view-pending">
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <Text style={styles.caption}>{t("message.visualization.drawing")}</Text>
    </View>
  );
}

/**
 * A block that ended without a valid view. The agent's data stays one click away, so nothing is
 * lost, but a broken block reads as a note rather than a wall of JSON in the reply.
 */
function FailedView({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const title = pendingTitle(source);
  return (
    <View style={styles.card} testID="chat-view-failed">
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <View style={styles.failedRow}>
        <Text style={styles.caption}>Couldn’t draw this chart.</Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={open ? ChevronDown : ChevronRight}
          onPress={toggle}
          testID="chat-view-failed-toggle"
        >
          {open ? "Hide data" : "Show data"}
        </Button>
      </View>
      {open ? (
        <ScrollView horizontal style={styles.source}>
          <Text selectable style={styles.sourceText}>
            {source}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** A chart on its own, outside a chat view. */
export function ChartCard({ chart }: { chart: ChartNode }) {
  return (
    <View style={styles.card}>
      <ChartView chart={chart} />
    </View>
  );
}

/**
 * A `pimi-chart` or `pimi-view` block. `view` is null while the block is still streaming and
 * not yet valid, and for a block that ended invalid, which `failed` marks.
 */
export function ViewFence({
  view,
  source,
  failed = false,
}: {
  view: ChatView | null;
  source: string;
  /** The block is complete and still not a valid view. */
  failed?: boolean;
}) {
  if (!view) return failed ? <FailedView source={source} /> : <PendingView source={source} />;
  return (
    <View style={styles.card} testID="chat-view">
      {view.title ? (
        <Text accessibilityRole="header" style={styles.title}>
          {view.title}
        </Text>
      ) : null}
      <ViewNodeView node={view.root} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  failedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  source: {
    maxHeight: 240,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  sourceText: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
}));
