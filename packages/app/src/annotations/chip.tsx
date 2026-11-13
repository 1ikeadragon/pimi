import { FileCode, Quote } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { InlineChip } from "@/components/ui/chip/inline-chip";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { annotationChipLabel, type AnnotationAttachment } from "./model";

const ThemedFileCode = withUnistyles(FileCode);
const ThemedQuote = withUnistyles(Quote);
const accentIconMapping = (theme: Theme) => ({ color: theme.colors.accentBright });

const fileIcon = <ThemedFileCode size={ICON_SIZE.xs} uniProps={accentIconMapping} />;
const quoteIcon = <ThemedQuote size={ICON_SIZE.xs} uniProps={accentIconMapping} />;

/** An annotation drawn as a chip: where it came from, with a dot when it has a note. */
export function AnnotationChip({
  annotation,
  size,
  selected,
  focused,
}: {
  annotation: Pick<AnnotationAttachment, "source" | "note" | "quote">;
  size: "inline" | "tray";
  selected?: boolean;
  focused?: boolean;
}) {
  return (
    <InlineChip
      icon={annotation.source.kind === "file" ? fileIcon : quoteIcon}
      label={annotationChipLabel(annotation)}
      hasNote={annotation.note.trim().length > 0}
      size={size}
      selected={selected}
      focused={focused}
      testID="annotation-chip"
    />
  );
}
