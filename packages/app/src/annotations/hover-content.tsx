import { Text, View } from "react-native";
import { ArrowUpRight, Pencil, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { annotationSourceLabel, type AnnotationAttachment } from "./model";

const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Each action is offered only when the surface can do it: a sent message has no note to edit. */
export interface AnnotationHoverActions {
  /** Absent for a source there is nowhere to go back to, such as a browser element. */
  onGoToSource?: () => void;
  onEditNote?: () => void;
  onRemove?: () => void;
}

/** What the card shows when the pointer rests on an annotation chip. */
export function AnnotationHoverContent({
  annotation,
  actions,
}: {
  annotation: Pick<AnnotationAttachment, "source" | "quote" | "note">;
  actions: AnnotationHoverActions;
}) {
  const { t } = useTranslation();
  const note = annotation.note.trim();
  const goToLabel = annotation.source.kind === "file" ? t("chips.goToCode") : t("chips.goToText");
  return (
    <View style={styles.card}>
      <Text numberOfLines={1} style={styles.source}>
        {annotationSourceLabel(annotation.source, t)}
      </Text>
      <Text numberOfLines={8} style={styles.quote}>
        {annotation.quote}
      </Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <View style={styles.footer}>
        {actions.onGoToSource ? (
          <ToolbarButton label={goToLabel} onPress={actions.onGoToSource} tooltipSide="top">
            <ThemedArrowUpRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </ToolbarButton>
        ) : null}
        {actions.onEditNote ? (
          <ToolbarButton label={t("chips.editNote")} onPress={actions.onEditNote} tooltipSide="top">
            <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </ToolbarButton>
        ) : null}
        {actions.onRemove ? (
          <ToolbarButton
            label={t("chips.removeAnnotation")}
            onPress={actions.onRemove}
            tooltipSide="top"
          >
            <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </ToolbarButton>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: 320,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  source: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
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
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
}));
