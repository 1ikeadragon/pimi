import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const PersistedSchema = z.strictObject({ docked: z.boolean(), collapsed: z.boolean() });

interface ActionItemsPreferences {
  /** Pinned into the Explorer instead of floating over the chat. */
  docked: boolean;
  /** The floating note shrunk to its pill. */
  collapsed: boolean;
  setDocked: (docked: boolean) => void;
  setCollapsed: (collapsed: boolean) => void;
}

/** Where the action items note lives and whether it is collapsed, remembered per device. */
export const useActionItemsPreferences = create<ActionItemsPreferences>()(
  persist(
    (set) => ({
      docked: false,
      collapsed: false,
      setDocked: (docked) => set({ docked }),
      setCollapsed: (collapsed) => set({ collapsed }),
    }),
    {
      name: "action-items-preferences",
      version: 1,
      storage: createValidatedPersistStorage(
        {
          getItem: (name) => AsyncStorage.getItem(name),
          setItem: (name, value) => AsyncStorage.setItem(name, value),
          removeItem: (name) => AsyncStorage.removeItem(name),
        },
        PersistedSchema,
      ),
      partialize: (state) => ({ docked: state.docked, collapsed: state.collapsed }),
    },
  ),
);
