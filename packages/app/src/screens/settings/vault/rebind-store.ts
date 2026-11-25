import { create } from "zustand";

interface RebindTarget {
  name: string;
  envName: string;
}

interface RebindState {
  target: RebindTarget | null;
  start: (target: RebindTarget) => void;
  clear: () => void;
}

/** The secret whose Bitwarden binding the picker is replacing, set by the row's Rebind button. */
export const useRebindStore = create<RebindState>((set) => ({
  target: null,
  start: (target) => set({ target }),
  clear: () => set({ target: null }),
}));
