import { useCallback, useMemo } from "react";
import { MessageSquare } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { AnnotationAttachmentMetadata } from "@pimi/protocol/messages";
import { AttachmentFrame, AttachmentLabel } from "@/components/attachment-pill";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useSettings } from "@/hooks/use-settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { goToSentAnnotationSource } from "./go-to-source";
import { annotationSourceLabel, annotationTitle, type AnnotationAttachment } from "./model";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const iconAppearance = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const annotationIcon = <ThemedMessageSquare size={ICON_SIZE.sm} uniProps={iconAppearance} />;

/**
 * An annotation in a sent message. On web it goes back to the quoted file or chat text; sheet
 * layouts show it as a label only.
 */
export function SentAnnotationPill({ annotation }: { annotation: AnnotationAttachmentMetadata }) {
  const goesToSource = !useIsCompactFormFactor() && !isNative;
  const toast = useToast();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  // The sent message has no draft id; the reveal only reads the source, quote and selector.
  const attachment = useMemo<AnnotationAttachment>(
    () => ({ kind: "annotation", id: "sent", ...annotation }),
    [annotation],
  );
  const handlePress = useCallback(
    () =>
      goToSentAnnotationSource(attachment, {
        preferences: openInSidePane,
        onNotice: (message) => toast.show(message, { variant: "warning" }),
      }),
    [attachment, openInSidePane, toast],
  );
  return (
    <AttachmentFrame
      testID="sent-annotation-pill"
      onPress={goesToSource ? handlePress : undefined}
      accessibilityLabel={
        attachment.source.kind === "file" ? "Go to annotated code" : "Go to annotated text"
      }
    >
      <AttachmentLabel
        icon={annotationIcon}
        title={annotationTitle(attachment)}
        subtitle={annotationSourceLabel(attachment.source)}
      />
    </AttachmentFrame>
  );
}
