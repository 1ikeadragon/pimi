// Pimi. PolyForm-Noncommercial-1.0.0.
// Small presentational pieces of the Files tab.
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useDeskCopy } from "./copy";
import type { ReviewMarkers } from "./use-review-markers";

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

function reasonLabel(
  reason: ReviewMarkers["detached"][number]["reason"],
  copy: ReturnType<typeof useDeskCopy>,
): string {
  return reason === "no_line" ? copy.detachedNoLine : copy.detachedOutside;
}

/** Threads the document cannot draw under a line, listed under the toolbar. */
export function DetachedThreads({
  detached,
  onOpen,
}: {
  detached: ReviewMarkers["detached"];
  onOpen: (path: string, threadId: string) => void;
}) {
  const copy = useDeskCopy();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  if (detached.length === 0) return null;
  return (
    <View style={styles.detached} testID="review-desk-detached">
      <PressHighlight onPress={toggle} accessibilityRole="button" style={styles.detachedHeader}>
        <Text style={styles.detachedTitle}>{copy.detached(detached.length)}</Text>
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
  const copy = useDeskCopy();
  const handlePress = useCallback(() => onOpen(thread.path, thread.id), [onOpen, thread]);
  return (
    <PressHighlight
      onPress={handlePress}
      style={styles.detachedRow}
      testID={`review-desk-detached-${thread.id}`}
    >
      <Text style={styles.detachedText} numberOfLines={1}>
        {`${thread.path} · ${reasonLabel(reason, copy)} · ${thread.author}: ${thread.body}`}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
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
