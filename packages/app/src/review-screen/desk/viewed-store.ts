// Pimi. PolyForm-Noncommercial-1.0.0.
// Viewed marks for the Changes tab. A mark stores the file's blob SHA, so a push that changes a
// file clears its mark and leaves every other file marked.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { ChangeRequestSource } from "../types";

interface ViewedState {
  /** review key -> path -> blob SHA that was marked */
  marks: Record<string, Record<string, string>>;
  toggle: (reviewKey: string, path: string, blobSha: string) => void;
}

const ViewedStateSchema: z.ZodType<Pick<ViewedState, "marks">> = z.strictObject({
  marks: z.record(z.string(), z.record(z.string(), z.string())),
});

export function reviewKeyOf(source: ChangeRequestSource): string {
  return `${source.serverId}|${source.forgeHost}/${source.owner}/${source.name}#${source.number}`;
}

export const useViewedStore = create<ViewedState>()(
  persist(
    (set) => ({
      marks: {},
      toggle: (reviewKey, path, blobSha) =>
        set((state) => {
          const current = state.marks[reviewKey] ?? {};
          const next = { ...current };
          if (next[path] === blobSha) delete next[path];
          else next[path] = blobSha;
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
