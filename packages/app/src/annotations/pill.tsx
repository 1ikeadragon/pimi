import { withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useCallback, useState } from "react";
import { MessageSquare } from "lucide-react-native";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { AnnotationSheet } from "./sheet";
import { annotationSourceLabel, type AnnotationAttachment } from "./model";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const iconAppearance = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const annotationIcon = <ThemedMessageSquare size={ICON_SIZE.sm} uniProps={iconAppearance} />;

export function AnnotationPill({
  attachment,
  disabled,
  index,
  onRemove,
}: {
  attachment: AnnotationAttachment;
  disabled: boolean;
  index: number;
  onRemove(index: number): void;
}) {
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <>
      <AttachmentPill
        testID="composer-annotation-pill"
        disabled={disabled}
        onOpen={handleOpen}
        onRemove={handleRemove}
        openAccessibilityLabel="Open annotation"
        removeAccessibilityLabel="Remove annotation"
      >
        <AttachmentLabel
          icon={annotationIcon}
          title={attachment.note}
          subtitle={annotationSourceLabel(attachment.source)}
        />
      </AttachmentPill>
      {open ? (
        <AnnotationSheet capture={attachment} initialNote={attachment.note} onClose={handleClose} />
      ) : null}
    </>
  );
}
