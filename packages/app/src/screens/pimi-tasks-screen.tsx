import { useIsFocused } from "expo-router/react-navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BackHandler, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  PIMI_TASK_PAGE_SIZE,
  PimiTaskFields,
  type PimiMobileTaskDetail,
} from "@getpaseo/protocol/pimi-task";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useFetchQuery } from "@/data/query";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useHostChooser } from "@/hosts/host-chooser";
import { openPimiTasks } from "@/navigation/pimi-tasks";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";

const stageLabels = {
  backlog: "To do",
  ready: "Ready",
  "in-progress": "In progress",
  review: "Review",
  done: "Done",
} as const;
type TaskStage = PimiMobileTaskDetail["stage"];
const stages = [null, ...(Object.keys(stageLabels) as (keyof typeof stageLabels)[])];
const taskDraftSchema = PimiTaskFields.pick({ title: true, brief: true });
const TASK_LIST_POLL_INTERVAL_MS = 10_000;

export function PimiTasksScreen({ serverId, taskId }: { serverId?: string; taskId?: string }) {
  const focused = useIsFocused();
  const hosts = useHosts();
  const chooseHost = useHostChooser();
  const selectedHost = serverId
    ? hosts.find((host) => host.serverId === serverId)
    : hosts.find((host) => host.connections.some(({ type }) => type === "relay"));
  const client = useHostRuntimeClient(selectedHost?.serverId ?? "");
  const connected = useHostRuntimeIsConnected(selectedHost?.serverId ?? "");
  const chooseTasksHost = useCallback(() => {
    chooseHost({
      title: "Choose a Tasks host",
      filter: (host) => host.connections.some(({ type }) => type === "relay"),
      onChooseHost: (chosenServerId) => openPimiTasks(chosenServerId),
    });
  }, [chooseHost]);

  let content: ReactNode = null;
  if (!selectedHost) {
    content = <Text style={styles.meta}>Pair with Pimi Desktop to open its task board.</Text>;
  } else if (!client || !connected) {
    content = <Text style={styles.meta}>Connect to {selectedHost.label} to load Tasks.</Text>;
  } else if (focused) {
    content = (
      <ConnectedTasks
        key={selectedHost.serverId}
        client={client}
        serverId={selectedHost.serverId}
        taskId={taskId}
      />
    );
  }

  return (
    <View style={styles.screen} testID="pimi-tasks-screen">
      <MenuHeader title="Tasks" />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Button variant="outline" style={styles.start} onPress={chooseTasksHost}>
          {selectedHost?.label ?? "Pair a host"}
        </Button>
        {content}
      </ScrollView>
    </View>
  );
}

type TaskView = { kind: "list" } | { kind: "task"; id: string } | { kind: "new" };

function ConnectedTasks({
  client,
  serverId,
  taskId,
}: {
  client: DaemonClient;
  serverId: string;
  taskId?: string;
}) {
  const [view, setView] = useState<TaskView>(() =>
    taskId ? { kind: "task", id: taskId } : { kind: "list" },
  );
  const showList = useCallback(() => setView({ kind: "list" }), []);
  const openTask = useCallback((id: string) => setView({ kind: "task", id }), []);
  const newTask = useCallback(() => setView({ kind: "new" }), []);

  useEffect(() => {
    if (view.kind === "list" || (view.kind === "task" && view.id === taskId)) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      showList();
      return true;
    });
    return () => back.remove();
  }, [showList, taskId, view]);

  if (view.kind === "list")
    return <TaskList client={client} serverId={serverId} openTask={openTask} create={newTask} />;
  return (
    <>
      <Button variant="ghost" style={styles.start} onPress={showList}>
        All tasks
      </Button>
      {view.kind === "new" ? (
        <CreateTask client={client} serverId={serverId} onCreated={openTask} />
      ) : (
        <TaskDetail key={view.id} client={client} serverId={serverId} id={view.id} />
      )}
    </>
  );
}

const taskKey = (serverId: string) => ["pimi-mobile-tasks", serverId] as const;

