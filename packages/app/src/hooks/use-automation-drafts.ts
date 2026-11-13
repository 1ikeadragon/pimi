import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n/use-translation";
import type { AutomationDraft } from "@pimi/protocol/automation/types";
import { automationsQueryBaseKey } from "@/automations/aggregated-automations";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface AggregatedAutomationDraft extends AutomationDraft {
  serverId: string;
}

const automationDraftsQueryBaseKey = ["automation-drafts"] as const;

/**
 * Drafts this client started or retried, as `serverId:draftId`. The draft watcher announces the
 * ones in here when they settle, so a draft that fails before the first list fetch still gets its
 * toast, while drafts that settled before this client loaded stay quiet.
 */
export const announceableDraftKeys = new Set<string>();
const NO_DRAFTS: AggregatedAutomationDraft[] = [];

function clientFor(serverId: string) {
  return useSessionStore.getState().sessions[serverId]?.client ?? null;
}

function useOnlineHostIds(): string[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  return useMemo(
    () => serverIds.filter((serverId) => statuses.get(serverId) === "online"),
    [serverIds, statuses],
  );
}

/**
 * Keeps the draft list current from the hosts' change events, including drafts started on another
 * client. A subscription's snapshot fires on every (re)connect, which catches changes missed while
 * offline. Mount once; `useAutomationDrafts` readers share the query.
 */
export function useAutomationDraftSync(): void {
  const queryClient = useQueryClient();
  const onlineIds = useOnlineHostIds();
  const onlineKey = onlineIds.join("|");
  useEffect(() => {
    const releases: Array<() => void> = [];
    for (const serverId of onlineKey ? onlineKey.split("|") : []) {
      const client = clientFor(serverId);
      if (!client) continue;
      const observation = client.observeEvents(["status.automation_drafts_changed"]);
      const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: automationDraftsQueryBaseKey });
      };
      observation.subscribe({
        snapshot: invalidate,
        update: (message) => {
          if (message.type === "status" && message.payload.status === "automation_drafts_changed") {
            invalidate();
          }
        },
      });
      releases.push(() => {
        void observation.release().catch(() => undefined);
      });
    }
    return () => {
      for (const release of releases) release();
    };
  }, [onlineKey, queryClient]);
}

/** Every connected host's drafts. A host that fails to answer contributes none. */
export function useAutomationDrafts(): AggregatedAutomationDraft[] {
  const onlineIds = useOnlineHostIds();
  const query = useFetchQuery({
    queryKey: [...automationDraftsQueryBaseKey, onlineIds.join("|")],
    enabled: onlineIds.length > 0,
    dataShape: "list",
    staleTimeMs: 1_000,
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
      announceableDraftKeys.add(`${serverId}:${draft.id}`);
      refresh();
      return draft;
    },
    [refresh, requireClient],
  );
  const retry = useCallback<AutomationDraftActions["retry"]>(
    async (draft) => {
      await requireClient(draft.serverId).automationDraftRetry({ draftId: draft.id });
      announceableDraftKeys.add(`${draft.serverId}:${draft.id}`);
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
