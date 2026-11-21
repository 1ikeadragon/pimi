// Pimi. PolyForm-Noncommercial-1.0.0.
// "Review changes": the summary, the review type and the pending line comments leave as one
// review. Pending comments are the local drafts of this pull request; the same drafts feed "Ask in
// chat". Submitting is never optimistic: the sheet stays up, fields locked, until the forge
// answers, and a failure leaves everything as typed.
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useReviewDraftComments, useReviewDraftStore } from "@/review/store";
import { refreshAfterWrite } from "../queries";
import type { ReviewJumpTo } from "../types";
import { reviewDraftKeyFor } from "../desk/use-review-markers";
import { useDraftValidation } from "./validate-drafts";
import {
  newMutationId,
  useReviewWriteContext,
  type ReviewWriteContextValue,
  type WriteFailure,
} from "./use-review-writes";

type ReviewEvent = "comment" | "approve" | "request_changes";
const EVENT_ORDER: ReviewEvent[] = ["comment", "approve", "request_changes"];
/** GitHub's per-review limit; the daemon enforces the same. */
const MAX_COMMENTS = 100;
const SUBMIT_MIN_WIDTH = 132;
const EVENT_LABEL_KEYS = {
  comment: "reviewScreen.write.eventComment",
  approve: "reviewScreen.write.eventApprove",
  request_changes: "reviewScreen.write.eventRequestChanges",
} as const;

/** Number of pending line comments of the pull request on screen. */
export function usePendingCommentCount(write: ReviewWriteContextValue | null): number {
  const key = write ? reviewDraftKeyFor(write.ref) : "";
  return useReviewDraftComments(key).length;
}

/** The forge accepts a review for this pull request: it has review events and is open. */
export function canReview(write: ReviewWriteContextValue | null): write is ReviewWriteContextValue {
  return Boolean(
    write && write.actions && write.actions.reviewEvents.length > 0 && write.state === "open",
  );
}

export function ReviewChangesButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const write = useReviewWriteContext();
  const count = usePendingCommentCount(write);
  if (!canReview(write)) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={!write.connected}
      onPress={onPress}
      testID="review-changes-button"
    >
      {count > 0
        ? t("reviewScreen.write.reviewChangesCount", { count })
        : t("reviewScreen.write.reviewChanges")}
    </Button>
  );
}

export function ReviewChangesSheet({
  visible,
  onClose,
  onGoTo,
}: {
  visible: boolean;
  onClose: () => void;
  onGoTo: ReviewJumpTo;
}) {
  const write = useReviewWriteContext();
  if (!visible || !canReview(write)) return null;
  return <OpenReviewChangesSheet write={write} onClose={onClose} onGoTo={onGoTo} />;
}

