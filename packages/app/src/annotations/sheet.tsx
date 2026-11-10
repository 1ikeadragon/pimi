import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { annotationNoteError, annotationSourceLabel, type AnnotationAttachment } from "./model";

const HEADER = { title: "Annotation" };

/** The note editor for compact and touch layouts, opened from the annotation's pill. */
export function AnnotationSheet({
  attachment,
  onSave,
  onClose,
}: {
  attachment: AnnotationAttachment;
  onSave(note: string): void;
  onClose(): void;
}) {
  const [note, setNote] = useState(attachment.note);
  const error = annotationNoteError(note);
  const save = useCallback(() => {
    if (annotationNoteError(note)) return;
    onSave(note.trim());
    onClose();
  }, [note, onClose, onSave]);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" onPress={onClose} testID="annotation-cancel">
          Cancel
        </Button>
        <Button variant="default" onPress={save} disabled={Boolean(error)} testID="annotation-save">
          Save
        </Button>
      </View>
    ),
    [onClose, save, error],
  );
  return (
    <AdaptiveModalSheet
      visible
      testID="annotation-sheet"
      header={HEADER}
      onClose={onClose}
      footer={footer}
    >
      <View style={styles.body}>
        <Text selectable style={styles.source}>
          {annotationSourceLabel(attachment.source)}
        </Text>
        <Text selectable style={styles.quote} testID="annotation-quote">
          {attachment.quote}
        </Text>
        <FormTextInput
          autoFocus
          multiline
          accessibilityLabel="Note"
          placeholder="Add a note (optional)"
          initialValue={note}
          onChangeText={setNote}
          style={styles.input}
          testID="annotation-note-input"
        />
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
  quote: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  input: { minHeight: 100, textAlignVertical: "top" },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
