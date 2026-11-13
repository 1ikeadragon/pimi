import { FileCode, MousePointerClick, Quote } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { InlineChip } from "@/components/ui/chip/inline-chip";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { annotationChipLabel, type AnnotationAttachment } from "./model";

const ThemedFileCode = withUnistyles(FileCode);
const ThemedQuote = withUnistyles(Quote);
const ThemedPointer = withUnistyles(MousePointerClick);
const accentIconMapping = (theme: Theme) => ({ color: theme.colors.accentBright });

const fileIcon = <ThemedFileCode size={ICON_SIZE.xs} uniProps={accentIconMapping} />;
const elementIcon = <ThemedPointer size={ICON_SIZE.xs} uniProps={accentIconMapping} />;
const quoteIcon = <ThemedQuote size={ICON_SIZE.xs} uniProps={accentIconMapping} />;

const ICON_BY_SOURCE = { file: fileIcon, chat: quoteIcon, browser: elementIcon } as const;

/** An annotation drawn as a chip: where it came from, with a dot when it has a note. */
export function AnnotationChip({
  annotation,
  size,
  badge,
  selected,
  focused,
}: {
  annotation: Pick<AnnotationAttachment, "source" | "note" | "quote">;
  size: "inline" | "tray";
  badge?: string;
  selected?: boolean;
  focused?: boolean;
}) {
  return (
    <InlineChip
      icon={ICON_BY_SOURCE[annotation.source.kind]}
      label={annotationChipLabel(annotation)}
      hasNote={annotation.note.trim().length > 0}
      size={size}
      badge={badge}
      selected={selected}
      focused={focused}
      testID="annotation-chip"
    />
  );
}
