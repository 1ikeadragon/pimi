import type { WorkspaceDescriptorPayload } from "@pimi/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export interface ChatRow {
  chatId: string;
  project: string;
  name: string;
  isolation: "local" | "worktree";
  cwd: string;
  background: boolean;
}

export const chatSchema: OutputSchema<ChatRow> = {
  idField: "chatId",
  columns: [
    { header: "CHAT ID", field: "chatId", width: 20 },
    { header: "PROJECT", field: "project", width: 20 },
    { header: "NAME", field: "name", width: 22 },
    { header: "ISOLATION", field: "isolation", width: 10 },
    { header: "CWD", field: "cwd", width: 42 },
  ],
};

/** `--background` listings add a column so hidden chats stand out. */
export const chatWithBackgroundSchema: OutputSchema<ChatRow> = {
  ...chatSchema,
  columns: [
    ...chatSchema.columns,
    { header: "BACKGROUND", field: (row) => (row.background ? "yes" : ""), width: 8 },
  ],
};

export function toChatRow(chat: WorkspaceDescriptorPayload): ChatRow {
  return {
    chatId: chat.id,
    project: chat.projectDisplayName,
    name: chat.name,
    isolation: chat.workspaceKind === "worktree" ? "worktree" : "local",
    cwd: chat.workspaceDirectory,
    background: chat.background === true,
  };
}
