import { router } from "expo-router";
import type { Task } from "@pimi/protocol/task/types";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

// A created chat appears in the create-flow store within seconds of the first message; a draft
// that is never sent must not leave a subscription behind.
const LINK_WATCH_TIMEOUT_MS = 30 * 60 * 1000;

/** The chat's opening message: the task's title, then its description when it has one. */
export function buildTaskChatPrompt(task: Pick<Task, "title" | "description">): string {
  const description = task.description.trim();
  return description ? `${task.title}\n\n${description}` : task.title;
}

/**
 * Opens New chat with the task as the first message and links the chat to the task once the
 * agent exists. The link is made by watching the create flow for this draft, because the screen
 * that creates the agent is not this one.
 */
export function startTaskChat(input: {
  serverId: string;
  task: Pick<Task, "title" | "description">;
  link: (agentId: string) => Promise<unknown>;
}): void {
  const draftId = generateDraftId();
  useDraftStore.getState().saveDraftInput({
    draftKey: buildNewWorkspaceDraftKey(draftId),
    draft: { text: buildTaskChatPrompt(input.task), attachments: [] },
  });

  let settled = false;
  const finish = (unsubscribe: () => void, timer: ReturnType<typeof setTimeout>) => {
    settled = true;
    unsubscribe();
    clearTimeout(timer);
  };
  const unsubscribe: () => void = useCreateFlowStore.subscribe((state) => {
    const pending = state.pendingByDraftId[draftId];
    if (settled || !pending) return;
    if (pending.lifecycle === "abandoned") {
      finish(unsubscribe, timer);
      return;
    }
    if (pending.agentId) {
      finish(unsubscribe, timer);
      void input.link(pending.agentId).catch(() => undefined);
    }
  });
  const timer = setTimeout(() => finish(unsubscribe, timer), LINK_WATCH_TIMEOUT_MS);

  router.push(buildNewWorkspaceRoute({ serverId: input.serverId, draftId }));
}
