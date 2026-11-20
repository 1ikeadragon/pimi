import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { i18n } from "@/i18n/i18next";

export interface BulkClosableTabGroups {
  // Closing an agent tab only changes this client's layout; it never archives the agent.
  agentTabs: Array<{ tabId: string; agentId: string }>;
  terminalTabs: Array<{ tabId: string; terminalId: string }>;
  otherTabs: Array<{ tabId: string; target: WorkspaceTabDescriptor["target"] }>;
}

export interface BulkCloseConfirmationLabels {
  terminalsAndTabs: (input: { terminals: number; tabs: number }) => string;
  terminals: (input: { terminals: number }) => string;
  tabs: (input: { tabs: number }) => string;
}

export const DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS: BulkCloseConfirmationLabels = {
  terminalsAndTabs: ({ terminals, tabs }) =>
    `This will close ${terminals} terminal(s) and close ${tabs} tab(s). Any running process in a closed terminal will be stopped immediately.`,
  terminals: ({ terminals }) =>
    `This will close ${terminals} terminal(s). Any running process in a closed terminal will be stopped immediately.`,
  tabs: ({ tabs }) => `This will close ${tabs} tab(s).`,
};

interface CloseWorkspaceTabWithCleanupInput {
  tabId: string;
  target?: WorkspaceTabDescriptor["target"];
}

interface CloseBulkWorkspaceTabsInput {
  client: Pick<DaemonClient, "closeItems"> | null;
  groups: BulkClosableTabGroups;
  closeTab: (tabId: string, action: () => Promise<void>) => Promise<void>;
  closeWorkspaceTabWithCleanup: (input: CloseWorkspaceTabWithCleanupInput) => void;
  logLabel: string;
  warn?: (message: string, payload: object) => void;
}

export function classifyBulkClosableTabs(tabs: WorkspaceTabDescriptor[]): BulkClosableTabGroups {
  const groups: BulkClosableTabGroups = { agentTabs: [], terminalTabs: [], otherTabs: [] };
  for (const tab of tabs) {
    if (tab.target.kind === "agent") {
      groups.agentTabs.push({ tabId: tab.tabId, agentId: tab.target.agentId });
    } else if (tab.target.kind === "terminal") {
      groups.terminalTabs.push({ tabId: tab.tabId, terminalId: tab.target.terminalId });
    } else {
      groups.otherTabs.push({ tabId: tab.tabId, target: tab.target });
    }
  }
  return groups;
}

export function buildBulkCloseConfirmationMessage(
  input: BulkClosableTabGroups,
  labels: BulkCloseConfirmationLabels = DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS,
): string {
  const terminals = input.terminalTabs.length;
  const tabs = input.agentTabs.length + input.otherTabs.length;
  if (terminals > 0 && tabs > 0) {
    return labels.terminalsAndTabs({ terminals, tabs });
  }
  if (terminals > 0) {
    return labels.terminals({ terminals });
  }
  return labels.tabs({ tabs });
}

export async function closeBulkWorkspaceTabs(input: CloseBulkWorkspaceTabsInput): Promise<void> {
  const { client, groups, closeTab, closeWorkspaceTabWithCleanup, logLabel, warn } = input;

  if (groups.terminalTabs.length > 0) {
    if (client) {
      void client
        .closeItems({ terminalIds: groups.terminalTabs.map((tab) => tab.terminalId) })
        .catch((error) => {
          warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, { error });
        });
    } else {
      warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, {
        error: new Error(i18n.t("common.errors.daemonClientUnavailable")),
      });
    }
  }

  await Promise.all([
    ...groups.agentTabs.map(({ tabId, agentId }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({ tabId, target: { kind: "agent", agentId } });
      }),
    ),
    ...groups.terminalTabs.map(({ tabId, terminalId }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({ tabId, target: { kind: "terminal", terminalId } });
      }),
    ),
    ...groups.otherTabs.map(({ tabId, target }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({ tabId, target });
      }),
    ),
  ]);
}
