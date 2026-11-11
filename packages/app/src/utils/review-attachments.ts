import type { AgentAttachment, ForgeSearchItem } from "@pimi/protocol/messages";

export function buildForgeAttachmentFromSearchItem(
  item: ForgeSearchItem | null,
): AgentAttachment | null {
  if (!item) {
    return null;
  }

  if (item.kind === "change_request") {
    return {
      type: "forge_change_request",
      mimeType: "application/paseo-forge-change-request",
      forge: item.forge ?? "github",
      number: item.number,
      title: item.title,
      url: item.url,
      ...(item.body ? { body: item.body } : {}),
      ...(item.projectPath ? { projectPath: item.projectPath } : {}),
      ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
      ...(item.headRefName ? { headRefName: item.headRefName } : {}),
    };
  }

  return {
    type: "forge_issue",
    mimeType: "application/paseo-forge-issue",
    forge: item.forge ?? "github",
    number: item.number,
    title: item.title,
    url: item.url,
    ...(item.body ? { body: item.body } : {}),
    ...(item.projectPath ? { projectPath: item.projectPath } : {}),
  };
}
