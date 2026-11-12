import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy, FileDiff, GitCommitHorizontal } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutBlameResult } from "@pimi/protocol/messages";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useToast } from "@/contexts/toast-context";
import { usePaneContext } from "@/panels/pane-context";
import { formatTimeAgo } from "@/utils/time";

type Committed = Extract<CheckoutBlameResult, { status: "committed" }>;

export interface BlameActions {
  /** The blamed commit's change to this file, scrolled to the blamed line. */
  openChanges: () => void;
  /** Every file of the blamed commit. */
  openCommit: () => void;
  /** The working-tree diff of this file, for lines no commit owns yet. */
  openWorkingDiff: () => void;
  copySha: () => void;
}

export function useBlameActions(path: string, result: CheckoutBlameResult | null): BlameActions {
  const { openPreferredTarget } = usePaneContext();
  const toast = useToast();
  const lastRequest = useRef(0);
  // A repeated request must differ, or the diff would not scroll again to the same line.
  const nextRequestId = useCallback(() => {
    lastRequest.current = Math.max(Date.now(), lastRequest.current + 1);
    return lastRequest.current;
  }, []);
  const committed = result?.status === "committed" ? result : null;
  const sha = committed?.sha;
  const commitPath = committed?.path;
  const originalLine = committed?.originalLine;
  const openChanges = useCallback(() => {
    if (!sha) return;
    openPreferredTarget(
      {
        kind: "commit_diff",
        sha,
        path: commitPath,
        focusLine: originalLine,
        focusRequestId: nextRequestId(),
      },
      "diffs",
    );
  }, [commitPath, nextRequestId, openPreferredTarget, originalLine, sha]);
  const openCommit = useCallback(() => {
    if (sha)
      openPreferredTarget({ kind: "commit_diff", sha, focusRequestId: nextRequestId() }, "diffs");
  }, [nextRequestId, openPreferredTarget, sha]);
  const openWorkingDiff = useCallback(
    () =>
      openPreferredTarget(
        { kind: "working_diff", focusPath: path, focusRequestId: nextRequestId() },
        "diffs",
      ),
    [nextRequestId, openPreferredTarget, path],
  );
  const copySha = useCallback(() => {
    if (!sha) return;
    Clipboard.setStringAsync(sha).then(
      () => toast.copied("Commit SHA"),
      () => toast.error("Could not copy the commit SHA"),
    );
  }, [sha, toast]);
  return { openChanges, openCommit, openWorkingDiff, copySha };
}

/** The label is the click target (open the change) and the hover card's trigger (the details). */
export function BlameLabel({
  label,
  result,
  actions,
}: {
  label: string;
  result: CheckoutBlameResult | null;
  actions: BlameActions;
}) {
  // Remounting the card closes it; a press on the card leaves the pointer over it otherwise.
  const [cardKey, setCardKey] = useState(0);
  const cardActions = useMemo<BlameActions>(() => {
    const close = (run: () => void) => () => {
      setCardKey((value) => value + 1);
      run();
    };
    return {
      openChanges: close(actions.openChanges),
      openCommit: close(actions.openCommit),
      openWorkingDiff: close(actions.openWorkingDiff),
      copySha: close(actions.copySha),
    };
  }, [actions]);
  const onPress = pressHandler(result, cardActions);
  const text = (
    <Text style={styles.text} numberOfLines={1}>
      {label}
    </Text>
  );
  if (!onPress) {
    return (
      <Text style={styles.text} numberOfLines={1} accessibilityLabel={label}>
        {label}
      </Text>
    );
  }
  const hint =
    status === "committed"
      ? "Opens this commit's change to the file"
      : "Opens the working-tree diff";
  const button = (
    <PressHighlight
      style={styles.label}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      testID="file-editor-blame-label"
    >
      {text}
    </PressHighlight>
  );
  if (result?.status !== "committed") return button;
  return (
    <HoverCard key={cardKey}>
      <HoverCardTrigger>{button}</HoverCardTrigger>
      <HoverCardContent
        placement="top"
        alignment="start"
        offset={6}
        role="dialog"
        accessibilityLabel="Commit details"
        testID="file-editor-blame-card"
        style={styles.card}
      >
        <BlameCard commit={result} actions={cardActions} />
      </HoverCardContent>
    </HoverCard>
  );
}

function pressHandler(result: CheckoutBlameResult | null, actions: BlameActions) {
  if (result?.status === "committed") return actions.openChanges;
  if (result?.status === "uncommitted" || result?.status === "untracked") {
    return actions.openWorkingDiff;
  }
  return undefined;
}

function BlameCard({ commit, actions }: { commit: Committed; actions: BlameActions }) {
  const authoredAt = new Date(commit.authoredAt);
  return (
    <View style={styles.cardBody}>
      <View style={styles.cardHeader}>
        <Text style={styles.author} numberOfLines={1}>
          {commit.author}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {formatTimeAgo(authoredAt)} · {authoredAt.toLocaleString()}
        </Text>
      </View>
      <ScrollView style={styles.message}>
        <Text style={styles.messageText} selectable>
          {commit.message}
        </Text>
      </ScrollView>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Copy}
        style={styles.sha}
        onPress={actions.copySha}
        accessibilityLabel={`Copy commit SHA ${commit.sha.slice(0, 8)}`}
        testID="file-editor-blame-sha"
      >
        {commit.sha.slice(0, 8)}
      </Button>
      <View style={styles.actions}>
        <Button size="sm" variant="outline" leftIcon={FileDiff} onPress={actions.openChanges}>
          Open changes
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={GitCommitHorizontal}
          onPress={actions.openCommit}
        >
          Open commit
        </Button>
        <Button size="sm" variant="ghost" leftIcon={Copy} onPress={actions.copySha}>
          Copy SHA
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: { flexShrink: 1, minWidth: 0, cursor: "pointer" },
  text: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  card: { width: 460, maxWidth: "92%" },
  cardBody: { padding: theme.spacing[3], gap: theme.spacing[2] },
  cardHeader: { gap: 2 },
  author: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "600" },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  message: { maxHeight: 140 },
  messageText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, lineHeight: 18 },
  sha: { alignSelf: "flex-start" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
}));
