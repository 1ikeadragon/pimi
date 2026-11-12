// Pimi. Apache-2.0.
// Small presentational pieces of the Changes tab.
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { DESK_COPY } from "./copy";
import type { ReviewMarkers } from "./use-review-markers";

export function Notice({
  text,
  busy,
  onRetry,
}: {
  text: string;
  busy?: boolean;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.notice} testID="review-desk-notice">
      {busy ? <ActivityIndicator /> : null}
      <Text style={styles.noticeText}>{text}</Text>
      {onRetry ? (
        <Button size="sm" variant="outline" onPress={onRetry}>
          {DESK_COPY.retry}
        </Button>
      ) : null}
    </View>
  );
}

export function Chip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Button
      size="sm"
      variant={active ? "secondary" : "ghost"}
      accessibilityState={accessibilityState}
      onPress={onToggle}
    >
      {label}
    </Button>
  );
}

function reasonLabel(reason: ReviewMarkers["detached"][number]["reason"]): string {
  if (reason === "no_line") return DESK_COPY.detachedNoLine;
  if (reason === "outside_diff") return DESK_COPY.detachedOutside;
  return DESK_COPY.detachedHidden;
}

/** Threads the document cannot draw under a line, listed under the toolbar. */
export function DetachedThreads({
  detached,
  onOpen,
}: {
  detached: ReviewMarkers["detached"];
  onOpen: (path: string, threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  if (detached.length === 0) return null;
  return (
    <View style={styles.detached} testID="review-desk-detached">
      <PressHighlight onPress={toggle} accessibilityRole="button" style={styles.detachedHeader}>
        <Text style={styles.detachedTitle}>{DESK_COPY.detached(detached.length)}</Text>
      </PressHighlight>
      {open
        ? detached.map(({ thread, reason }) => (
            <DetachedRow key={thread.id} thread={thread} reason={reason} onOpen={onOpen} />
          ))
        : null}
    </View>
  );
}

function DetachedRow({
  thread,
  reason,
  onOpen,
}: {
  thread: ReviewMarkers["detached"][number]["thread"];
  reason: ReviewMarkers["detached"][number]["reason"];
  onOpen: (path: string, threadId: string) => void;
}) {
  const handlePress = useCallback(() => onOpen(thread.path, thread.id), [onOpen, thread]);
  return (
    <PressHighlight
      onPress={handlePress}
      style={styles.detachedRow}
      testID={`review-desk-detached-${thread.id}`}
    >
      <Text style={styles.detachedText} numberOfLines={1}>
        {`${thread.path} · ${reasonLabel(reason)} · ${thread.author}: ${thread.body}`}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  noticeText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  detached: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  detachedHeader: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[1.5] },
  detachedTitle: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  detachedRow: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[1] },
  detachedText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
