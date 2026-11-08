import { useCallback } from "react";
import { useFocusEffect } from "expo-router/react-navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TerminalHooksStatus } from "@getpaseo/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const PROVIDER_LABELS = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const STATE_LABELS = {
  installed: "Installed",
  "not-installed": "Not installed",
  partial: "Needs repair",
  unavailable: "Could not verify",
};

export function TerminalHooksSection({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const canInspect = useHostFeature(serverId, "terminalHookManagement");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const queryClient = useQueryClient();
  const queryKey = ["host", serverId, "terminal-hooks"] as const;
  const query = useFetchQuery({
    queryKey,
    queryFn: async (): Promise<TerminalHooksStatus> => {
      if (!client) throw new Error("Host disconnected");
      return client.getTerminalHooksStatus();
    },
    enabled: connected && client !== null && canInspect,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      if (connected && canInspect) void refetch();
    }, [canInspect, connected, refetch]),
  );

  const changeHooks = useMutation({
    mutationFn: async (action: "install" | "uninstall" | "retry") => {
      if (!client || !connected) throw new Error("Host disconnected");
      if (action === "retry") {
        const status = await client.reconcileTerminalHooks();
        queryClient.setQueryData(queryKey, status);
      } else {
        const changed = await patchConfig({ enableTerminalAgentHooks: action === "install" });
        if (!changed) throw new Error("Host disconnected");
        if (canInspect) await refetch();
      }
    },
  });
  const { mutate, isError, isPending } = changeHooks;
  const status = query.isError ? null : query.data;
  const enabled = config?.enableTerminalAgentHooks ?? status?.enabled;
  const canChange = connected && enabled !== undefined && !isPending;
  const handleToggle = useCallback(
    () => mutate(enabled ? "uninstall" : "install"),
    [enabled, mutate],
  );
  const handleRetry = useCallback(() => mutate("retry"), [mutate]);
  const handleRefresh = useCallback(() => void refetch(), [refetch]);
  let hint = "Install the bundled hooks to see agent activity from terminals.";
  if (!connected) hint = "Connect to a host to manage its hooks.";
  else if (!canInspect) hint = "Update this host to verify each installation.";

  return (
    <SettingsSection title="Terminal hooks">
      <SettingsCard testID="pimi-terminal-hooks-card">
        <SettingsRow
          label="Agent activity"
          hint={hint}
          error={isError ? "Could not change hooks on this host." : undefined}
        >
          <Button
            variant="outline"
            disabled={!canChange}
            onPress={handleToggle}
            testID="pimi-terminal-hooks-toggle"
          >
            {enabled ? "Uninstall hooks" : "Install hooks"}
          </Button>
        </SettingsRow>
        {connected && canInspect ? (
          <TerminalHooksStatusRow
            status={status}
            enabled={enabled}
            canChange={canChange}
            isFetching={query.isFetching}
            isError={query.isError}
            isPending={isPending}
            onRetry={handleRetry}
            onRefresh={handleRefresh}
          />
        ) : null}
        {connected
          ? status?.providers.map(({ provider, state }) => (
              <SettingsRow
                key={provider}
                label={PROVIDER_LABELS[provider]}
                hint={STATE_LABELS[state]}
                testID={`pimi-terminal-hook-${provider}`}
              />
            ))
          : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function TerminalHooksStatusRow({
  status,
  enabled,
  canChange,
  isFetching,
  isError,
  isPending,
  onRetry,
  onRefresh,
}: {
  status?: TerminalHooksStatus | null;
  enabled?: boolean;
  canChange: boolean;
  isFetching: boolean;
  isError: boolean;
  isPending: boolean;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const expectedState = enabled ? "installed" : "not-installed";
  const needsRepair = status?.providers.some(({ state }) => state !== expectedState);
  let hint: string | undefined;
  if (isError) hint = "Could not read hook status from the host.";
  else if (isFetching) hint = "Checking installed hooks…";
  else if (needsRepair) hint = "Some hooks differ from the current setting.";

  return (
    <SettingsRow label="Installation status" hint={hint}>
      {needsRepair && !isFetching ? (
        <Button
          variant="outline"
          disabled={!canChange}
          onPress={onRetry}
          testID="pimi-terminal-hooks-retry"
        >
          {enabled ? "Retry install" : "Retry removal"}
        </Button>
      ) : (
        <Button variant="ghost" disabled={isFetching || isPending} onPress={onRefresh}>
          Refresh
        </Button>
      )}
    </SettingsRow>
  );
}
