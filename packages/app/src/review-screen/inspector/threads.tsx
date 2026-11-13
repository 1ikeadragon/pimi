// Pimi. Apache-2.0.
// Stream S4: review threads as rows inside a card. Shared by the Overview card and the inspector.
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { PressHighlight } from "@/components/ui/press-highlight";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";
import type { Theme } from "@/styles/theme";
import { requestReviewFix } from "../agent-actions/fix-request";
import type { ReviewJumpTo, ReviewSelection } from "../types";
import type { ReviewThread } from "../use-review-timeline";
import { SelectionBox, toggleInSet } from "./selection-box";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export type ThreadFilter = "unresolved" | "all";

export function filterThreads(threads: readonly ReviewThread[], filter: ThreadFilter) {
  return filter === "all" ? [...threads] : threads.filter((thread) => !thread.isResolved);
}

export function ThreadRows({
  threads,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  threads: readonly ReviewThread[];
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewJumpTo;
}) {
  return (
    <>
      {threads.map((thread, index) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          first={index === 0}
          selection={selection}
          onSelectionChange={onSelectionChange}
          onJumpTo={onJumpTo}
        />
      ))}
    </>
  );
}

function ThreadRow({
  thread,
  first,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  thread: ReviewThread;
  first: boolean;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewJumpTo;
}) {
  const { t } = useTranslation();
  const selected = selection.threads.has(thread.id);
  const onToggleSelected = useCallback(
    () => onSelectionChange({ ...selection, threads: toggleInSet(selection.threads, thread.id) }),
    [onSelectionChange, selection, thread.id],
  );
  const onLinkPress = useCallback((url: string) => void openExternalUrl(url), []);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const fix = useCallback(
    () => requestReviewFix({ threadIds: [thread.id], checkKeys: [] }),
    [thread.id],
  );
  const jump = useCallback(() => {
    if (thread.path) onJumpTo(thread.path, thread.line);
  }, [onJumpTo, thread.line, thread.path]);
  const openOnForge = useCallback(() => void openExternalUrl(thread.url), [thread.url]);
  const location = useMemo(() => {
    if (!thread.path) return t("reviewScreen.inspector.generalDiscussion");
    return `${thread.path}${thread.line ? `:${thread.line}` : ""}`;
  }, [t, thread.line, thread.path]);
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  const extra = thread.entry.comments.length - 1;

  return (
    <View
      style={first ? undefined : settingsStyles.rowBorder}
      testID={`review-thread-${thread.id}`}
    >
      <View style={styles.head}>
        <SelectionBox
          checked={selected}
          onToggle={onToggleSelected}
          label={t("reviewScreen.inspector.selectThread", { location })}
        />
        <PressHighlight style={styles.headMain} onPress={toggle} accessibilityRole="button">
          <View style={styles.titleLine}>
            <Chevron size={14} uniProps={mutedColor} />
            <Text style={styles.summary} numberOfLines={open ? undefined : 2}>
              {thread.summary || t("reviewScreen.inspector.noText")}
            </Text>
          </View>
          <View style={styles.metaLine}>
            <Text style={styles.meta} numberOfLines={1}>
              {thread.author} · {location}
              {extra > 0 ? ` · ${t("reviewScreen.inspector.replies", { count: extra })}` : ""}
            </Text>
            {thread.isResolved ? (
              <StatusBadge
                size="xs"
                variant="success"
                label={t("reviewScreen.inspector.resolved")}
              />
            ) : null}
            {thread.isOutdated ? (
              <StatusBadge
                size="xs"
                variant="warning"
                label={t("reviewScreen.inspector.outdated")}
              />
            ) : null}
          </View>
        </PressHighlight>
      </View>
      {open ? (
        <View style={styles.body}>
          {thread.entry.comments.map((comment) => (
            <View key={comment.id} style={styles.comment}>
              <Text style={styles.meta}>
                {comment.author} · {comment.age}
              </Text>
              <MarkdownRenderer text={comment.body} compact onLinkPress={onLinkPress} />
            </View>
          ))}
          <View style={styles.actions}>
            <Button size="sm" variant="outline" onPress={fix} testID={`review-fix-${thread.id}`}>
              {t("reviewScreen.inspector.fixThis")}
            </Button>
            {thread.path ? (
              <Button size="sm" variant="ghost" onPress={jump}>
                {t(
                  thread.isOutdated || !thread.line
                    ? "reviewScreen.inspector.openFile"
                    : "reviewScreen.inspector.jumpToLine",
                )}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onPress={openOnForge}>
              {t("reviewScreen.overview.openOnForge")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  headMain: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  titleLine: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  summary: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
  },
  meta: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    paddingLeft: theme.spacing[4] + 16 + theme.spacing[3],
  },
  comment: { gap: theme.spacing[1] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
