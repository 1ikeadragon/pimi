import { overridable } from "@/extension-points";
import { Redirect, useLocalSearchParams } from "expo-router";
import { PimiTasksScreen } from "@/screens/pimi-tasks-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { isPimiAndroid } from "@/utils/pimi-mobile";

const Tasks = overridable("screen.tasks", PimiTasksScreen, {
  toPlugin: ({ serverId, taskId }) => ({ serverId: serverId ?? null, taskId: taskId ?? null }),
  merge: (core, patch) => ({
    serverId: patch.serverId === undefined ? core.serverId : (patch.serverId ?? undefined),
    taskId: patch.taskId === undefined ? core.taskId : (patch.taskId ?? undefined),
  }),
});

export default function PimiTasksRoute() {
  const { serverId, taskId } = useLocalSearchParams<{ serverId?: string; taskId?: string }>();
  if (!isPimiAndroid()) return <Redirect href={buildOpenProjectRoute()} />;
  return <Tasks key={JSON.stringify([serverId, taskId])} serverId={serverId} taskId={taskId} />;
}
