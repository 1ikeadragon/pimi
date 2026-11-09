import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { generateDraftId } from "@/stores/draft-keys";

const MAX_HISTORY = 20;
export const MAX_VOICE_RECEIPT_LENGTH = 1600;

const outcomeSchema = z.strictObject({
  message: z.string().max(MAX_VOICE_RECEIPT_LENGTH),
  failed: z.boolean(),
});
const historySchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        id: z.string(),
        at: z.number().int().nonnegative(),
        transcript: z.string().max(4096),
        outcome: outcomeSchema.optional(),
      }),
    )
    .max(MAX_HISTORY),
});
type VoiceHistory = z.infer<typeof historySchema>;
type VoiceOutcome = z.infer<typeof outcomeSchema>;

interface VoiceHistoryStore extends VoiceHistory {
  record: (transcript: string) => string;
  finish: (id: string, outcome: VoiceOutcome) => void;
  clear: () => void;
}

export const usePimiVoiceHistory = create<VoiceHistoryStore>()(
  persist(
    (set) => ({
      entries: [],
      record: (transcript) => {
        const id = generateDraftId();
        const entry = { id, at: Date.now(), transcript: transcript.trim().slice(0, 4096) };
        set(({ entries }) => ({ entries: [entry, ...entries].slice(0, MAX_HISTORY) }));
        return id;
      },
      finish: (id, outcome) =>
        set(({ entries }) => ({
          entries: entries.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  outcome: {
                    ...outcome,
                    message: outcome.message.slice(0, MAX_VOICE_RECEIPT_LENGTH),
                  },
                }
              : entry,
          ),
        })),
      clear: () => set({ entries: [] }),
    }),
    {
      name: "pimi.ask-voice-history.v1",
      storage: createValidatedPersistStorage(AsyncStorage, historySchema),
      partialize: ({ entries }) => ({ entries }),
    },
  ),
);
