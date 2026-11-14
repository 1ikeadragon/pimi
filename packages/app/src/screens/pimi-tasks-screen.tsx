import { LiveBackdrop } from "@/appearance/live/live-backdrop";
import { useIsFocused } from "expo-router/react-navigation";
import { ListChecks, Plus } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ALL_HOSTS_OPTION_ID, type HostPickerHost } from "@/components/hosts/host-picker";
import { MenuHeader } from "@/components/headers/menu-header";
import { TaskQuickAdd } from "@/components/tasks/task-quick-add";
import { TaskSheet } from "@/components/tasks/task-sheet";
import { TasksBoard } from "@/components/tasks/tasks-board";
import { TasksList } from "@/components/tasks/tasks-list";
import { TasksToolbar, type LabelFilterOption } from "@/components/tasks/tasks-toolbar";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useTaskMutations } from "@/hooks/use-task-mutations";
import { useTasks, type AggregatedTask } from "@/hooks/use-tasks";
import { useTranslation } from "@/i18n/use-translation";
import { useLabelIndex } from "@/labels";
import { closePimiTaskSheet, pushNewPimiTask } from "@/navigation/pimi-tasks";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { boardColumns, filterTasks, groupTasks, type TaskBucket } from "@/tasks/task-view-model";
import { useTasksViewStore } from "@/tasks/tasks-view-store";
import { useChatDirectory, type TaskChatDirectory } from "@/tasks/use-chat-directory";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedListChecks = withUnistyles(ListChecks);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EMPTY_TASKS: AggregatedTask[] = [];

// Scroll position survives leaving the screen for a chat and coming back through history.
const PIMI_BACKGROUND = { "pimi-background": "" };

let lastScrollY = 0;

interface PimiTasksScreenProps {
  serverId?: string;
  taskId?: string;
  /** Opens the New task sheet. */
  newTask?: boolean;
}

export function PimiTasksScreen(props: PimiTasksScreenProps): ReactElement {
  const { t } = useTranslation();
  const isFocused = useIsFocused();
  return (
    <View style={styles.container} dataSet={PIMI_BACKGROUND} testID="pimi-tasks-screen">
      <LiveBackdrop />
      <MenuHeader title={t("tasks.title")} inPimiTitlebar />
      <TasksContent {...props} sheetsAllowed={isFocused} />
    </View>
  );
}

function useHostPickerHosts(): HostPickerHost[] {
  const hosts = useHosts();
  return useMemo(
    () => hosts.map((host) => ({ serverId: host.serverId, label: host.label })),
    [hosts],
  );
}

