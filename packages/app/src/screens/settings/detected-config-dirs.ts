import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface DetectedConfigDirectory {
  provider: string;
  envKey: string;
  path: string;
  accountLabel?: string;
}

const NONE: readonly DetectedConfigDirectory[] = [];

/** Extra Claude/Codex installs on the host that no provider launches with yet. */
export function useDetectedConfigDirectories(
  serverId: string,
  provider: string,
): readonly DetectedConfigDirectory[] {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const query = useFetchQuery({
    queryKey: ["provider-config-dirs", serverId] as const,
    queryFn: async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host is not connected");
      return (await client.detectProviderConfigDirs()).directories;
    },
    enabled: isConnected,
    dataShape: "list",
    staleTimeMs: 30_000,
  });
  return query.data?.filter((directory) => directory.provider === provider) ?? NONE;
}

/** The directory's own name, which is how the user told the installs apart: `.claude-work`. */
export function configDirectoryName(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}
