import { Redirect, useLocalSearchParams } from "expo-router";
import { PimiTasksScreen } from "@/screens/pimi-tasks-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { isPimiAndroid } from "@/utils/pimi-mobile";

export default function PimiTasksRoute() {
  const { serverId, taskId } = useLocalSearchParams<{ serverId?: string; taskId?: string }>();
  if (!isPimiAndroid()) return <Redirect href={buildOpenProjectRoute()} />;
  return (
    <PimiTasksScreen key={JSON.stringify([serverId, taskId])} serverId={serverId} taskId={taskId} />
  );
}
