import { useCallback, useEffect, useReducer } from "react";
import type { PimiAgentBackgroundWorkOutput } from "@pimi/client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useTranslation } from "@/i18n/use-translation";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

// A viewer keeps the newest part of the output, as a foreground shell row does.
const KEPT_CHARS = 64 * 1024;
const POLL_INTERVAL_MS = 1000;
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface BackgroundOutputState {
  status: "loading" | "ready" | "error";
  output: string;
  /** Characters of the job's output left out before `output`, counted from the first page read. */
  outputOffset: number;
  running: boolean;
}

type BackgroundOutputAction =
  | { type: "start" }
  | {
      type: "page";
      page: PimiAgentBackgroundWorkOutput;
      /** The page opens a new read from the newest output, so it replaces what is held. */
      replace: boolean;
      skippedMarker: string;
    }
  | { type: "failed" };

const INITIAL_STATE: BackgroundOutputState = {
  status: "loading",
  output: "",
  outputOffset: 0,
  running: true,
};

function reduce(
  state: BackgroundOutputState,
  action: BackgroundOutputAction,
): BackgroundOutputState {
  // A read that starts over keeps showing what it has until the first page replaces it.
  if (action.type === "start") return { ...state, status: "loading", running: true };
  if (action.type === "failed") return { ...state, status: "error" };
  const { page } = action;
  const restarts = action.replace || page.skipped;
  const marker = page.skipped ? action.skippedMarker : "";
  const joined = restarts ? `${marker}${page.output}` : `${state.output}${page.output}`;
  const dropped = Math.max(0, joined.length - KEPT_CHARS);
  return {
    status: "ready",
    output: dropped > 0 ? joined.slice(dropped) : joined,
    outputOffset: (restarts ? 0 : state.outputOffset) + dropped,
    running: page.running,
  };
}

interface BackgroundShellOutputInput {
  serverId: string;
  agentId: string;
  itemId: string;
}

/**
 * Tails a background shell while the component using it is mounted and its panel is active: one
 * read at a time, the next 1 s after the last answered. It stops after the read that finds the job
 * ended, and starts over, from the newest output, when the panel is shown again or on retry.
 */
export function useBackgroundShellOutput({
  serverId,
  agentId,
  itemId,
}: BackgroundShellOutputInput) {
  const { t } = useTranslation();
  const skippedMarker = `${DIM}${t("message.backgroundWork.earlierOutputHidden")}${RESET}\n`;
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const panelActive = useRetainedPanelActive();
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    if (!panelActive) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    dispatch({ type: "start" });
    const read = async (cursor: number | null) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host disconnected");
      return client.readAgentBackgroundWorkOutput(agentId, itemId, cursor);
    };
    const poll = (cursor: number | null) => {
      read(cursor)
        .then((page) => {
          if (stopped) return undefined;
          dispatch({ type: "page", page, replace: cursor === null, skippedMarker });
          if (page.running) timer = setTimeout(() => poll(page.cursor), POLL_INTERVAL_MS);
          return undefined;
        })
        .catch(() => {
          if (!stopped) dispatch({ type: "failed" });
        });
    };
    poll(null);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [serverId, agentId, itemId, skippedMarker, panelActive, attempt]);

  const retryRead = useCallback(() => retry(), []);
  return { ...state, retry: retryRead };
}
