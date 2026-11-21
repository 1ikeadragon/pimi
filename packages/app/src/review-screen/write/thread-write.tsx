// Pimi. PolyForm-Noncommercial-1.0.0.
// What a reader can do to one review thread: reply and resolve. Shared by the Conversation tab's
// thread card and the Files tab's thread panel and sheet.
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useToast } from "@/contexts/toast-context";
import { ReviewComposer } from "./composer";
import { isPendingTimelineId, useReviewWriteContext } from "./use-review-writes";

/** The forge's own id of a timeline thread entry (`thread:<id>`). */
export function rawThreadId(entryId: string): string {
  return entryId.startsWith("thread:") ? entryId.slice("thread:".length) : entryId;
}

export function ThreadReply({ entryId }: { entryId: string }) {
  const { t } = useTranslation();
  const write = useReviewWriteContext();
  const threadId = rawThreadId(entryId);
  const [open, setOpen] = useState(false);
  const expand = useCallback(() => setOpen(true), []);
  const collapse = useCallback(() => setOpen(false), []);
  const onSubmit = useCallback(
    async (body: string, mutationId: string) => {
      if (!write) throw new Error("no write context");
      const result = await write.writes.reply({ threadId, body, mutationId });
      // A failed reply keeps the box open: its text came back and the error sits under it.
      if (result.ok) setOpen(false);
      return result;
    },
    [threadId, write],
  );
  if (!write || !write.actions?.reply || isPendingTimelineId(threadId)) return null;
  const disabled = !write.connected;
  return (
    <View style={styles.reply}>
      {open ? (
        <ReviewComposer
          autoFocus
          placeholder={t("reviewScreen.write.replyPlaceholder")}
          submitLabel={t("reviewScreen.write.reply")}
          disabled={disabled}
          onSubmit={onSubmit}
          onCancel={collapse}
          testID={`review-reply-${threadId}`}
        />
      ) : (
        <PressHighlight
          onPress={expand}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t("reviewScreen.write.reply")}
          style={styles.collapsed}
          testID={`review-reply-open-${threadId}`}
        >
          <Text style={styles.collapsedText}>{t("reviewScreen.write.replyPlaceholder")}</Text>
        </PressHighlight>
      )}
    </View>
  );
}

export function ResolveButton({
  entryId,
  resolved,
  onToggle,
}: {
  entryId: string;
  resolved: boolean;
  /** Called as the press lands, so a card can stay open instead of folding under the pointer. */
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const write = useReviewWriteContext();
  const threadId = rawThreadId(entryId);
  const setResolved = write?.writes.setResolved;
  const press = useCallback(async () => {
    if (!setResolved) return;
    onToggle?.();
    const next = !resolved;
    const result = await setResolved({ threadId, resolved: next });
    if (!result.ok) {
      toast.error(
        t(next ? "reviewScreen.write.resolveFailed" : "reviewScreen.write.unresolveFailed", {
          message: result.failure.message,
        }),
      );
    }
  }, [onToggle, resolved, setResolved, t, threadId, toast]);
  if (!write || !write.actions?.resolve || isPendingTimelineId(threadId)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!write.connected}
      onPress={press}
      style={styles.resolve}
      testID={`review-resolve-${threadId}`}
    >
      {t(resolved ? "reviewScreen.write.unresolve" : "reviewScreen.write.resolve")}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  reply: {
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  collapsed: {
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  collapsedText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  // Both labels fit, so swapping them does not move what is beside the button.
  resolve: { minWidth: 168 },
}));
