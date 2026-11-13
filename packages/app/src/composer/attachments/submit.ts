import { annotationToAgentAttachment } from "@/annotations/model";
import { annotationsOf, serializeChipText } from "@/composer/chips/model";
import type { ComposerAttachment } from "@/attachments/types";
import type { ImageAttachment } from "@/composer/types";
import {
  isWorkspaceAttachment,
  workspaceAttachmentToSubmitAttachment,
} from "@/attachments/workspace-attachment-utils";
import type { AgentAttachment } from "@pimi/protocol/messages";
import { buildForgeAttachmentFromSearchItem } from "@/utils/review-attachments";
import { workspaceFileAttachmentToAgentAttachment } from "@/attachments/workspace-file";
import { pluginResourceAttachmentToAgentAttachment } from "@/plugins/attachments";

export interface ComposerSubmission {
  /** The text as the agent receives it: chips are `[annotation N]` markers. */
  text: string;
  images: ImageAttachment[];
  attachments: AgentAttachment[];
}

/**
 * The one place the composer's model (text holding chip characters, annotations as attachments)
 * becomes what goes on the wire. Annotations come first, in chip order, so `[annotation N]` in the
 * text and the `Annotation N` bodies agree; every other attachment follows in draft order.
 */
export function prepareComposerSubmission(input: {
  text: string;
  attachments: ComposerAttachment[];
}): ComposerSubmission {
  const serialized = serializeChipText(input.text, annotationsOf(input.attachments));
  const images: ImageAttachment[] = [];
  const agentAttachments: AgentAttachment[] = serialized.annotations.map((annotation, index) =>
    annotationToAgentAttachment(annotation, index + 1),
  );

  for (const attachment of input.attachments) {
    if (attachment.kind === "annotation") continue;

    if (attachment.kind === "image") {
      images.push(attachment.metadata);
      continue;
    }

    if (attachment.kind === "file") {
      agentAttachments.push(attachment.attachment);
      continue;
    }

    if (attachment.kind === "workspace_file") {
      agentAttachments.push(workspaceFileAttachmentToAgentAttachment(attachment));
      continue;
    }

    if (attachment.kind === "plugin_resource") {
      agentAttachments.push(pluginResourceAttachmentToAgentAttachment(attachment));
      continue;
    }

    if (isWorkspaceAttachment(attachment)) {
      let screenshotIndex: number | undefined;
      if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
        screenshotIndex = images.length;
        images.push(attachment.attachment.screenshot);
      }
      const workspaceAttachment = workspaceAttachmentToSubmitAttachment(attachment);
      if (workspaceAttachment) {
        agentAttachments.push(
          screenshotIndex !== undefined &&
            workspaceAttachment.type === "text" &&
            workspaceAttachment.browserElement
            ? {
                ...workspaceAttachment,
                browserElement: { ...workspaceAttachment.browserElement, screenshotIndex },
              }
            : workspaceAttachment,
        );
      }
      continue;
    }

    const reviewAttachment = buildForgeAttachmentFromSearchItem(attachment.item);
    if (reviewAttachment) {
      agentAttachments.push(reviewAttachment);
    }
  }

  return {
    text: serialized.text,
    images,
    attachments: agentAttachments,
  };
}
