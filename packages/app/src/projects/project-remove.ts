import type { DaemonClient } from "@pimi/client/internal/daemon-client";

export interface ProjectRemoveTarget {
  serverId: string;
  projectId: string;
}

export type ProjectRemoveOutcome =
  | { kind: "removed"; serverIds: string[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "failed"; serverIds: string[] };

type ProjectRemoveClient = Pick<DaemonClient, "removeProject">;

export async function removeProjectFromHosts(input: {
  targets: readonly ProjectRemoveTarget[];
  getClient: (serverId: string) => ProjectRemoveClient | null;
}): Promise<ProjectRemoveOutcome> {
  const clients: Array<{ serverId: string; projectId: string; client: ProjectRemoveClient }> = [];
  const disconnectedServerIds: string[] = [];

  for (const target of input.targets) {
    const client = input.getClient(target.serverId);
    if (!client) {
      disconnectedServerIds.push(target.serverId);
      continue;
    }
    clients.push({ serverId: target.serverId, projectId: target.projectId, client });
  }

  if (disconnectedServerIds.length > 0) {
    return { kind: "host_disconnected", serverIds: disconnectedServerIds };
  }

  const results = await Promise.allSettled(
    clients.map(async ({ client, projectId }) => {
      await client.removeProject(projectId);
    }),
  );
  const failedServerIds: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const failed = clients[index];
      if (failed) {
        failedServerIds.push(failed.serverId);
      }
    }
  }

  if (failedServerIds.length > 0) {
    return { kind: "failed", serverIds: failedServerIds };
  }

  return { kind: "removed", serverIds: clients.map((entry) => entry.serverId) };
}
