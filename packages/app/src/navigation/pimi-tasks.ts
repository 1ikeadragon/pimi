import { router, type Href } from "expo-router";

export const PIMI_TASKS_ROUTE = "/pimi-tasks";

interface PimiTasksRouteOptions {
  serverId?: string;
  taskId?: string;
  /** Open the New task sheet. */
  newTask?: boolean;
}

export function buildPimiTasksHref(options: PimiTasksRouteOptions = {}): Href {
  const params = new URLSearchParams();
  if (options.serverId) params.set("serverId", options.serverId);
  if (options.taskId) params.set("taskId", options.taskId);
  else if (options.newTask) params.set("new", "1");
  const query = params.toString();
  return (query ? `${PIMI_TASKS_ROUTE}?${query}` : PIMI_TASKS_ROUTE) as Href;
}

/** Open the Tasks list, or one task's detail. */
export function openPimiTasks(serverId?: string, taskId?: string): void {
  router.navigate(buildPimiTasksHref({ serverId, taskId }));
}

/**
 * Detail and New task are routes, not component state, so Back, Forward and the mouse buttons walk
 * list -> task -> list the way they do everywhere else. Each push is one history entry.
 */
export function pushPimiTask(serverId: string, taskId: string): void {
  router.push(buildPimiTasksHref({ serverId, taskId }));
}

export function pushNewPimiTask(serverId?: string): void {
  router.push(buildPimiTasksHref({ serverId, newTask: true }));
}

/** Closing a sheet is Back; with no history behind it (a deep link), it returns to the list. */
export function closePimiTaskSheet(): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(buildPimiTasksHref());
}
