// Pimi. PolyForm-Noncommercial-1.0.0.
// The last inbox read per host, so Review shows rows before the first `list_inbox` of a launch
// answers. The list renders the live query when it has data and this snapshot until then.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ForgeChangeRequestListInboxResponseSchema } from "@pimi/protocol/messages";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { ChangeRequestInbox } from "./queries";

const MAX_STORED_ITEMS = 100;

const StoredInboxSchema = ForgeChangeRequestListInboxResponseSchema.shape.payload.omit({
  requestId: true,
});
type StoredInbox = Omit<ChangeRequestInbox, "requestId">;

interface InboxState {
  /** `serverId|forgeHost` -> the last successful inbox payload */
  last: Record<string, StoredInbox>;
  save: (key: string, inbox: ChangeRequestInbox) => void;
}

const InboxStateSchema: z.ZodType<Pick<InboxState, "last">> = z.strictObject({
  last: z.record(z.string(), StoredInboxSchema),
});

export function inboxStoreKey(serverId: string, forgeHost: string): string {
  return `${serverId}|${forgeHost}`;
}

export const useInboxStore = create<InboxState>()(
  persist(
    (set) => ({
      last: {},
      save: (key, inbox) =>
        set((state) => {
          const { requestId: _requestId, ...rest } = inbox;
          return {
            last: {
              ...state.last,
              [key]: { ...rest, items: rest.items.slice(0, MAX_STORED_ITEMS) },
            },
          };
        }),
    }),
    {
      name: "@pimi:review-inbox-last",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, InboxStateSchema),
      partialize: (state) => ({ last: state.last }),
    },
  ),
);
