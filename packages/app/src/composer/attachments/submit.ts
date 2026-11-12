import { annotationToAgentAttachment } from "@/annotations/model";
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

export function splitComposerAttachmentsForSubmit(attachments: ComposerAttachment[]): {
  images: ImageAttachment[];
  attachments: AgentAttachment[];
} {
  const images: ImageAttachment[] = [];
  const agentAttachments: AgentAttachment[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "annotation") {
      agentAttachments.push(annotationToAgentAttachment(attachment));
      continue;
    }

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
    images,
    attachments: agentAttachments,
  };
}
