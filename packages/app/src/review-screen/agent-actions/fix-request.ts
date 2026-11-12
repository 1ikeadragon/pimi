// Pimi. Apache-2.0.
// Stream S5: how a card or the inspector asks for the Fix sheet. The shell mounts one
// `ReviewFixSheet` beside the detail pane and does not pass it an opener, so the request travels
// through this store instead of the shell. Ids resolve against the timeline inside the sheet.
import { create } from "zustand";

export interface ReviewFixRequest {
  threadIds: readonly string[];
  checkKeys: readonly string[];
}

interface ReviewFixState {
  request: ReviewFixRequest | null;
  open: (request: ReviewFixRequest) => void;
  close: () => void;
}

export const useReviewFixStore = create<ReviewFixState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Open the Fix sheet for these threads and checks. It only prefills a chat; it never sends. */
export function requestReviewFix(request: ReviewFixRequest): void {
  useReviewFixStore.getState().open(request);
}
