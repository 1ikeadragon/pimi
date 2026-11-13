import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AttachmentPill } from "@/components/attachment-pill";
import { PressHighlight } from "@/components/ui/press-highlight";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useSettings } from "@/hooks/use-settings";
import { circledNumeral } from "@/composer/chips/model";
import { AnnotationChip } from "./chip";
import {
  openAnnotationAtSource,
  type AnnotationEditorOutcome,
  type AnnotationEditSession,
} from "./edit-session";
import { goToAnnotationSource } from "./go-to-source";
import { AnnotationHoverContent } from "./hover-content";
import { annotationAccessibilityLabel, type AnnotationAttachment } from "./model";
import { AnnotationChipEditor } from "./chip-editor";
import { AnnotationSheet } from "./sheet";

/** Where the note is being edited: at the annotated text, beside the chip, or in a sheet. */
type Editing = "closed" | "source" | "popover" | "sheet";

interface AnnotationChipHostProps {
  annotation: AnnotationAttachment;
  /** `inline` is a chip in the composer's text; `tray` is a pill in the attachment tray. */
  placement: "inline" | "tray";
  disabled: boolean;
  onRemove(): void;
  onChangeNote(id: string, note: string): void;
  onFocusComposer(): void;
  /** Whether the chip is inside a text selection or holds keyboard focus in the editor. */
  selected?: boolean;
  focused?: boolean;
}

/**
 * An annotation chip with everything that happens around it: the card on hover, going to the
 * source, and the note editor (anchored beside the chip, at the source, or in a sheet).
 */
export function AnnotationChipHost({
  annotation,
  placement,
  disabled,
  onRemove,
  onChangeNote,
  onFocusComposer,
  selected = false,
  focused = false,
}: AnnotationChipHostProps) {
  const { t } = useTranslation();
  const usesSheet = useIsCompactFormFactor() || isNative;
  const anchor = useRef<View>(null);
  const [editing, setEditing] = useState<Editing>("closed");
  const [hovered, setHovered] = useState(false);
  const saveNote = useCallback(
    (note: string) => onChangeNote(annotation.id, note),
    [annotation.id, onChangeNote],
  );
  const closeSheet = useCallback(() => setEditing("closed"), []);
  const session = useMemo<AnnotationEditSession>(
    () => ({
      attachment: annotation,
      isNew: false,
      saveNote,
      remove: onRemove,
      onClosed(outcome: AnnotationEditorOutcome) {
        setEditing("closed");
        if (outcome !== "dismissed") onFocusComposer();
      },
    }),
    [annotation, saveNote, onRemove, onFocusComposer],
  );
  const handleEdit = useCallback(() => {
    if (usesSheet) setEditing("sheet");
    else setEditing(openAnnotationAtSource(session) ? "source" : "popover");
  }, [usesSheet, session]);
  const toast = useToast();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  // The source is now on screen, so the card showing it closes until the pointer comes back.
  const [revealed, setRevealed] = useState(false);
  const goToSource = useCallback(() => {
    const reached = goToAnnotationSource(annotation, {
      preferences: openInSidePane,
      onNotice: (message) => toast.show(message, { variant: "warning" }),
    });
    if (reached) setRevealed(true);
    return reached;
  }, [annotation, openInSidePane, toast]);
  // Wide layouts go to the source; a chat that is not open, and the sheet layouts, edit the note.
  const handleOpen = useCallback(() => {
    if (!usesSheet && goToSource()) return;
    handleEdit();
  }, [usesSheet, goToSource, handleEdit]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => {
    setHovered(false);
    setRevealed(false);
  }, []);
  const hoverActions = useMemo(
    () => ({
      ...(annotation.source.kind === "browser"
        ? {}
        : {
            onGoToSource: () => {
              if (!goToSource()) handleEdit();
            },
          }),
      onEditNote: handleEdit,
      onRemove,
    }),
    [annotation.source.kind, goToSource, handleEdit, onRemove],
  );
  const label = annotationAccessibilityLabel(annotation, t);
  const chip = (
    <AnnotationChip
      annotation={annotation}
      size={placement === "inline" ? "inline" : "tray"}
      badge={placement === "tray" ? circledNumeral(annotation.slot) : undefined}
      selected={selected || hovered}
      focused={focused}
    />
  );

  return (
    <>
      <HoverCard disabled={usesSheet || disabled || revealed || editing !== "closed"}>
        <HoverCardTrigger>
          <View
            ref={anchor}
            collapsable={false}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          >
            {placement === "tray" ? (
              <AttachmentPill
                testID="composer-annotation-pill"
                disabled={disabled}
                onOpen={handleOpen}
                onRemove={onRemove}
                openAccessibilityLabel={label}
                removeAccessibilityLabel={t("chips.removeAnnotation")}
                hovered={hovered}
              >
                {chip}
              </AttachmentPill>
            ) : (
              <PressHighlight
                onPress={handleOpen}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={styles.inlinePress}
              >
                {chip}
              </PressHighlight>
            )}
          </View>
        </HoverCardTrigger>
        <HoverCardContent placement="top" alignment="start" testID="annotation-hover-card">
          <AnnotationHoverContent annotation={annotation} actions={hoverActions} />
        </HoverCardContent>
      </HoverCard>
      {editing === "popover" ? <AnnotationChipEditor session={session} chip={anchor} /> : null}
      {editing === "sheet" ? (
        <AnnotationSheet attachment={annotation} onSave={saveNote} onClose={closeSheet} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  inlinePress: { alignSelf: "flex-start" },
}));
