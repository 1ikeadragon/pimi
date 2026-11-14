import { GitPullRequestDraft } from "lucide-react-native";
import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskPullRequest, TaskPullRequestState } from "@pimi/protocol/task/types";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isNative } from "@/constants/platform";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { useTranslation } from "@/i18n/use-translation";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedDraft = withUnistyles(GitPullRequestDraft);
const mutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ICON_SIZE = 14;

/** Open, merged and closed reuse the shared PR glyphs; draft and unknown are muted. */
export function TaskPullRequestIcon({
  state,
  size = ICON_SIZE,
}: {
  state: TaskPullRequestState;
  size?: number;
}): ReactElement {
  if (state === "draft" || state === "unknown") {
    return <ThemedDraft size={size} uniProps={mutedMapping} />;
  }
  return <PullRequestStateIcon state={state} size={size} />;
}

export function usePullRequestLabel(): (pr: TaskPullRequest) => string {
  const { t } = useTranslation();
  return useCallback(
    (pr) => {
      const name = pr.number === undefined ? t("tasks.pr.generic") : `#${pr.number}`;
      return t("tasks.pr.open", {
        name,
        state: t(`tasks.pr.state.${pr.state}`),
      });
    },
    [t],
  );
}

function triggerStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, hovered && styles.triggerHovered];
}

function PullRequestItem({ pr, testID }: { pr: TaskPullRequest; testID: string }): ReactElement {
  const select = useCallback(() => void openExternalUrl(pr.url), [pr.url]);
  const label = usePullRequestLabel();
  const leading = useMemo(() => <TaskPullRequestIcon state={pr.state} />, [pr.state]);
  return (
    <DropdownMenuItem leading={leading} onSelect={select} testID={testID}>
      {pr.number === undefined ? label(pr) : `#${pr.number} ${pr.title}`.trim()}
    </DropdownMenuItem>
  );
}

/** One pull request line for the task sheet: state icon, name and title. Opens the PR. */
export function TaskPullRequestRow({
  pr,
  testID,
}: {
  pr: TaskPullRequest;
  testID: string;
}): ReactElement {
  const open = useCallback(() => void openExternalUrl(pr.url), [pr.url]);
  const label = usePullRequestLabel();
  return (
    <PressHighlight
      onPress={open}
      style={triggerStyle}
      accessibilityRole={isNative ? "link" : "none"}
      accessibilityLabel={label(pr)}
      testID={testID}
    >
      <TaskPullRequestIcon state={pr.state} />
      <Text style={styles.rowText} numberOfLines={1}>
        {pr.number === undefined ? "" : `#${pr.number} `}
        {pr.title}
      </Text>
    </PressHighlight>
  );
}

/**
 * The task's pull requests as one small state icon. One PR opens directly; several open a menu.
 * Sits beside the chat chips, never under the row's press layer.
 */
export const TaskPullRequests = memo(function TaskPullRequests({
  task,
}: {
  task: { id: string; pullRequests: readonly TaskPullRequest[] };
}): ReactElement | null {
  const { t } = useTranslation();
  const label = usePullRequestLabel();
  const [first] = task.pullRequests;
  const openFirst = useCallback(() => {
    if (first) void openExternalUrl(first.url);
  }, [first]);
  if (!first) return null;
  const testID = `task-pr-${task.id}`;
  if (task.pullRequests.length === 1) {
    return (
      <PressHighlight
        onPress={openFirst}
        style={triggerStyle}
        accessibilityRole={isNative ? "link" : "none"}
        accessibilityLabel={label(first)}
        testID={testID}
      >
        <View pointerEvents="none">
          <TaskPullRequestIcon state={first.state} />
        </View>
      </PressHighlight>
    );
  }
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t("tasks.pr.many", {
          count: task.pullRequests.length,
        })}
        testID={testID}
      >
        <TaskPullRequestIcon state={first.state} />
        <Text style={styles.count}>{task.pullRequests.length}</Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={280} sheetTitle={t("tasks.pr.title")}>
        {task.pullRequests.map((pr) => (
          <PullRequestItem key={pr.url} pr={pr} testID={`${testID}-${pr.number ?? pr.url}`} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    marginHorizontal: -theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  triggerHovered: { backgroundColor: theme.colors.surface3 },
  rowText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
