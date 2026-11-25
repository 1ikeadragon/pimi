// Pimi. PolyForm-Noncommercial-1.0.0.
// A forge thread opened from its marker or the detached strip: where it is, every comment in full.
// Docked at 380 beside the diff while the Files tab is wide enough; below that (and on compact) it
// is a modal sheet. Reply and resolve sit under the comments.
import { useCallback, useEffect, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { ToastApiProvider, useToast } from "@/contexts/toast-api-context";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge } from "@/components/ui/status-badge";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { requestReviewFix } from "../agent-actions/fix-request";
import { ThreadComments } from "../conversation/thread-card";
import { ReviewWriteContext, useReviewWriteContext } from "../write/use-review-writes";
import { ResolveButton, ThreadReply } from "../write/thread-write";
import type { ForgeThread } from "./use-desk-data";

export const THREAD_PANEL_WIDTH = 380;
/** Files width at which the panel docks; narrower, it is a sheet. */
export const THREAD_PANEL_DOCK_MIN_WIDTH = 1100;

const ThemedClose = withUnistyles(X);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function locationOf(thread: ForgeThread): string {
  return thread.line ? `${thread.path}:${thread.line}` : thread.path;
}

/** Esc closes the panel, on web, unless the user is typing. */
export function useCloseOnEscape(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active || !isWeb) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);
}

function ThreadBody({ thread }: { thread: ForgeThread }) {
  const { t } = useTranslation();
  const fix = useCallback(
    () => requestReviewFix({ threadIds: [thread.entry.id], checkKeys: [] }),
    [thread.entry.id],
  );
  return (
    <>
      <ThreadComments entry={thread.entry} />
      <ThreadReply entryId={thread.entry.id} />
      <View style={styles.actions}>
        <ResolveButton entryId={thread.entry.id} resolved={thread.isResolved} />
        <Button size="sm" variant="outline" onPress={fix} testID="review-thread-panel-fix">
          {t("reviewScreen.conversation.fixThis")}
        </Button>
      </View>
    </>
  );
}

/** The docked panel. The sheet form is `ThreadSheet`. */
export function ThreadPanel({ thread, onClose }: { thread: ForgeThread; onClose: () => void }) {
  const { t } = useTranslation();
  useCloseOnEscape(true, onClose);
  return (
    <View style={styles.panel} testID="review-thread-panel">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.location} numberOfLines={1} ellipsizeMode="head">
            {locationOf(thread)}
          </Text>
          <View style={styles.badges}>
            {thread.isResolved ? (
              <StatusBadge
                size="xs"
                variant="success"
                label={t("reviewScreen.conversation.resolved")}
              />
            ) : null}
            {thread.isOutdated ? (
              <StatusBadge
                size="xs"
                variant="warning"
                label={t("reviewScreen.conversation.outdated")}
              />
            ) : null}
          </View>
        </View>
        <ToolbarButton
          label={t("common.actions.close")}
          onPress={onClose}
          testID="review-thread-panel-close"
        >
          <ThemedClose size={14} uniProps={mutedMapping} />
        </ToolbarButton>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <ThreadBody thread={thread} />
      </ScrollView>
    </View>
  );
}

export function ThreadSheet({ thread, onClose }: { thread: ForgeThread; onClose: () => void }) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({
      title: locationOf(thread),
      subtitle: (
        <View style={styles.badges}>
          {thread.isResolved ? (
            <StatusBadge
              size="xs"
              variant="success"
              label={t("reviewScreen.conversation.resolved")}
            />
          ) : null}
          {thread.isOutdated ? (
            <StatusBadge
              size="xs"
              variant="warning"
              label={t("reviewScreen.conversation.outdated")}
            />
          ) : null}
        </View>
      ),
    }),
    [t, thread],
  );
  useCloseOnEscape(true, onClose);
  // The compact sheet renders in its own portal, where the page's contexts do not reach.
  const write = useReviewWriteContext();
  const toast = useToast();
  const contextBridge = useCallback<ContextBridge>(
    (content) => (
      <ToastApiProvider api={toast}>
        <ReviewWriteContext.Provider value={write}>{content}</ReviewWriteContext.Provider>
      </ToastApiProvider>
    ),
    [toast, write],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      contextBridge={contextBridge}
      testID="review-thread-sheet"
    >
      <ThreadBody thread={thread} />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    width: THREAD_PANEL_WIDTH,
    minHeight: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.borderWindow,
    backgroundColor: theme.colors.surfaceChrome,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  location: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  badges: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  scroll: { paddingBottom: theme.spacing[4] },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
}));
