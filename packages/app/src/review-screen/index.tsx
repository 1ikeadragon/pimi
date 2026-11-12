// Pimi. Apache-2.0.
// Review screen shell. Owns layout, the shared selection, and desk/inspector focus plumbing; every
// pane is a slot owned by one stream (see the file header of each slot). Add behaviour in the slot,
// not here.
import { useCallback, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { closePimiReview, openPimiReview } from "@/navigation/pimi-review";
import { ReviewFixSheet } from "./agent-actions/fix-sheet";
import { ReviewDesk } from "./desk";
import { ReviewHeader } from "./header";
import { ReviewInbox } from "./inbox";
import { ReviewInspector } from "./inspector";
import {
  EMPTY_REVIEW_SELECTION,
  type ReviewInspectorTab,
  type ReviewJumpTo,
  type ReviewSelection,
  type ReviewSource,
} from "./types";

type CompactPane = "files" | ReviewInspectorTab;

const COMPACT_PANES: SegmentedControlOption<CompactPane>[] = [
  { value: "files", label: "Files" },
  { value: "threads", label: "Threads" },
  { value: "checks", label: "Checks" },
  { value: "about", label: "About" },
];

const PIMI_BACKGROUND = { "pimi-background": "" };

export function ReviewScreen({
  source,
  inboxServerId,
}: {
  /** The open review, or null for the inbox page. */
  source: ReviewSource | null;
  /** Daemon the inbox reads through when no review is open. */
  inboxServerId: string | null;
}) {
  return (
    <View style={styles.screen} dataSet={PIMI_BACKGROUND} testID="pimi-review">
      <MenuHeader title="Review" />
      {source ? <ReviewDeskLayout key={JSON.stringify(source)} source={source} /> : null}
      {!source && inboxServerId ? (
        <ReviewInbox serverId={inboxServerId} onOpen={openPimiReview} />
      ) : null}
    </View>
  );
}

function ReviewDeskLayout({ source }: { source: ReviewSource }) {
  const isCompact = useIsCompactFormFactor();
  const [tab, setTab] = useState<ReviewInspectorTab>("threads");
  const [compactPane, setCompactPane] = useState<CompactPane>("files");
  const [selection, setSelection] = useState<ReviewSelection>(EMPTY_REVIEW_SELECTION);
  const [focus, setFocus] = useState<{ path: string; line: number | null; nonce: number } | null>(
    null,
  );
  const [fixOpen, setFixOpen] = useState(false);
  const closeFixSheet = useCallback(() => setFixOpen(false), []);
  const onPaneChange = useCallback((next: CompactPane) => {
    setCompactPane(next);
    if (next !== "files") setTab(next);
  }, []);

  const onJumpTo = useCallback<ReviewJumpTo>((path, line) => {
    setFocus((current) => ({ path, line, nonce: (current?.nonce ?? 0) + 1 }));
    setCompactPane("files");
  }, []);

  const desk = (
    <ReviewDesk
      source={source}
      focus={focus}
      selection={selection}
      onSelectionChange={setSelection}
    />
  );
  const inspector = (
    <ReviewInspector
      source={source}
      tab={tab}
      onTabChange={setTab}
      onJumpTo={onJumpTo}
      selection={selection}
      onSelectionChange={setSelection}
    />
  );

  return (
    <View style={styles.body}>
      <ReviewHeader source={source} onBack={closePimiReview} />
      {isCompact ? (
        <>
          <View style={styles.segmented}>
            <SegmentedControl
              options={COMPACT_PANES}
              value={compactPane}
              onValueChange={onPaneChange}
            />
          </View>
          <View style={styles.pane}>{compactPane === "files" ? desk : inspector}</View>
        </>
      ) : (
        <View style={styles.columns}>
          <View style={styles.desk}>{desk}</View>
          <View style={styles.inspector}>{inspector}</View>
        </View>
      )}
      <ReviewFixSheet
        source={source}
        selection={selection}
        visible={fixOpen}
        onClose={closeFixSheet}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface0 },
  body: { flex: 1, minWidth: 0 },
  columns: { flex: 1, flexDirection: "row", minHeight: 0 },
  desk: { flex: 1, minWidth: 0 },
  inspector: {
    width: 360,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  segmented: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[2] },
  pane: { flex: 1, minHeight: 0 },
}));
