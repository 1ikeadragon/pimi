import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AnnotationAttachmentMetadata } from "@pimi/protocol/messages";
import { AttachmentFrame } from "@/components/attachment-pill";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useSettings } from "@/hooks/use-settings";
import { AnnotationChip } from "./chip";
import { goToSentAnnotationSource } from "./go-to-source";
import { AnnotationHoverContent } from "./hover-content";
import { annotationAccessibilityLabel } from "./model";

/**
 * An annotation in a sent message. On web it goes back to the quoted file or chat text; sheet
 * layouts show it as a label only.
 */
export function SentAnnotationPill({ annotation }: { annotation: AnnotationAttachmentMetadata }) {
  const { t } = useTranslation();
  const goesToSource = !useIsCompactFormFactor() && !isNative;
  const toast = useToast();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const goToSource = useCallback(
    () =>
      goToSentAnnotationSource(annotation, {
        preferences: openInSidePane,
        onNotice: (message) => toast.show(message, { variant: "warning" }),
      }),
    [annotation, openInSidePane, toast],
  );
  const actions = useMemo(() => ({ onGoToSource: goToSource }), [goToSource]);
  return (
    <HoverCard disabled={!goesToSource}>
      <HoverCardTrigger>
        <AttachmentFrame
          testID="sent-annotation-pill"
          onPress={goesToSource ? goToSource : undefined}
          accessibilityLabel={annotationAccessibilityLabel(annotation, t)}
        >
          <AnnotationChip annotation={annotation} size="tray" />
        </AttachmentFrame>
      </HoverCardTrigger>
      <HoverCardContent placement="top" alignment="start">
        <AnnotationHoverContent annotation={annotation} actions={actions} />
      </HoverCardContent>
    </HoverCard>
  );
}
