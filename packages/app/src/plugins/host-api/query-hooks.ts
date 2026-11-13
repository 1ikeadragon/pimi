// eslint-disable-next-line no-restricted-imports -- these hooks run in plugin code, under the plugin's own QueryClient.
import { useQuery } from "@tanstack/react-query";
import type {
  PluginGitCommits,
  PluginGitDiff,
  PluginGitDiffCompare,
  PluginGitStatus,
  PluginQueryState,
} from "@pimi/plugin/client";
import type { PimiApi } from "@pimi/client";
import { useInstallation } from "./context";

// A checkout changes under the user's feet, so cached answers go stale quickly.
const STALE_MS = 5_000;

function useGitQuery<Data>(
  key: readonly unknown[],
  cwd: string | null,
  serverId: string | undefined,
  read: (pimi: PimiApi, cwd: string) => Promise<Data>,
): PluginQueryState<Data> {
  const installation = useInstallation();
  const target = serverId ?? installation.serverId;
  const query = useQuery({
    queryKey: ["pimi-plugin-git", target, ...key, cwd],
    enabled: cwd !== null,
    staleTime: STALE_MS,
    queryFn: () => {
      const pimi =
        target === installation.serverId
          ? installation.pimi
          : installation.hosts.getPimiClient(target);
      return read(pimi, cwd as string);
    },
  });
  const refetch = () => void query.refetch();
  if (query.status === "success") {
    return { status: "ready", data: query.data, error: null, refetch };
  }
  if (query.status === "error") {
    return {
      status: "error",
      data: query.data ?? null,
      error: query.error instanceof Error ? query.error.message : String(query.error),
      refetch,
    };
  }
  return { status: "loading", data: query.data ?? null, error: null, refetch };
}

export function useCheckoutStatus(
  cwd: string | null,
  options: { serverId?: string } = {},
): PluginQueryState<PluginGitStatus> {
  return useGitQuery(["status"], cwd, options.serverId, (pimi, dir) => pimi.git.status(dir));
}

export function useCheckoutDiff(
  cwd: string | null,
  compare: PluginGitDiffCompare,
  options: { serverId?: string } = {},
): PluginQueryState<PluginGitDiff> {
  return useGitQuery(
    ["diff", compare.mode, compare.baseRef ?? null, compare.ignoreWhitespace ?? false],
    cwd,
    options.serverId,
    (pimi, dir) => pimi.git.diff(dir, compare),
  );
}

export function useCommits(
  cwd: string | null,
  options: { serverId?: string } = {},
): PluginQueryState<PluginGitCommits> {
  return useGitQuery(["commits"], cwd, options.serverId, (pimi, dir) => pimi.git.commits(dir));
}
