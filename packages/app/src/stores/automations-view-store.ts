import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const AUTOMATIONS_VIEW_STORAGE_KEY = "automations-view";

export type AutomationCanvasDirection = "right" | "down";

const PersistedAutomationsViewSchema = z.strictObject({
  canvasDirection: z.enum(["right", "down"]).nullable(),
  inspectorHidden: z.boolean(),
});

interface AutomationsViewState {
  /** Null until the user picks one; the editor then follows the form factor. */
  canvasDirection: AutomationCanvasDirection | null;
  inspectorHidden: boolean;
  setCanvasDirection: (direction: AutomationCanvasDirection) => void;
  setInspectorHidden: (hidden: boolean) => void;
}

/** Automation editor canvas direction and desktop inspector visibility, remembered per device. */
export const useAutomationsViewStore = create<AutomationsViewState>()(
  persist(
    (set) => ({
      canvasDirection: null,
      inspectorHidden: false,
      setCanvasDirection: (canvasDirection) => set({ canvasDirection }),
      setInspectorHidden: (inspectorHidden) => set({ inspectorHidden }),
    }),
    {
      name: AUTOMATIONS_VIEW_STORAGE_KEY,
      version: 1,
      storage: createValidatedPersistStorage(
        {
          getItem: (name) => AsyncStorage.getItem(name),
          setItem: (name, value) => AsyncStorage.setItem(name, value),
          removeItem: (name) => AsyncStorage.removeItem(name),
        },
        PersistedAutomationsViewSchema,
      ),
      partialize: (state) => ({
        canvasDirection: state.canvasDirection,
        inspectorHidden: state.inspectorHidden,
      }),
    },
  ),
);