function TaskList({
  client,
  serverId,
  openTask,
  create,
}: {
  client: DaemonClient;
  serverId: string;
  openTask: (id: string) => void;
  create: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const foreground = useAppActivelyVisible();
  const page = useFetchQuery({
    queryKey: [...taskKey(serverId), "page", offset],
    dataShape: "value",
    staleTimeMs: 0,
    enabled: foreground,
    refetchInterval: foreground ? TASK_LIST_POLL_INTERVAL_MS : false,
    queryFn: async () => {
      const result = await client.requestPimiTask({ action: "list", offset });
      if (result.kind !== "page") throw new Error("Pimi Desktop did not return a task page.");
      return result;
    },
    retry: false,
    gcTime: 0,
  });
  const next = page.data?.nextOffset;
  const previousPage = useCallback(() => setOffset(offset - PIMI_TASK_PAGE_SIZE), [offset]);
  const nextPage = useCallback(() => {
    if (next != null) setOffset(next);
  }, [next]);

  return (
    <>
      <Button onPress={create} style={styles.start} disabled={!page.isSuccess}>
        New task
      </Button>
      {page.isPending && <Text style={styles.meta}>Loading tasks…</Text>}
      {page.error && (
        <Text accessibilityRole="alert" style={styles.meta}>
          {page.error.message}
        </Text>
      )}
      {page.data?.tasks.length === 0 && <Text style={styles.meta}>No tasks on this page.</Text>}
      {page.data?.tasks.map(({ id, title, stage }) => (
        <TaskRow key={id} id={id} title={title} stage={stage} openTask={openTask} />
      ))}
      {(offset > 0 || next != null) && (
        <View style={styles.actions}>
          <Button variant="outline" disabled={offset === 0} onPress={previousPage}>
            Previous
          </Button>
          <Button variant="outline" disabled={next == null} onPress={nextPage}>
            Next
          </Button>
        </View>
      )}
    </>
  );
}

function TaskRow({
  id,
  title,
  stage,
  openTask,
}: {
  id: string;
  title: string;
  stage: TaskStage;
  openTask: (id: string) => void;
}) {
  const onPress = useCallback(() => openTask(id), [id, openTask]);
  return (
    <Button variant="outline" style={styles.task} onPress={onPress}>
      {title}
      {stage ? ` · ${stageLabels[stage]}` : ""}
    </Button>
  );
}

function CreateTask({
  client,
  serverId,
  onCreated,
}: {
  client: DaemonClient;
  serverId: string;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [id] = useState(randomUUID);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const {
    mutate: create,
    error,
    isPending,
  } = useMutation({
    gcTime: 0,
    mutationFn: async (fields: { title: string; brief: string }) => {
      const result = await client.requestPimiTask({ action: "create", id, ...fields });
      if (result.kind !== "task") throw new Error("Pimi Desktop did not return the saved task.");
      return result.task;
    },
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: taskKey(serverId) });
      onCreated(task.id);
    },
  });
  const draft = taskDraftSchema.safeParse({ title, brief });
  const save = useCallback(() => {
    const parsed = taskDraftSchema.safeParse({ title, brief });
    if (parsed.success) create(parsed.data);
  }, [brief, create, title]);
  return (
    <>
      <Text style={styles.title}>New task</Text>
      <Field label="Title">
        <FormTextInput accessibilityLabel="Title" onChangeText={setTitle} editable={!isPending} />
      </Field>
      <Field label="Brief">
        <FormTextInput
          accessibilityLabel="Brief"
          style={styles.briefInput}
          onChangeText={setBrief}
          multiline
          editable={!isPending}
        />
      </Field>
      {!draft.success && (title || brief) ? (
        <Text style={styles.meta}>
          Enter a title up to 100 characters and a brief up to 2,400 characters.
        </Text>
      ) : null}
      {error && (
        <Text accessibilityRole="alert" style={styles.meta}>
          {error.message}
        </Text>
      )}
      <Button style={styles.start} disabled={!draft.success || isPending} onPress={save}>
        Save task
      </Button>
    </>
  );
}

function TaskDetail({
  client,
  serverId,
  id,
}: {
  client: DaemonClient;
  serverId: string;
  id: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = [...taskKey(serverId), "detail", id];
  const detail = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      const result = await client.requestPimiTask({ action: "get", id });
      if (result.kind !== "task") throw new Error("Pimi Desktop did not return the task.");
      return result.task;
    },
    retry: false,
    gcTime: 0,
  });
  const { refetch } = detail;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const change = useMutation({
    gcTime: 0,
    mutationFn: async (stage: TaskStage) => {
      const result = await client.requestPimiTask({ action: "set-stage", id, stage });
      if (result.kind !== "task") throw new Error("Pimi Desktop did not return the updated task.");
      return result.task;
    },
    onSuccess: (task) => {
      queryClient.setQueryData(queryKey, task);
      void queryClient.invalidateQueries({ queryKey: [...taskKey(serverId), "page"] });
    },
  });
  const task = detail.data;
  if (!task)
    return (
      <>
        <Text accessibilityRole={detail.error ? "alert" : undefined} style={styles.meta}>
          {detail.error?.message ?? "Loading task…"}
        </Text>
        {detail.error && (
          <Button variant="outline" style={styles.start} onPress={retry}>
            Retry
          </Button>
        )}
      </>
    );
  return (
    <>
      <Text accessibilityRole="header" style={styles.title}>
        {task.title}
      </Text>
      <Text selectable style={styles.brief}>
        {task.brief}
      </Text>
      <Text style={styles.meta}>Board stage</Text>
      <View style={styles.actions}>
        {stages.map((stage) => (
          <StageButton
            key={stage ?? "automatic"}
            stage={stage}
            selected={task.stage === stage}
            busy={change.isPending}
            onChange={change.mutate}
          />
        ))}
      </View>
      {change.error && (
        <Text accessibilityRole="alert" style={styles.meta}>
          {change.error.message}
        </Text>
      )}
    </>
  );
}

function StageButton({
  stage,
  selected,
  busy,
  onChange,
}: {
  stage: TaskStage;
  selected: boolean;
  busy: boolean;
  onChange: (stage: TaskStage) => void;
}) {
  const onPress = useCallback(() => onChange(stage), [onChange, stage]);
  return (
    <Button
      variant={selected ? "secondary" : "outline"}
      size="sm"
      disabled={selected || busy}
      onPress={onPress}
    >
      {stage ? stageLabels[stage] : "Automatic"}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: { padding: theme.spacing[4], paddingBottom: theme.spacing[8], gap: theme.spacing[3] },
  start: { alignSelf: "flex-start" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  task: { justifyContent: "flex-start" },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "600" },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  brief: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  briefInput: { minHeight: 108, textAlignVertical: "top" },
}));
