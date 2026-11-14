import { useLocalSearchParams } from "expo-router";
import { overridable } from "@/extension-points";
import { PimiTasksScreen } from "@/screens/pimi-tasks-screen";

const Tasks = overridable("screen.tasks", PimiTasksScreen, {
  toPlugin: ({ serverId, taskId }) => ({ serverId: serverId ?? null, taskId: taskId ?? null }),
  merge: (core, patch) => ({
    ...core,
    serverId: patch.serverId === undefined ? core.serverId : (patch.serverId ?? undefined),
    taskId: patch.taskId === undefined ? core.taskId : (patch.taskId ?? undefined),
  }),
});

export default function PimiTasksRoute() {
  const {
    serverId,
    taskId,
    new: newTask,
  } = useLocalSearchParams<{
    serverId?: string;
    taskId?: string;
    new?: string;
  }>();
  // No `key`: Detail and New task are the same screen with different params, so the list and its
  // scroll position stay mounted underneath the sheet.
  return <Tasks serverId={serverId} taskId={taskId} newTask={newTask === "1"} />;
}
