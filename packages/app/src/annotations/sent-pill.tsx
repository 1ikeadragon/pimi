import { useCallback, useMemo, useState } from "react";
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
import { AnnotationReadSheet } from "./sheet";

/**
 * An annotation in a sent message, drawn in the text or in the row above it. Wide layouts go back
 * to the quoted file or chat text; sheet layouts open the quote and note to read.
 */
export function SentAnnotationPill({
  annotation,
  size = "tray",
}: {
  annotation: AnnotationAttachmentMetadata;
  size?: "inline" | "tray";
}) {
  const { t } = useTranslation();
  const goesToSource = !useIsCompactFormFactor() && !isNative;
  const toast = useToast();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const [reading, setReading] = useState(false);
  const closeSheet = useCallback(() => setReading(false), []);
  const goToSource = useCallback(
    () =>
      goToSentAnnotationSource(annotation, {
        preferences: openInSidePane,
        onNotice: (message) => toast.show(message, { variant: "warning" }),
      }),
    [annotation, openInSidePane, toast],
  );
  const handlePress = useCallback(() => {
    if (goesToSource) goToSource();
    else setReading(true);
  }, [goesToSource, goToSource]);
  const actions = useMemo(() => ({ onGoToSource: goToSource }), [goToSource]);
  return (
    <>
      <HoverCard disabled={!goesToSource}>
        <HoverCardTrigger>
          <AttachmentFrame
            testID="sent-annotation-pill"
            onPress={handlePress}
            accessibilityLabel={annotationAccessibilityLabel(annotation, t)}
          >
            <AnnotationChip annotation={annotation} size={size} />
          </AttachmentFrame>
        </HoverCardTrigger>
        <HoverCardContent placement="top" alignment="start">
          <AnnotationHoverContent annotation={annotation} actions={actions} />
        </HoverCardContent>
      </HoverCard>
      {reading ? <AnnotationReadSheet annotation={annotation} onClose={closeSheet} /> : null}
    </>
  );
}
