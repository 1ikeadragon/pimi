import { useCallback, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import type { AgentAttachment } from "@pimi/protocol/messages";
import { getAgentAttachmentPillContent } from "@/attachments/attachment-pill-content";
import type { AttachmentMetadata } from "@/attachments/types";
import { BrowserElementPreview } from "@/composer/attachments/browser-element-preview";
import { AttachmentFrame, AttachmentLabel } from "@/components/attachment-pill";

type BrowserElementTextAttachment = Extract<AgentAttachment, { type: "text" }> & {
  browserElement: NonNullable<Extract<AgentAttachment, { type: "text" }>["browserElement"]>;
};

/** A browser element in a sent message: its note on the pill, the screenshot in the preview. */
export function SentBrowserElementPill({
  attachment,
  screenshot,
}: {
  attachment: BrowserElementTextAttachment;
  screenshot: AttachmentMetadata | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const content = getAgentAttachmentPillContent(attachment, t);
  const { browserElement } = attachment;
  return (
    <>
      <AttachmentFrame
        testID="sent-browser-element-pill"
        onPress={handleOpen}
        accessibilityLabel={t("composer.attachments.openBrowserElement")}
      >
        <AttachmentLabel icon={content.icon} title={content.title} />
      </AttachmentFrame>
      {open ? (
        <BrowserElementPreview
          tag={browserElement.tag}
          url={browserElement.url}
          comment={browserElement.comment}
          text={attachment.text}
          screenshot={screenshot}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}

export function isBrowserElementAttachment(
  attachment: AgentAttachment,
): attachment is BrowserElementTextAttachment {
  return attachment.type === "text" && attachment.browserElement !== undefined;
}
