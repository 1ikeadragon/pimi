import { router, type Href } from "expo-router";

export const PIMI_TASKS_ROUTE = "/pimi-tasks";

export function openPimiTasks(serverId?: string, taskId?: string): void {
  const params = new URLSearchParams();
  if (serverId) params.set("serverId", serverId);
  if (taskId) params.set("taskId", taskId);
  const query = params.toString();
  router.navigate((query ? `${PIMI_TASKS_ROUTE}?${query}` : PIMI_TASKS_ROUTE) as Href);
}
