import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";

/** Host policy comes from the live daemon config replica. */
export function useUsageSetting(serverId: string | null) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => patchConfig({ usage: { enabled } }),
  });
  const setEnabled = mutation.mutate;
  const turnOn = useCallback(() => setEnabled(true), [setEnabled]);
  return {
    error: mutation.error,
    enabled: config !== null && config.usage?.enabled !== false,
    ready: config !== null,
    setEnabled,
    turnOn,
  };
}