function TasksContent({
  serverId: routeServerId,
  taskId,
  newTask,
  sheetsAllowed,
}: PimiTasksScreenProps & { sheetsAllowed: boolean }): ReactElement {
  const hosts = useHostPickerHosts();
  const { loadState, hostErrors, connectingHosts, isError, refetch } = useTasks();
  const { directory, chats } = useChatDirectory();
  const tasks = loadState.status === "loaded" ? loadState.data : EMPTY_TASKS;

  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  useEffect(() => {
    if (selectedHost !== ALL_HOSTS_OPTION_ID && !serverIds.includes(selectedHost)) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [selectedHost, serverIds]);
  const hostFilter = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;

  // The host a quick-added or new task lands on: the filtered host, else the first one online.
  const defaultServerId = useMemo(() => {
    if (hostFilter) return hostFilter;
    return serverIds.find((id) => statuses.get(id) === "online") ?? serverIds[0] ?? "";
  }, [hostFilter, serverIds, statuses]);

  const sheet = useTaskSheetRoute({
    taskId,
    routeServerId,
    tasks,
    loaded: loadState.status === "loaded",
  });
  const createServerId =
    routeServerId && serverIds.includes(routeServerId) ? routeServerId : defaultServerId;
  const sheetOpen = sheetsAllowed && (Boolean(newTask) || Boolean(sheet));

  const openNew = useCallback(() => pushNewPimiTask(hostFilter ?? undefined), [hostFilter]);

  let body: ReactElement;
  if (loadState.status !== "loaded") {
    body = isError ? (
      <TasksLoadError onRetry={refetch} />
    ) : (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (tasks.length === 0) {
    body = <TasksEmpty onNew={openNew} />;
  } else {
    body = (
      <TasksBody
        tasks={tasks}
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        hostFilter={hostFilter}
        defaultServerId={defaultServerId}
        directory={directory}
        hostErrors={hostErrors.map((error) => error.serverName)}
        connectingHostNames={connectingHosts.map((host) => host.serverName)}
        onNewTask={openNew}
      />
    );
  }

  return (
    <>
      {body}
      <TaskSheet
        visible={sheetOpen}
        task={sheet}
        createServerId={createServerId}
        hosts={hosts}
        chats={chats}
        directory={directory}
        onClose={closePimiTaskSheet}
      />
    </>
  );
}

/**
 * `?taskId=` is the detail sheet. A task that no longer exists closes it with a message, once.
 */
function useTaskSheetRoute(input: {
  taskId: string | undefined;
  routeServerId: string | undefined;
  tasks: readonly AggregatedTask[];
  loaded: boolean;
}): AggregatedTask | null {
  const { t } = useTranslation();
  const toast = useToast();
  const { taskId, routeServerId, tasks, loaded } = input;
  const task = useMemo(() => {
    if (!taskId) return null;
    return (
      tasks.find(
        (candidate) =>
          candidate.id === taskId && (!routeServerId || candidate.serverId === routeServerId),
      ) ?? null
    );
  }, [routeServerId, taskId, tasks]);
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (!taskId || !loaded || task || warned.current === taskId) return;
    warned.current = taskId;
    toast.error(t("tasks.errors.notFound"));
    closePimiTaskSheet();
  }, [loaded, t, task, taskId, toast]);
  return task;
}

function TasksLoadError({ onRetry }: { onRetry: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.centered}>
      <Text style={styles.message}>{t("tasks.errors.load")}</Text>
      <Button variant="ghost" onPress={onRetry} testID="tasks-retry">
        {t("tasks.errors.retry")}
      </Button>
    </View>
  );
}

function TasksEmpty({ onNew }: { onNew: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.centered}>
      <View style={styles.emptyState} testID="tasks-empty">
        <ThemedListChecks size={24} uniProps={mutedMapping} />
        <View style={styles.emptyText}>
          <Text style={styles.emptyTitle}>{t("tasks.empty.title")}</Text>
          <Text style={styles.emptyDescription}>{t("tasks.empty.description")}</Text>
        </View>
        <Button variant="outline" leftIcon={Plus} onPress={onNew} testID="tasks-empty-new">
          {t("tasks.newTask")}
        </Button>
      </View>
    </View>
  );
}

function buildLabelOptions(
  labelIndex: ReturnType<typeof useLabelIndex>,
  hosts: readonly HostPickerHost[],
): LabelFilterOption[] {
  const hostNames = new Map(hosts.map((host) => [host.serverId, host.label]));
  const options: LabelFilterOption[] = [];
  for (const [serverId, index] of labelIndex) {
    for (const label of index.labels) {
      options.push({ serverId, label, hostLabel: hostNames.get(serverId) ?? serverId });
    }
  }
  return options;
}

function emptyFilterKey(labelFiltered: boolean, bucket: TaskBucket): string {
  if (labelFiltered) return "tasks.empty.labelFilter";
  return bucket === "done" ? "tasks.empty.done" : "tasks.empty.open";
}

