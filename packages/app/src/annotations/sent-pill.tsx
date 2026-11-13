import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnnotationAttachmentMetadata } from "@pimi/protocol/messages";
import type { AttachmentMetadata } from "@/attachments/types";
import { BrowserElementPreview } from "@/composer/attachments/browser-element-preview";
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

/** Resolves a message's screenshot by its index among the message's images. */
export const SentScreenshotContext = createContext<(index: number) => AttachmentMetadata | null>(
  () => null,
);

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
  const screenshotFor = useContext(SentScreenshotContext);
  const isElement = annotation.source.kind === "browser";
  const handlePress = useCallback(() => {
    if (goesToSource && !isElement) goToSource();
    else setReading(true);
  }, [goesToSource, goToSource, isElement]);
  const actions = useMemo(
    () => (isElement ? {} : { onGoToSource: goToSource }),
    [goToSource, isElement],
  );
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
      {reading && annotation.source.kind === "browser" ? (
        <BrowserElementPreview
          tag={annotation.source.tag}
          url={annotation.source.url}
          comment={annotation.note.trim() || undefined}
          text={annotation.quote}
          screenshot={
            annotation.screenshotIndex === undefined
              ? null
              : screenshotFor(annotation.screenshotIndex)
          }
          onClose={closeSheet}
        />
      ) : null}
      {reading && annotation.source.kind !== "browser" ? (
        <AnnotationReadSheet annotation={annotation} onClose={closeSheet} />
      ) : null}
    </>
  );
}
