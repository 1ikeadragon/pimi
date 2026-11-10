import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { MessageSquare } from "lucide-react-native";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  openAnnotationAtSource,
  type AnnotationEditorOutcome,
  type AnnotationEditSession,
} from "./edit-session";
import { AnnotationPillEditor } from "./pill-editor";
import { AnnotationSheet } from "./sheet";
import { annotationSourceLabel, annotationTitle, type AnnotationAttachment } from "./model";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const iconAppearance = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const annotationIcon = <ThemedMessageSquare size={ICON_SIZE.sm} uniProps={iconAppearance} />;

/** Where the note is being edited: at the annotated text, beside the pill, or in a sheet. */
type Editing = "closed" | "source" | "popover" | "sheet";

export function AnnotationPill({
  attachment,
  disabled,
  index,
  onRemove,
  onChangeNote,
  onFocusComposer,
}: {
  attachment: AnnotationAttachment;
  disabled: boolean;
  index: number;
  onRemove(index: number): void;
  onChangeNote(id: string, note: string): void;
  onFocusComposer(): void;
}) {
  const usesSheet = useIsCompactFormFactor() || isNative;
  const pill = useRef<View>(null);
  const [editing, setEditing] = useState<Editing>("closed");
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const saveNote = useCallback(
    (note: string) => onChangeNote(attachment.id, note),
    [attachment.id, onChangeNote],
  );
  const closeSheet = useCallback(() => setEditing("closed"), []);
  const session = useMemo<AnnotationEditSession>(
    () => ({
      attachment,
      isNew: false,
      saveNote,
      remove: handleRemove,
      onClosed(outcome: AnnotationEditorOutcome) {
        setEditing("closed");
        if (outcome !== "dismissed") onFocusComposer();
      },
    }),
    [attachment, saveNote, handleRemove, onFocusComposer],
  );
  const handleOpen = useCallback(() => {
    if (usesSheet) setEditing("sheet");
    else setEditing(openAnnotationAtSource(session) ? "source" : "popover");
  }, [usesSheet, session]);
  const note = attachment.note.trim();

  return (
    <>
      <HoverCard disabled={usesSheet || disabled || editing !== "closed"}>
        <HoverCardTrigger>
          <View ref={pill} collapsable={false}>
            <AttachmentPill
              testID="composer-annotation-pill"
              disabled={disabled}
              onOpen={handleOpen}
              onRemove={handleRemove}
              openAccessibilityLabel="Edit annotation"
              removeAccessibilityLabel="Remove annotation"
            >
              <AttachmentLabel
                icon={annotationIcon}
                title={annotationTitle(attachment)}
                subtitle={annotationSourceLabel(attachment.source)}
              />
            </AttachmentPill>
          </View>
        </HoverCardTrigger>
        <HoverCardContent
          placement="top"
          alignment="start"
          style={styles.card}
          testID="annotation-hover-card"
        >
          <Text numberOfLines={8} style={styles.quote}>
            {attachment.quote}
          </Text>
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </HoverCardContent>
      </HoverCard>
      {editing === "popover" ? <AnnotationPillEditor session={session} pill={pill} /> : null}
      {editing === "sheet" ? (
        <AnnotationSheet attachment={attachment} onSave={saveNote} onClose={closeSheet} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: 320,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  quote: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  note: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
  },
}));
