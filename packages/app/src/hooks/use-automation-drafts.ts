import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AutomationDraft } from "@pimi/protocol/automation/types";
import { automationsQueryBaseKey } from "@/automations/aggregated-automations";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface AggregatedAutomationDraft extends AutomationDraft {
  serverId: string;
}

const automationDraftsQueryBaseKey = ["automation-drafts"] as const;
const NO_DRAFTS: AggregatedAutomationDraft[] = [];
// A compile is one LLM turn: poll quickly while one runs, slowly otherwise so a draft started on
// another client still surfaces.
const DRAFTING_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;

function clientFor(serverId: string) {
  return useSessionStore.getState().sessions[serverId]?.client ?? null;
}

/** Every connected host's drafts. A host that fails to answer contributes none. */
export function useAutomationDrafts(): AggregatedAutomationDraft[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const onlineIds = useMemo(
    () => serverIds.filter((serverId) => statuses.get(serverId) === "online"),
    [serverIds, statuses],
  );
  const query = useFetchQuery({
    queryKey: [...automationDraftsQueryBaseKey, onlineIds.join("|")],
    enabled: onlineIds.length > 0,
    dataShape: "list",
    staleTimeMs: 1_000,
    refetchInterval: (current) =>
      current.state.data?.some((draft) => draft.state === "drafting")
        ? DRAFTING_POLL_MS
        : IDLE_POLL_MS,
    queryFn: async (): Promise<AggregatedAutomationDraft[]> => {
      const perHost = await Promise.all(
        onlineIds.map(async (serverId) => {
          const client = clientFor(serverId);
          if (!client) return [];
          try {
            const { drafts } = await client.automationDraftList();
            const tagged: AggregatedAutomationDraft[] = [];
            for (const draft of drafts) tagged.push({ ...draft, serverId });
            return tagged;
          } catch {
            return [];
          }
        }),
      );
      return perHost.flat();
    },
  });
  return query.data ?? NO_DRAFTS;
}

export interface AutomationDraftActions {
  start: (input: {
    serverId: string;
    description: string;
    cwd: string;
  }) => Promise<AutomationDraft>;
  retry: (draft: AggregatedAutomationDraft) => Promise<void>;
  dismiss: (draft: AggregatedAutomationDraft) => Promise<void>;
  /** Refreshes drafts and the automation list, such as when a draft turned into an automation. */
  refresh: () => void;
}

export function useAutomationDraftActions(): AutomationDraftActions {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const requireClient = useCallback(
    (serverId: string) => {
      const client = clientFor(serverId);
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      return client;
    },
    [t],
  );
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: automationDraftsQueryBaseKey });
    void queryClient.invalidateQueries({ queryKey: automationsQueryBaseKey });
  }, [queryClient]);
  const start = useCallback<AutomationDraftActions["start"]>(
    async ({ serverId, description, cwd }) => {
      const { draft } = await requireClient(serverId).automationDraftStart({ description, cwd });
      refresh();
      return draft;
    },
    [refresh, requireClient],
  );
  const retry = useCallback<AutomationDraftActions["retry"]>(
    async (draft) => {
      await requireClient(draft.serverId).automationDraftRetry({ draftId: draft.id });
      refresh();
    },
    [refresh, requireClient],
  );
  const dismiss = useCallback<AutomationDraftActions["dismiss"]>(
    async (draft) => {
      await requireClient(draft.serverId).automationDraftDismiss({ draftId: draft.id });
      refresh();
    },
    [refresh, requireClient],
  );
  return useMemo(() => ({ start, retry, dismiss, refresh }), [dismiss, refresh, retry, start]);
}
