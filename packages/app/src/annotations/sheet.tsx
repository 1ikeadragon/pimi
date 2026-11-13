import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { annotationNoteError, annotationSourceLabel, type AnnotationAttachment } from "./model";

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
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("chips.sheetTitle") }), [t]);
  const [note, setNote] = useState(attachment.note);
  const error = annotationNoteError(note, t);
  const save = useCallback(() => {
    if (annotationNoteError(note, t)) return;
    onSave(note.trim());
    onClose();
  }, [note, onClose, onSave, t]);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" onPress={onClose} testID="annotation-cancel">
          {t("common.actions.cancel")}
        </Button>
        <Button variant="default" onPress={save} disabled={Boolean(error)} testID="annotation-save">
          {t("common.actions.save")}
        </Button>
      </View>
    ),
    [onClose, save, error, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      testID="annotation-sheet"
      header={header}
      onClose={onClose}
      footer={footer}
    >
      <View style={styles.body}>
        <Text selectable style={styles.source}>
          {annotationSourceLabel(attachment.source, t)}
        </Text>
        <Text selectable style={styles.quote} testID="annotation-quote">
          {attachment.quote}
        </Text>
        <FormTextInput
          autoFocus
          multiline
          accessibilityLabel={t("chips.noteLabel")}
          placeholder={t("chips.notePlaceholder")}
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

/** A sent annotation on a compact or touch layout: its source, quote and note, to read. */
export function AnnotationReadSheet({
  annotation,
  onClose,
}: {
  annotation: Pick<AnnotationAttachment, "source" | "quote" | "note">;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("chips.sheetTitle") }), [t]);
  const note = annotation.note.trim();
  return (
    <AdaptiveModalSheet visible testID="annotation-read-sheet" header={header} onClose={onClose}>
      <View style={styles.body}>
        <Text selectable style={styles.source}>
          {annotationSourceLabel(annotation.source, t)}
        </Text>
        <Text selectable style={styles.quote}>
          {annotation.quote}
        </Text>
        {note ? (
          <Text selectable style={styles.note}>
            {note}
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
  note: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
