// Pimi. PolyForm-Noncommercial-1.0.0.
// Viewed marks for the Files tab. A mark stores a fingerprint of the file as it was viewed (a pull
// request's blob SHA, a worktree's hunk hash), so a change to that file clears its mark and leaves
// every other file marked.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface ViewedState {
  /** review key -> path -> fingerprint that was marked */
  marks: Record<string, Record<string, string>>;
  toggle: (reviewKey: string, path: string, fingerprint: string) => void;
}

const ViewedStateSchema: z.ZodType<Pick<ViewedState, "marks">> = z.strictObject({
  marks: z.record(z.string(), z.record(z.string(), z.string())),
});

export const useViewedStore = create<ViewedState>()(
  persist(
    (set) => ({
      marks: {},
      toggle: (reviewKey, path, fingerprint) =>
        set((state) => {
          const current = state.marks[reviewKey] ?? {};
          const next = { ...current };
          if (next[path] === fingerprint) delete next[path];
          else next[path] = fingerprint;
          return { marks: { ...state.marks, [reviewKey]: next } };
        }),
    }),
    {
      name: "@pimi:review-desk-viewed",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, ViewedStateSchema),
      partialize: (state) => ({ marks: state.marks }),
    },
  ),
);
