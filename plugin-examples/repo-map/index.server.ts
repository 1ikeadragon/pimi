import type { PluginHandlerContext, PluginServerContext } from "@pimi/plugin/server";
import { scan, watch } from "./shared/contracts";
import { scanRepository } from "./server/scan";
import { watchRepository } from "./server/watch";

async function workspaceDirectory(
  pimi: PluginHandlerContext["pimi"],
  workspaceId: string,
): Promise<string> {
  const workspace = await pimi.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory) throw new Error(`Workspace ${workspaceId} has no directory`);
  return workspace.workspaceDirectory;
}

export default function contribute(server: PluginServerContext) {
  server.handle(scan, async ({ workspaceId }, { pimi }) => {
    const cwd = await workspaceDirectory(pimi, workspaceId);
    return scanRepository(cwd, server.storage);
  });
  server.handle(watch, async ({ workspaceId }, { pimi, push, signal }) => {
    const cwd = await workspaceDirectory(pimi, workspaceId);
    await watchRepository(cwd, signal, () => void push({ type: "changed" }));
  });
  return () => {};
}
