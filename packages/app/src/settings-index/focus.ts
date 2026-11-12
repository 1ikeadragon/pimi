import { create } from "zustand";

/** How long a found field stays highlighted. */
export const SETTING_HIGHLIGHT_MS = 1800;

interface SettingsFocusState {
  /** The field a search result asked for. `seq` makes asking for the same field twice a new request. */
  request: { id: string; seq: number } | null;
  focusSetting(id: string): void;
  /** Called when a field has shown its highlight, so remounting the page does not replay it. */
  settle(seq: number): void;
}

let nextSeq = 0;

export const useSettingsFocusStore = create<SettingsFocusState>((set, get) => ({
  request: null,
  focusSetting: (id) => set({ request: { id, seq: ++nextSeq } }),
  settle: (seq) => {
    if (get().request?.seq === seq) set({ request: null });
  },
}));
