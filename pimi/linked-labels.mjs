// Pimi addition to the Paseo fork. Apache-2.0.
import { workspaceLabelKey } from "@pimi/protocol/workspace-labels";

function add(index, id, labels) {
  if (!id || !labels.length) return;
  let names = index.get(id);
  if (!names) index.set(id, (names = new Map()));
  for (const label of labels) names.set(workspaceLabelKey(label), label);
}

export function labelsAt(index, id) {
  return [...(index.get(id)?.values() ?? [])];
}

export function labelRecord(index) {
  return Object.fromEntries([...index].map(([id, names]) => [id, [...names.values()]]));
}

export function projectLinkedLabels(tasks, workspaces, serverId) {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
  const taskLabels = new Map();
  const workspaceLabels = new Map();
  const checkoutLabels = new Map();
  const agentLabels = new Map();
  for (const task of tasks) {
    const direct = task.labels ?? [];
    for (const item of task.experiments) {
      const workspace = item.workspaceId ? byId.get(item.workspaceId) : byPath.get(item.path);
      const workspaceId = workspace?.id ?? item.workspaceId;
      add(taskLabels, task.id, workspace?.labels ?? []);
      add(workspaceLabels, workspaceId, direct);
      // Older links and Git worktrees without a registered workspace have only a path.
      if (!workspaceId) add(checkoutLabels, item.path, direct);
    }

    const visible = [...direct, ...labelsAt(taskLabels, task.id)];
    if (task.source?.serverId === serverId) add(agentLabels, task.source?.agentId, visible);
    for (const item of task.experiments) {
      if (item.launch) add(agentLabels, item.id, visible);
    }
  }
  return { taskLabels, workspaceLabels, checkoutLabels, agentLabels };
}
