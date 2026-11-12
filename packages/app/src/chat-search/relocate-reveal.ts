import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { ChatReveal } from "./chat-reveal-store";

const ATTEMPTS = 8;
const RETRY_MS = 600;

/**
 * The seq of a search hit's entry in the timeline now being viewed, when the chat was rebuilt
 * after the hit was found. The rebuilt timeline is indexed a moment after it opens, so the
 * search is retried. Null when the entry cannot be found under `epoch`.
 */
export async function relocateReveal(input: {
  serverId: string;
  agentId: string;
  reveal: ChatReveal;
  epoch: string;
}): Promise<number | null> {
  const client = getHostRuntimeStore().getClient(input.serverId);
  if (!client) return null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const response = await client.searchChats({
      query: input.reveal.query,
      scope: { agentId: input.agentId },
      limit: 50,
    });
    const current = response.hits.filter((hit) => hit.epoch === input.epoch);
    const match = current.find((hit) => hit.snippet.text === input.reveal.snippet);
    if (match) return match.seq;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  return null;
}
