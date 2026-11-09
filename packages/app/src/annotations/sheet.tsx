import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { ANNOTATION_CHARACTER_LIMIT, annotationSourceLabel, type AnnotationCapture } from "./model";

const HEADER = { title: "Annotation" };

export function AnnotationSheet({
  capture,
  initialNote = "",
  canSave = true,
  onSave,
  onClose,
}: {
  capture: AnnotationCapture;
  initialNote?: string;
  canSave?: boolean;
  onSave?: (note: string) => Promise<void> | void;
  onClose(): void;
}) {
  const [note, setNote] = useState(initialNote);
  const quoteTooLong = capture.quote.length > ANNOTATION_CHARACTER_LIMIT;
  const noteTooLong = note.length > ANNOTATION_CHARACTER_LIMIT;
  let limitError: string | null = null;
  if (quoteTooLong)
    limitError = `Select at most ${ANNOTATION_CHARACTER_LIMIT.toLocaleString()} characters to annotate.`;
  else if (noteTooLong)
    limitError = `Shorten your note to ${ANNOTATION_CHARACTER_LIMIT.toLocaleString()} characters or fewer.`;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async () => {
    if (!onSave || !canSave || saving || !note.trim() || limitError) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(note);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the annotation. Try again.");
    } finally {
      setSaving(false);
    }
  }, [canSave, limitError, note, onClose, onSave, saving]);
  const handleSave = useCallback(() => void save(), [save]);
  const handleClose = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);
  const canSubmit = !saving && canSave && Boolean(note.trim()) && !limitError;
  const footer = useMemo(
    () =>
      onSave ? (
        <View style={styles.actions}>
          <Button variant="secondary" onPress={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onPress={handleSave}
            disabled={!canSubmit}
            accessibilityLabel="Add annotation to chat"
          >
            {saving ? "Adding…" : "Add to chat"}
          </Button>
        </View>
      ) : undefined,
    [onSave, onClose, saving, handleSave, canSubmit],
  );
  return (
    <AdaptiveModalSheet
      visible
      testID="annotation-sheet"
      header={HEADER}
      onClose={handleClose}
      footer={footer}
    >
      <View style={styles.body}>
        <Text selectable style={styles.source}>
          {annotationSourceLabel(capture.source)}
        </Text>
        <Text style={styles.label}>Selected text</Text>
        <Text selectable style={styles.quote} testID="annotation-quote">
          {quoteTooLong ? "Selection exceeds the annotation size limit." : capture.quote}
        </Text>
        <Text style={styles.label}>Your note</Text>
        {onSave ? (
          <FormTextInput
            autoFocus
            multiline
            accessibilityLabel="Annotation note"
            placeholder="What would you like to point out?"
            initialValue={note}
            onChangeText={setNote}
            style={styles.input}
          />
        ) : (
          <Text selectable style={styles.note}>
            {note}
          </Text>
        )}
        {onSave ? (
          <Text style={styles.source}>Adds to the composer. Send when you’re ready.</Text>
        ) : null}
        {!canSave && onSave ? (
          <Text accessibilityRole="alert" style={styles.error}>
            The target chat is no longer available.
          </Text>
        ) : null}
        {limitError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {limitError}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3] },
  source: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  quote: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  note: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  input: { minHeight: 100, textAlignVertical: "top" },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
