import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { Automation } from "@pimi/protocol/automation/types";
import { toErrorMessage } from "@/utils/error-messages";

export const automationsQueryBaseKey = ["automations"] as const;

export const ALL_AUTOMATION_HOSTS_FAILED_MESSAGE = "No connected hosts could load automations";

export interface AutomationHostInput {
  serverId: string;
  serverName: string;
}

export interface AutomationRuntimeSnapshot {
  connectionStatus: string;
}

export interface AutomationRuntime {
  getClient(serverId: string): Pick<DaemonClient, "automationList"> | null;
  getSnapshot(serverId: string): AutomationRuntimeSnapshot | null | undefined;
}

/** An automation tagged with the host it came from, so the flat list can render a
 * per-row host label and scope mutations without host sections. */
export interface AggregatedAutomation extends Automation {
  serverId: string;
  serverName: string;
}

export interface AutomationHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface FetchAggregatedAutomationsConnectingResult {
  status: "connecting";
}

export interface FetchAggregatedAutomationsResult {
  status: "loaded";
  data: AggregatedAutomation[];
  hostErrors: AutomationHostError[];
  /** Saved hosts that have not connected yet; their automations are not in `data`. */
  connectingHosts: AutomationHostInput[];
}

export type FetchAggregatedAutomationsState =
  | FetchAggregatedAutomationsConnectingResult
  | FetchAggregatedAutomationsResult;

export type AggregateLoadState<T> =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: T[] };

export interface FetchAggregatedAutomationsInput {
  hosts: readonly AutomationHostInput[];
  runtime: AutomationRuntime;
}

/**
 * Fetch automations across connected hosts and merge them into one flat list.
 * Connectivity is checked here at execution time, so explicit query refreshes
 * pick up the currently connected host set.
 *
 * Offline hosts are skipped. A connected host that fails contributes to
 * `hostErrors` (surfaced as a banner) while the rest still render; only when
 * every connected host fails do we throw so the screen shows a full error.
 *
 * The list is `connecting` only while no host can be asked. Once one host has
 * answered, the result is `loaded` (even when empty) and the hosts still
 * connecting are listed in `connectingHosts`: a saved host that never comes up
 * must not hold the screen on a spinner. The query key includes connection
 * statuses, so a host that connects later triggers a refetch.
 */
export async function fetchAggregatedAutomations(
  input: FetchAggregatedAutomationsInput,
): Promise<FetchAggregatedAutomationsState> {
  const connectingHosts = input.hosts.filter((host) =>
    isAutomationHostConnectionSettling(input.runtime.getSnapshot(host.serverId)),
  );
  const hasSettlingHost = connectingHosts.length > 0;
  const hasAskableHost = input.hosts.some((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return snapshot?.connectionStatus === "online" && input.runtime.getClient(host.serverId);
  });

  if (!hasAskableHost && hasSettlingHost) {
    return { status: "connecting" };
  }

  const automations: AggregatedAutomation[] = [];
  const hostErrors: AutomationHostError[] = [];
  let connectedAttempts = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);
      if (!client || !isOnline) {
        return;
      }
      connectedAttempts += 1;
      try {
        const payload = await client.automationList();
        for (const automation of payload.automations) {
          automations.push({ ...automation, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (
    connectedAttempts > 0 &&
    automations.length === 0 &&
    hostErrors.length === connectedAttempts
  ) {
    throw new Error(ALL_AUTOMATION_HOSTS_FAILED_MESSAGE);
  }

  return { status: "loaded", data: automations, hostErrors, connectingHosts };
}

function isAutomationHostConnectionSettling(
  snapshot: AutomationRuntimeSnapshot | null | undefined,
): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}
