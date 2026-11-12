import { useEffect, useState } from "react";
import { chatRevealKey, useChatRevealStore, type ChatReveal } from "./chat-reveal-store";
import { relocateReveal } from "./relocate-reveal";

/** A search hit that opened this chat and has not been scrolled to yet. */
export function useChatRevealRequest(serverId: string, agentId: string) {
  const key = chatRevealKey(serverId, agentId);
  const pending: ChatReveal | undefined = useChatRevealStore((state) => state.pending[key]);
  // The jump keeps loading windows after the request is consumed, so tracking stays on.
  const [seen, setSeen] = useState(false);
  if (pending !== undefined && !seen) setSeen(true);
  return { key, pending, tracking: seen || pending !== undefined };
}

/** Scrolls to the entry of a pending reveal once the viewed timeline's epoch is known. */
export function useChatRevealJump(input: {
  serverId: string;
  agentId: string;
  request: { key: string; pending: ChatReveal | undefined };
  timelineEpoch: string | null;
  jumpToSeq: (seq: number) => void;
}) {
  const { serverId, agentId, request, timelineEpoch, jumpToSeq } = input;
  const clear = useChatRevealStore((state) => state.clear);
  const pending = request.pending;
  useEffect(() => {
    if (!pending || timelineEpoch === null) return;
    clear(request.key);
    if (pending.epoch === timelineEpoch) {
      jumpToSeq(pending.seq);
      return;
    }
    // The chat was rebuilt since the search, so the hit's seq means something else now. Find the
    // same entry in the rebuilt timeline; without it the chat stays at the tail.
    void relocateReveal({ serverId, agentId, reveal: pending, epoch: timelineEpoch })
      .then((seq) => (seq === null ? undefined : jumpToSeq(seq)))
      .catch(() => undefined);
  }, [agentId, clear, jumpToSeq, pending, request.key, serverId, timelineEpoch]);
}
