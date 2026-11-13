import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { ChartNode, ChatView } from "@pimi/protocol/chat-view";
import { OpenInTabButton, useOpenChatVisualInTab } from "../open-in-tab";
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

/** The frame every chat visual sits in, with its heading above the content. */
export function VisualCard({
  title,
  subtitle,
  testID,
  onOpenInTab,
  children,
}: {
  title?: string | null;
  subtitle?: string | null;
  testID: string;
  /** Shown as "Open in tab" beside the heading when the chat can open tabs. */
  onOpenInTab?: () => void;
  children: ReactNode;
}) {
  const heading = title ? (
    <Text accessibilityRole="header" style={styles.title}>
      {title}
    </Text>
  ) : null;
  return (
    <View style={styles.card} testID={testID}>
      {onOpenInTab ? (
        <View style={styles.header}>
          <View style={styles.heading}>{heading}</View>
          <OpenInTabButton onPress={onOpenInTab} />
        </View>
      ) : (
        heading
      )}
      {subtitle ? <Text style={styles.caption}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

/** Shown while a visual is still arriving or still being drawn. */
export function PendingCaption() {
  const { t } = useTranslation();
  return <Text style={styles.caption}>{t("message.visualization.drawing")}</Text>;
}

export function PendingView({ source }: { source: string }) {
  return (
    <VisualCard title={pendingTitle(source)} testID="chat-view-pending">
      <PendingCaption />
    </VisualCard>
  );
}

/**
 * A block that ended without a valid view. The agent's data stays one click away, so nothing is
 * lost, but a broken block reads as a note rather than a wall of JSON in the reply.
 */
export function FailedView({
  source,
  message = "Couldn’t draw this chart.",
  showLabel = "Show data",
  hideLabel = "Hide data",
}: {
  source: string;
  message?: string;
  showLabel?: string;
  hideLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <VisualCard title={pendingTitle(source)} testID="chat-view-failed">
      <View style={styles.failedRow}>
        <Text style={styles.caption}>{message}</Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={open ? ChevronDown : ChevronRight}
          onPress={toggle}
          testID="chat-view-failed-toggle"
        >
          {open ? hideLabel : showLabel}
        </Button>
      </View>
      {open ? (
        <ScrollView horizontal style={styles.source}>
          <Text selectable style={styles.sourceText}>
            {source}
          </Text>
        </ScrollView>
      ) : null}
    </VisualCard>
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

const VIEW_TAB_TITLE = "Visual";

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
  const visual = useMemo(() => (view ? { kind: "view" as const, view } : null), [view]);
  const openInTab = useOpenChatVisualInTab(visual, view?.title ?? VIEW_TAB_TITLE);
  if (!view) return failed ? <FailedView source={source} /> : <PendingView source={source} />;
  return (
    <VisualCard title={view.title} testID="chat-view" onOpenInTab={openInTab}>
      <ViewNodeView node={view.root} />
    </VisualCard>
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // The ghost button's own padding would push the heading down; let it overhang the card's.
    marginVertical: -theme.spacing[1],
    marginRight: -theme.spacing[2],
  },
  heading: { flex: 1, minWidth: 0 },
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
