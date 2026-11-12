import { create } from "zustand";

/** Where in a chat a search hit points: the timeline epoch and the seq of the matched entry. */
export interface ChatReveal {
  epoch: string;
  seq: number;
  /**
   * What found the hit. Opening a chat can rebuild its timeline from the provider (a chat that ran
   * subagents always does), which gives it a new epoch and new seqs; the entry is then found again
   * by searching this chat for the same text.
   */
  query: string;
  snippet: string;
}

interface ChatRevealState {
  /** Keyed by `serverId:agentId`. A request waits here until that chat's view consumes it. */
  pending: Record<string, ChatReveal>;
  request(key: string, reveal: ChatReveal): void;
  clear(key: string): void;
}

export function chatRevealKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export const useChatRevealStore = create<ChatRevealState>((set) => ({
  pending: {},
  request: (key, reveal) => set((state) => ({ pending: { ...state.pending, [key]: reveal } })),
  clear: (key) =>
    set((state) => {
      if (!(key in state.pending)) return state;
      const { [key]: _removed, ...rest } = state.pending;
      return { pending: rest };
    }),
}));