function OpenReviewChangesSheet({
  write,
  onClose,
  onGoTo,
}: {
  write: ReviewWriteContextValue;
  onClose: () => void;
  onGoTo: ReviewJumpTo;
}) {
  const { t } = useTranslation();
  const form = useReviewForm(write, onClose);
  const { drafts, submitting } = form;
  const noop = useCallback(() => {}, []);
  const header = useMemo(() => ({ title: t("reviewScreen.write.sheetTitle") }), [t]);
  const footer = useMemo(
    () => (
      <SheetFooter
        failure={form.failure}
        submitting={submitting}
        canSubmit={form.canSubmit}
        onSubmit={form.submit}
        onCancel={onClose}
        onReload={form.reload}
      />
    ),
    [form.canSubmit, form.failure, form.reload, form.submit, onClose, submitting],
  );
  const goTo = useCallback(
    (path: string, line: number) => {
      onClose();
      onGoTo(path, line);
    },
    [onClose, onGoTo],
  );
  // Cmd/Ctrl+Enter submits from the summary, as it does in every comment box.
  const { submit } = form;
  const onSummaryKeyPress = useCallback(
    (
      event: NativeSyntheticEvent<
        TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean }
      >,
    ) => {
      const { key, metaKey, ctrlKey } = event.nativeEvent;
      if (key === "Enter" && (metaKey || ctrlKey)) void submit();
    },
    [submit],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={submitting ? noop : onClose}
      footer={footer}
      desktopMaxWidth={520}
      testID="review-sheet"
    >
      <View style={styles.body}>
        <FormTextInput
          multiline
          editable={!submitting}
          accessibilityLabel={t("reviewScreen.write.summaryPlaceholder")}
          placeholder={t("reviewScreen.write.summaryPlaceholder")}
          initialValue=""
          onChangeText={form.setSummary}
          onKeyPress={onSummaryKeyPress}
          style={styles.summary}
          testID="review-sheet-summary"
        />
        <View role="radiogroup" accessibilityLabel={t("reviewScreen.write.eventsLabel")}>
          {form.events.map((value) => (
            <EventRow
              key={value}
              value={value}
              selected={form.event === value}
              disabledReason={
                value !== "comment" && write.viewerIsAuthor
                  ? t("reviewScreen.write.ownPullRequest")
                  : null
              }
              locked={submitting}
              onSelect={form.setEvent}
            />
          ))}
        </View>
        <Text style={styles.muted} testID="review-sheet-count">
          {drafts.length > 0
            ? t("reviewScreen.write.pending", { count: drafts.length })
            : t("reviewScreen.write.pendingNone")}
        </Text>
        <DraftNotes
          form={form}
          maxComments={MAX_COMMENTS}
          onGoTo={goTo}
          onRemove={form.removeDraft}
        />
        {write.headSha ? (
          <Text style={styles.sha}>
            {t("reviewScreen.write.reviewing", { sha: write.headSha.slice(0, 7) })}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function useReviewForm(write: ReviewWriteContextValue, onClose: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const draftKey = reviewDraftKeyFor(write.ref);
  const drafts = useReviewDraftComments(draftKey);
  const events = useMemo(
    () => EVENT_ORDER.filter((value) => write.actions?.reviewEvents.includes(value)),
    [write.actions?.reviewEvents],
  );
  const [event, setEvent] = useState<ReviewEvent>(events[0] ?? "comment");
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const attempt = useRef<{ signature: string; mutationId: string } | null>(null);
  const validation = useDraftValidation(write.ref, write.headSha, drafts, true);

  const trimmed = summary.trim();
  const tooMany = drafts.length > MAX_COMMENTS;
  const needsContent = event !== "approve" && !trimmed && drafts.length === 0;
  const valid =
    Boolean(write.headSha) &&
    validation.ready &&
    validation.mismatched.length === 0 &&
    !tooMany &&
    !needsContent;
  const canSubmit = valid && !submitting && write.connected;

  const submit = useCallback(async () => {
    if (!canSubmit || !write.headSha) return;
    const comments = drafts.map((draft) => ({
      path: draft.filePath,
      side: draft.side,
      line: draft.lineNumber,
      body: draft.body,
    }));
    const signature = JSON.stringify([write.headSha, event, trimmed, comments]);
    // The same review retried after a failure is the same mutation; any edit is a new one.
    const mutationId =
      attempt.current?.signature === signature ? attempt.current.mutationId : newMutationId();
    attempt.current = { signature, mutationId };
    setSubmitting(true);
    setFailure(null);
    const result = await write.writes.submitReview({
      mutationId,
      headSha: write.headSha,
      event,
      body: trimmed,
      comments,
    });
    setSubmitting(false);
    if (!result.ok) {
      setFailure(result.failure);
      if (isNative) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      }
      return;
    }
    const store = useReviewDraftStore.getState();
    for (const draft of drafts) store.deleteComment({ key: draftKey, id: draft.id });
    if (isNative) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    toast.show(t("reviewScreen.write.submitted"));
    onClose();
  }, [canSubmit, draftKey, drafts, event, onClose, t, toast, trimmed, write]);

  const reload = useCallback(() => {
    setFailure(null);
    void refreshAfterWrite(queryClient, write.ref, ["overview", "files", "timeline", "status"]);
  }, [queryClient, write.ref]);
  const removeDraft = useCallback(
    (id: string) => useReviewDraftStore.getState().deleteComment({ key: draftKey, id }),
    [draftKey],
  );

  return {
    drafts,
    events,
    event,
    setEvent,
    setSummary,
    submitting,
    failure,
    validation,
    tooMany,
    needsContent,
    canSubmit,
    submit,
    reload,
    removeDraft,
  };
}

type ReviewForm = ReturnType<typeof useReviewForm>;

function DraftNotes({
  form,
  maxComments,
  onGoTo,
  onRemove,
}: {
  form: ReviewForm;
  maxComments: number;
  onGoTo: (path: string, line: number) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { drafts, validation, submitting } = form;
  return (
    <>
      {form.needsContent ? (
        <Text style={styles.muted}>{t("reviewScreen.write.needsContent")}</Text>
      ) : null}
      {form.tooMany ? (
        <Text style={styles.error}>{`${drafts.length} / ${maxComments}`}</Text>
      ) : null}
      {drafts.length > 0 && !validation.ready ? (
        <Text style={styles.muted}>{t("reviewScreen.write.checking")}</Text>
      ) : null}
      {validation.mismatched.length > 0 ? (
        <View style={styles.mismatch} testID="review-sheet-mismatch">
          <Text style={styles.error}>
            {t("reviewScreen.write.mismatch", { count: validation.mismatched.length })}
          </Text>
          {validation.mismatched.map((draft) => (
            <MismatchRow
              key={draft.id}
              draft={draft}
              onGoTo={onGoTo}
              onRemove={onRemove}
              locked={submitting}
            />
          ))}
        </View>
      ) : null}
    </>
  );
}

function SheetFooter({
  failure,
  submitting,
  canSubmit,
  onSubmit,
  onCancel,
  onReload,
}: {
  failure: WriteFailure | null;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const stale = failure?.code === "stale_snapshot";
  return (
    <View style={styles.footer}>
      {failure ? (
        <View style={styles.errorRow}>
          <Text style={styles.error} testID="review-sheet-error">
            {stale
              ? t("reviewScreen.write.staleHead")
              : failure.message || t("reviewScreen.write.submitFailed")}
          </Text>
          {stale ? (
            <Button size="sm" variant="ghost" onPress={onReload} testID="review-sheet-reload">
              {t("reviewScreen.write.reload")}
            </Button>
          ) : null}
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="ghost"
          onPress={onCancel}
          disabled={submitting}
          testID="review-sheet-cancel"
        >
          {t("reviewScreen.write.cancel")}
        </Button>
        <Button
          variant="default"
          disabled={!canSubmit}
          onPress={onSubmit}
          style={styles.submit}
          testID="review-sheet-submit"
        >
          {submitting ? t("reviewScreen.write.submitting") : t("reviewScreen.write.submit")}
        </Button>
      </View>
    </View>
  );
}

function EventRow({
  value,
  selected,
  disabledReason,
  locked,
  onSelect,
}: {
  value: ReviewEvent;
  selected: boolean;
  disabledReason: string | null;
  locked: boolean;
  onSelect: (event: ReviewEvent) => void;
}) {
  const { t } = useTranslation();
  const label = t(EVENT_LABEL_KEYS[value]);
  const disabled = locked || disabledReason !== null;
  const state = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <PressHighlight
      onPress={press}
      disabled={disabled}
      role="radio"
      accessibilityState={state}
      accessibilityLabel={label}
      style={[styles.eventRow, disabled && styles.dimmed]}
      testID={`review-sheet-event-${value}`}
    >
      <View style={[styles.radio, selected && styles.radioOn]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={styles.eventText}>
        <Text style={styles.eventLabel}>{label}</Text>
        {disabledReason ? <Text style={styles.muted}>{disabledReason}</Text> : null}
      </View>
    </PressHighlight>
  );
}

function MismatchRow({
  draft,
  onGoTo,
  onRemove,
  locked,
}: {
  draft: { id: string; filePath: string; lineNumber: number };
  onGoTo: (path: string, line: number) => void;
  onRemove: (id: string) => void;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const goTo = useCallback(() => onGoTo(draft.filePath, draft.lineNumber), [draft, onGoTo]);
  const remove = useCallback(() => onRemove(draft.id), [draft.id, onRemove]);
  return (
    <View style={styles.mismatchRow}>
      <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
        {`${draft.filePath}:${draft.lineNumber}`}
      </Text>
      <Button size="sm" variant="ghost" onPress={goTo} disabled={locked}>
        {t("reviewScreen.write.goTo")}
      </Button>
      <Button size="sm" variant="ghost" onPress={remove} disabled={locked}>
        {t("reviewScreen.write.remove")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[2] },
  summary: { minHeight: 96, textAlignVertical: "top" },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  sha: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  eventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  dimmed: { opacity: 0.5 },
  eventText: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
  eventLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  radio: {
    width: 16,
    height: 16,
    marginTop: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { borderColor: theme.colors.accent },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  mismatch: { gap: theme.spacing[1] },
  mismatchRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  path: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  footer: { flex: 1, gap: theme.spacing[2] },
  errorRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  // Both labels fit, so "Submitting..." does not resize the button.
  submit: { minWidth: SUBMIT_MIN_WIDTH },
}));