function TasksBody({
  tasks,
  hosts,
  selectedHost,
  onSelectHost,
  hostFilter,
  defaultServerId,
  directory,
  hostErrors,
  connectingHostNames,
  onNewTask,
}: {
  tasks: readonly AggregatedTask[];
  hosts: readonly HostPickerHost[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  hostFilter: string | null;
  defaultServerId: string;
  directory: TaskChatDirectory;
  hostErrors: readonly string[];
  connectingHostNames: readonly string[];
  onNewTask: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const viewMode = useTasksViewStore((state) => state.viewMode);
  const groupBy = useTasksViewStore((state) => state.groupBy);
  const setViewMode = useTasksViewStore((state) => state.setViewMode);
  const setGroupBy = useTasksViewStore((state) => state.setGroupBy);
  const [bucket, setBucket] = useState<TaskBucket>("open");
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const showHost = hosts.length > 1;

  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const labelIndex = useLabelIndex(serverIds);
  const labelOptions = useMemo(() => buildLabelOptions(labelIndex, hosts), [hosts, labelIndex]);

  const filtered = useMemo(
    () =>
      filterTasks({
        tasks,
        selectedHost: hostFilter,
        bucket: viewMode === "board" ? "all" : bucket,
        labelFilter,
        labelIndex,
      }),
    [bucket, hostFilter, labelFilter, labelIndex, tasks, viewMode],
  );
  const groups = useMemo(
    () => groupTasks({ tasks: filtered, groupBy, bucket, labelIndex }),
    [bucket, filtered, groupBy, labelIndex],
  );
  const columns = useMemo(() => boardColumns(filtered), [filtered]);

  const quickAddMutations = useTaskMutations({ serverId: defaultServerId });
  const handleQuickAdd = useCallback(
    async (title: string) => {
      try {
        await quickAddMutations.createTask({ title, status: "todo" });
      } catch (error) {
        toast.error(toErrorMessage(error) || t("tasks.errors.mutate"));
        throw error;
      }
    },
    [quickAddMutations, t, toast],
  );

  const scrollRef = useRef<ScrollView>(null);
  const restoredScroll = useRef(false);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    lastScrollY = event.nativeEvent.contentOffset.y;
  }, []);
  const handleContentSize = useCallback(() => {
    if (restoredScroll.current) return;
    restoredScroll.current = true;
    if (lastScrollY > 0) scrollRef.current?.scrollTo({ y: lastScrollY, animated: false });
  }, []);

  const showQuickAdd = viewMode === "list" && bucket === "open" && labelFilter.length === 0;
  return (
    <View style={styles.body}>
      <TasksToolbar
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={onSelectHost}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        bucket={bucket}
        onBucketChange={setBucket}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        labelOptions={labelOptions}
        labelFilter={labelFilter}
        onLabelFilterChange={setLabelFilter}
        onNewTask={onNewTask}
      />
      {connectingHostNames.length > 0 ? (
        <Text style={styles.connectingNote} testID="tasks-connecting-hosts">
          {`${t("tasks.errors.connecting", { count: connectingHostNames.length })} · ${connectingHostNames.join(", ")}`}
        </Text>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        scrollEventThrottle={32}
        onContentSizeChange={handleContentSize}
        testID="tasks-scroll"
      >
        {hostErrors.length > 0 ? (
          <View style={styles.pad}>
            <View style={styles.errorsBanner} testID="tasks-host-errors">
              {hostErrors.map((name) => (
                <Text key={name} style={styles.errorsText}>
                  {t("tasks.errors.host", { host: name })}
                </Text>
              ))}
            </View>
          </View>
        ) : null}
        {showQuickAdd ? (
          <View style={styles.pad}>
            <TaskQuickAdd onSubmit={handleQuickAdd} testID="tasks-quick-add" />
          </View>
        ) : null}
        {viewMode === "board" ? (
          <TasksBoard columns={columns} directory={directory} showHost={showHost} />
        ) : (
          <View style={styles.pad}>
            {groups.length > 0 ? (
              <TasksList groups={groups} directory={directory} showHost={showHost} />
            ) : (
              <View style={styles.filterEmpty} testID="tasks-filter-empty">
                <Text style={styles.emptyTitle}>
                  {t(emptyFilterKey(labelFilter.length > 0, bucket))}
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: { flex: 1, minHeight: 0 },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  pad: { paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] } },
  connectingNote: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsText: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  filterEmpty: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: { alignItems: "center", gap: theme.spacing[4], maxWidth: 420, width: "100%" },
  emptyText: { alignItems: "center", gap: theme.spacing[2] },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  spinner: { color: theme.colors.foregroundMuted },
}));
