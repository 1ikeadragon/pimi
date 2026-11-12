import { create } from "zustand";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface IndexRun {
  running: boolean;
  done: number;
  total: number;
  error: string | null;
}

interface IndexRunState {
  run: IndexRun | null;
  /** Counts finished runs, so a search can run again once the index has grown. */
  finished: number;
  start(serverIds: readonly string[]): Promise<void>;
}

const POLL_MS = 1000;

async function readIndexRun(
  serverIds: readonly string[],
  action: "start" | "status",
): Promise<IndexRun> {
  const states = await Promise.all(
    serverIds.map(async (serverId) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host is not connected");
      return await client.indexOlderChats(action);
    }),
  );
  return {
    running: states.some((state) => state.running),
    done: states.reduce((sum, state) => sum + state.done, 0),
    total: states.reduce((sum, state) => sum + state.total, 0),
    error: states.find((state) => state.error)?.error ?? null,
  };
}

/**
 * The "Index older chats" run. It lives here rather than in a component because the screen that
 * started it can be rebuilt while the daemon is still working.
 */
export const useIndexRunStore = create<IndexRunState>((set, get) => ({
  run: null,
  finished: 0,
  start: async (serverIds) => {
    if (get().run?.running) return;
    set({ run: { running: true, done: 0, total: 0, error: null } });
    try {
      let next = await readIndexRun(serverIds, "start");
      while (next.running) {
        set({ run: next });
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        next = await readIndexRun(serverIds, "status");
      }
      set((state) => ({ run: next, finished: state.finished + 1 }));
    } catch (error) {
      set((state) => ({
        run: {
          running: false,
          done: 0,
          total: 0,
          error: error instanceof Error ? error.message : String(error),
        },
        finished: state.finished + 1,
      }));
    }
  },
}));
