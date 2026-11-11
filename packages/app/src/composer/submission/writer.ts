import type { MessageSubmissionWriter } from "@/composer/actions";
import { useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";

export function createMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  return {
    begin: (agentId, message) =>
      useSessionStore.getState().beginAgentMessageSubmission(serverId, agentId, message),
    accept: (agentId, clientMessageId) =>
      useSessionStore.getState().acceptAgentMessageSubmission(serverId, agentId, clientMessageId),
    reject: (agentId, clientMessageId) =>
      useSessionStore.getState().rejectAgentMessageSubmission(serverId, agentId, clientMessageId),
  };
}

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): boolean {
  return useSessionStore.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}
