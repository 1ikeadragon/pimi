import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrowserAutomationBrowserIdSchema } from "@pimi/protocol/browser-automation/rpc-schemas";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  applyBrowserPatch,
  BrowserIndexStateSchema,
  type BrowserIndexState,
  type BrowserOwner,
  type BrowserRecord,
  type BrowserRecordPatch,
  type BrowserViewport,
  createBrowserRecord,
  normalizeBrowserIndexState,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  sanitizeBrowsersForPersist,
  trimNonEmpty,
} from "./state";

export {
  createFixedBrowserViewport,
  RESPONSIVE_BROWSER_VIEWPORT,
  type BrowserRecord,
  type BrowserViewport,
} from "./state";

interface BrowserStoreState extends BrowserIndexState {
  createBrowser: (input?: { initialUrl?: string; owner?: BrowserOwner }) => string;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  setBrowserViewport: (browserId: string, viewport: BrowserViewport) => void;
  removeBrowser: (browserId: string) => void;
  /**
   * Asks a browser pane to arm its annotate selector once the page has loaded. Not persisted: a
   * request is a moment, and a reload must not re-arm. The value is the request time.
   */
  annotateRequestByBrowserId: Record<string, number>;
  requestAnnotate: (browserId: string) => void;
  clearAnnotateRequest: (browserId: string) => void;
}

function createBrowserId(): string {
  let browserId: string;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    browserId = globalThis.crypto.randomUUID();
  } else {
    const randomSuffix = Math.random().toString(16).slice(2) || "0";
    browserId = `${Date.now()}-${randomSuffix}`;
  }
  return BrowserAutomationBrowserIdSchema.parse(browserId);
}

export const useBrowserStore = create<BrowserStoreState>()(
  persist(
    (set) => ({
      browsersById: {},
      annotateRequestByBrowserId: {},
      createBrowser: (input) => {
        const browserId = createBrowserId();
        const record = createBrowserRecord({
          browserId,
          initialUrl: input?.initialUrl,
          owner: input?.owner,
          now: Date.now(),
        });

        set((state) => ({
          browsersById: {
            ...state.browsersById,
            [browserId]: record,
          },
        }));

        return browserId;
      },
      updateBrowser: (browserId, patch) => {
        set((state) => applyBrowserPatch(state, browserId, patch));
      },
      setBrowserViewport: (browserId, viewport) => {
        set((state) => applyBrowserPatch(state, browserId, { viewport }));
      },
      removeBrowser: (browserId) => {
        set((state) => removeBrowserFromIndex(state, browserId));
      },
      requestAnnotate: (browserId) => {
        set((state) => ({
          annotateRequestByBrowserId: {
            ...state.annotateRequestByBrowserId,
            [browserId]: Date.now(),
          },
        }));
      },
      clearAnnotateRequest: (browserId) => {
        set((state) => {
          const { [browserId]: _cleared, ...rest } = state.annotateRequestByBrowserId;
          return { annotateRequestByBrowserId: rest };
        });
      },
    }),
    {
      name: "workspace-browser-store",
      storage: createValidatedPersistStorage(AsyncStorage, BrowserIndexStateSchema),
      partialize: (state) => sanitizeBrowsersForPersist(state),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizeBrowserIndexState(persistedState),
      }),
    },
  ),
);

export function getBrowserRecord(browserId: string): BrowserRecord | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  return useBrowserStore.getState().browsersById[normalizedBrowserId] ?? null;
}

export function createWorkspaceBrowser(input?: { initialUrl?: string; owner?: BrowserOwner }): {
  browserId: string;
  url: string;
} {
  const browserId = useBrowserStore.getState().createBrowser(input);
  const record = getBrowserRecord(browserId);
  return {
    browserId,
    url: record?.url ?? normalizeBrowserUrl(input?.initialUrl),
  };
}

export function normalizeWorkspaceBrowserUrl(value: string | null | undefined): string {
  return normalizeBrowserUrl(value);
}
