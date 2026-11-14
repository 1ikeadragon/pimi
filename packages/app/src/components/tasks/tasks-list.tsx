import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TaskGroupHeading } from "@/components/tasks/task-group-heading";
import { TaskListItem } from "@/components/tasks/task-item";
import { settingsStyles } from "@/styles/settings";
import type { TaskGroup } from "@/tasks/task-view-model";
import type { TaskChatDirectory } from "@/tasks/use-chat-directory";

/** Groups as headings over settings-style cards, the Automations list's shape. */
export function TasksList({
  groups,
  directory,
  showHost,
}: {
  groups: readonly TaskGroup[];
  directory: TaskChatDirectory;
  showHost: boolean;
}): ReactElement {
  return (
    <View style={styles.groups} testID="tasks-list-groups">
      {groups.map((group) => (
        <View key={group.id} style={styles.group}>
          <TaskGroupHeading group={group} />
          <View style={settingsStyles.card}>
            {group.tasks.map((task, index) => (
              <TaskListItem
                key={`${task.serverId}:${task.id}`}
                task={task}
                directory={directory}
                isFirst={index === 0}
                showHost={showHost}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  groups: { gap: theme.spacing[6] },
  group: {},
}));
