import { Tag, X } from "lucide-react-native";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskStatus } from "@pimi/protocol/task/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { TaskChatChip } from "@/components/tasks/task-chat-chip";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useTaskMutations } from "@/hooks/use-task-mutations";
import { useToast } from "@/contexts/toast-context";
import { useTranslation } from "@/i18n/use-translation";
import { LABEL_PAGE_ID, LabelChips, useLabelMenuPages } from "@/labels";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";
import { TaskFormModel } from "@/tasks/task-form-model";
import { BOARD_STATUSES } from "@/tasks/task-view-model";
import { startTaskChat } from "@/tasks/start-task-chat";
import type { TaskChat, TaskChatDirectory } from "@/tasks/use-chat-directory";
import { chatKey, linkedChatId } from "@/tasks/use-chat-directory";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import type { Theme } from "@/styles/theme";
import { resolveTaskChats } from "@/components/tasks/task-item";

const ThemedTag = withUnistyles(Tag);
const ThemedX = withUnistyles(X);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface TaskSheetHost {
  serverId: string;
  label: string;
}

interface TaskSheetProps {
  visible: boolean;
  /** Present when editing; absent for a new task. */
  task: AggregatedTask | null;
  /** Host a new task is created on. */
  createServerId: string;
  hosts: readonly TaskSheetHost[];
  chats: readonly TaskChat[];
  directory: TaskChatDirectory;
  onClose: () => void;
}

/**
 * New task and Task detail in one sheet: a modal on desktop, a bottom sheet on compact. Mounted
 * fresh per task so a create never inherits an edit (docs/forms.md, lifecycle rule 1).
 */
export function TaskSheet(props: TaskSheetProps): ReactElement | null {
  const { task } = props;
  return <TaskSheetForm key={task ? `edit:${task.serverId}:${task.id}` : "create"} {...props} />;
}

function TaskSheetForm({
  visible,
  task,
  createServerId,
  hosts,
  chats,
  directory,
  onClose,
}: TaskSheetProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const mode = task ? "edit" : "create";
  const [model] = useState(() =>
    task ? TaskFormModel.edit(task) : TaskFormModel.create({ serverId: createServerId }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [pending, setPending] = useState(false);
  const mutations = useTaskMutations({ serverId: state.serverId });
  const descriptionRef = useRef<EditingTextInputHandle>(null);

  // Input plumbing: the daemon fills an empty description while the sheet is open.
  const remoteDescription = task?.description;
  useEffect(() => {
    if (remoteDescription !== undefined) model.applyRemote({ description: remoteDescription });
  }, [model, remoteDescription]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t(mode === "create" ? "tasks.sheet.newTitle" : "tasks.sheet.editTitle") }),
    [mode, t],
  );

  const submit = useCallback(async () => {
    if (pending || !model.validate()) return;
    const values = model.getState();
    setPending(true);
    try {
      if (task) {
        await mutations.updateTask(task.id, {
          title: values.title.trim(),
          description: values.description,
          status: values.status,
        });
        model.markSaved();
      } else {
        await mutations.createTask({
          title: values.title.trim(),
          description: values.description,
          status: values.status,
          links: values.chatIds.map((agentId) => ({
            kind: "agent" as const,
            agentId,
            role: "linked" as const,
          })),
        });
      }
      onClose();
    } catch (error) {
      toast.error(toErrorMessage(error) || t("tasks.errors.mutate"));
    } finally {
      setPending(false);
    }
  }, [model, mutations, onClose, pending, t, task, toast]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  const handleDelete = useCallback(() => {
    if (!task) return;
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("tasks.delete.title"),
        message: t("tasks.delete.message", { title: task.title }),
        confirmLabel: t("tasks.delete.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await mutations.deleteTask(task.id);
        onClose();
      } catch (error) {
        toast.error(toErrorMessage(error) || t("tasks.errors.mutate"));
      }
    })();
  }, [mutations, onClose, t, task, toast]);

  const handleStartChat = useCallback(() => {
    if (!task) return;
    startTaskChat({
      serverId: task.serverId,
      task: { title: state.title.trim() || task.title, description: state.description },
      link: (agentId) => mutations.setTaskLink(task.id, { kind: "agent", agentId }, true),
    });
  }, [mutations, state.description, state.title, task]);

  const focusDescription = useCallback(() => descriptionRef.current?.focus(), []);
  const handleTitleChange = useCallback((text: string) => model.setTitle(text), [model]);
  const handleDescriptionChange = useCallback(
    (text: string) => model.setDescription(text),
    [model],
  );
  const handleStatusChange = useCallback((status: TaskStatus) => model.setStatus(status), [model]);
  const handleHostChange = useCallback((id: string) => model.setHost(id), [model]);
  const handleAddCreateChat = useCallback((agentId: string) => model.addChat(agentId), [model]);
  const handleRemoveCreateChat = useCallback(
    (agentId: string) => model.removeChat(agentId),
    [model],
  );
  const generating = useMemo(
    () =>
      task?.descriptionPending ? (
        <View style={styles.generating} testID="task-sheet-generating">
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      ) : undefined,
    [task?.descriptionPending],
  );

  const statusOptions = useMemo(
    () =>
      BOARD_STATUSES.map((status) => ({
        value: status,
        label: t(`tasks.status.${status}`),
        testID: `task-sheet-status-${status}`,
      })),
    [t],
  );

  const footer = useMemo(
    () => (
      <TaskSheetFooter
        mode={mode}
        hasTask={task !== null}
        canSubmit={state.canSubmit}
        pending={pending}
        onDelete={handleDelete}
        onCancel={onClose}
        onSubmit={handleSubmit}
      />
    ),
    [handleDelete, handleSubmit, mode, onClose, pending, state.canSubmit, task],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={560}
      snapPoints={isCompact ? ["90%"] : undefined}
      testID="task-sheet"
    >
      <View style={styles.body}>
        {mode === "create" && hosts.length > 1 ? (
          <HostField hosts={hosts} serverId={state.serverId} onChange={handleHostChange} />
        ) : null}
        <Field
          label={t("tasks.sheet.titleLabel")}
          error={state.titleError ? t("tasks.sheet.titleRequired") : null}
          testID="task-sheet-title-field"
        >
          <FormTextInput
            initialValue={state.title}
            onChangeText={handleTitleChange}
            placeholder={t("tasks.sheet.titlePlaceholder")}
            autoFocus={mode === "create"}
            returnKeyType="next"
            onSubmitEditing={focusDescription}
            editable={!pending}
            accessibilityLabel={t("tasks.sheet.titleLabel")}
            testID="task-sheet-title"
          />
        </Field>
        <Field
          label={t("tasks.sheet.descriptionLabel")}
          trailing={generating}
          testID="task-sheet-description-field"
        >
          <FormTextInput
            ref={descriptionRef}
            initialValue={state.description}
            resetKey={state.descriptionVersion}
            onChangeText={handleDescriptionChange}
            placeholder={
              task?.descriptionPending
                ? t("tasks.sheet.generating")
                : t("tasks.sheet.descriptionPlaceholder")
            }
            multiline
            style={styles.description}
            editable={!pending}
            accessibilityLabel={t("tasks.sheet.descriptionLabel")}
            testID="task-sheet-description"
          />
        </Field>
        <Field label={t("tasks.sheet.statusLabel")}>
          <SegmentedControl
            value={state.status}
            onValueChange={handleStatusChange}
            options={statusOptions}
            testID="task-sheet-status"
          />
        </Field>
        {task ? <LabelsField task={task} /> : null}
        <ChatsField
          mode={mode}
          task={task}
          serverId={state.serverId}
          chatIds={state.chatIds}
          chats={chats}
          directory={directory}
          onAddCreateChat={handleAddCreateChat}
          onRemoveCreateChat={handleRemoveCreateChat}
          onStartChat={handleStartChat}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

function TaskSheetFooter({
  mode,
  hasTask,
  canSubmit,
  pending,
  onDelete,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "edit";
  hasTask: boolean;
  canSubmit: boolean;
  pending: boolean;
  onDelete: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.footer}>
      {hasTask ? (
        <Button variant="ghost" onPress={onDelete} disabled={pending} testID="task-sheet-delete">
          {t("tasks.menu.delete")}
        </Button>
      ) : (
        <View />
      )}
      <View style={styles.footerEnd}>
        <Button variant="ghost" onPress={onCancel} disabled={pending} testID="task-sheet-cancel">
          {t("tasks.sheet.cancel")}
        </Button>
        <Button
          onPress={onSubmit}
          disabled={!canSubmit || pending}
          loading={pending}
          testID="task-sheet-submit"
        >
          {t(mode === "create" ? "tasks.sheet.create" : "tasks.sheet.save")}
        </Button>
      </View>
    </View>
  );
}

function LinkedChatRow({
  chat,
  onRemove,
}: {
  chat: TaskChat;
  onRemove: (chat: TaskChat) => void;
}): ReactElement {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(chat), [chat, onRemove]);
  return (
    <View style={styles.chatRow}>
      <View style={styles.chatChip}>
        <TaskChatChip chat={chat} testID={`task-sheet-chat-${chat.agentId}`} />
      </View>
      <ToolbarButton
        label={t("tasks.sheet.unlinkChat", { title: chat.title })}
        onPress={remove}
        testID={`task-sheet-unlink-${chat.agentId}`}
      >
        <ThemedX size={14} uniProps={mutedMapping} />
      </ToolbarButton>
    </View>
  );
}

function HostField({
  hosts,
  serverId,
  onChange,
}: {
  hosts: readonly TaskSheetHost[];
  serverId: string;
  onChange: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SelectFieldOption<string>[]>(
    () => hosts.map((host) => ({ id: host.serverId, value: host.serverId, label: host.label })),
    [hosts],
  );
  const selectedDisplay = useMemo(() => {
    const selected = hosts.find((host) => host.serverId === serverId);
    return selected ? { label: selected.label } : null;
  }, [hosts, serverId]);
  const handleChange = useCallback((value: string) => onChange(value), [onChange]);
  return (
    <SelectField
      label={t("tasks.sheet.hostLabel")}
      value={serverId}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleChange}
      placeholder={t("tasks.sheet.hostPlaceholder")}
      emptyText={t("tasks.sheet.hostEmpty")}
      testID="task-sheet-host"
    />
  );
}

function LabelsField({ task }: { task: AggregatedTask }): ReactElement {
  const { t } = useTranslation();
  const target = useMemo(() => ({ kind: "task" as const, taskId: task.id }), [task.id]);
  const pages = useLabelMenuPages(task.serverId, target);
  return (
    <Field label={t("tasks.sheet.labelsLabel")} testID="task-sheet-labels-field">
      <View style={styles.inlineRow}>
        <View style={styles.inlineGrow}>
          <LabelChips serverId={task.serverId} target={target} />
        </View>
        <DropdownMenu compactMode="sheet">
          <DropdownMenuTrigger
            style={styles.addTrigger}
            accessibilityRole={isNative ? "button" : undefined}
            accessibilityLabel={t("tasks.sheet.addLabels")}
            testID="task-sheet-labels-trigger"
          >
            <ThemedTag size={14} uniProps={mutedMapping} />
            <Text style={styles.addText}>{t("tasks.sheet.addLabels")}</Text>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            width={220}
            pages={pages}
            sheetTitle={t("tasks.sheet.labelsLabel")}
          >
            <DropdownMenuSubTrigger id={LABEL_PAGE_ID} testID="task-sheet-labels-page">
              {t("tasks.menu.labels")}
            </DropdownMenuSubTrigger>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </Field>
  );
}

function ChatsField({
  mode,
  task,
  serverId,
  chatIds,
  chats,
  directory,
  onAddCreateChat,
  onRemoveCreateChat,
  onStartChat,
}: {
  mode: "create" | "edit";
  task: AggregatedTask | null;
  serverId: string;
  chatIds: readonly string[];
  chats: readonly TaskChat[];
  directory: TaskChatDirectory;
  onAddCreateChat: (agentId: string) => void;
  onRemoveCreateChat: (agentId: string) => void;
  onStartChat: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useTaskMutations({ serverId });

  const linked = useMemo<TaskChat[]>(() => {
    if (task) return resolveTaskChats(task, directory);
    return chatIds.flatMap((id) => {
      const chat = directory.get(chatKey(serverId, id));
      return chat ? [chat] : [];
    });
  }, [chatIds, directory, serverId, task]);

  const linkedIds = useMemo(
    () => new Set(task ? task.links.map(linkedChatId) : chatIds),
    [chatIds, task],
  );
  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      chats
        .filter((chat) => chat.serverId === serverId && !linkedIds.has(chat.agentId))
        .map((chat) => ({ id: chat.agentId, value: chat.agentId, label: chat.title })),
    [chats, linkedIds, serverId],
  );

  const addChat = useCallback(
    (agentId: string) => {
      if (mode === "create") {
        onAddCreateChat(agentId);
        return;
      }
      if (!task) return;
      mutations
        .setTaskLink(task.id, { kind: "agent", agentId }, true)
        .catch((error: unknown) => toast.error(toErrorMessage(error) || t("tasks.errors.mutate")));
    },
    [mode, mutations, onAddCreateChat, t, task, toast],
  );

  const removeChat = useCallback(
    (chat: TaskChat) => {
      if (mode === "create") {
        onRemoveCreateChat(chat.agentId);
        return;
      }
      if (!task) return;
      // Unlink every link that resolves to this chat, subagent links included.
      for (const link of task.links) {
        if (linkedChatId(link) !== chat.agentId) continue;
        const target =
          link.kind === "agent"
            ? ({ kind: "agent", agentId: link.agentId } as const)
            : ({
                kind: "subagent",
                parentAgentId: link.parentAgentId,
                subagentId: link.subagentId,
              } as const);
        mutations
          .setTaskLink(task.id, target, false)
          .catch((error: unknown) =>
            toast.error(toErrorMessage(error) || t("tasks.errors.mutate")),
          );
      }
    },
    [mode, mutations, onRemoveCreateChat, t, task, toast],
  );

  return (
    <Field label={t("tasks.sheet.chatsLabel")} testID="task-sheet-chats-field">
      <View style={styles.chats}>
        {linked.length === 0 ? (
          <Text style={styles.empty}>{t("tasks.sheet.noChats")}</Text>
        ) : (
          linked.map((chat) => (
            <LinkedChatRow key={chat.agentId} chat={chat} onRemove={removeChat} />
          ))
        )}
        <View style={styles.chatActions}>
          <View style={styles.inlineGrow}>
            <SelectField
              label={t("tasks.sheet.addChat")}
              field={false}
              value={null}
              selectedDisplay={null}
              options={options}
              onChange={addChat}
              placeholder={t("tasks.sheet.chatPlaceholder")}
              emptyText={t("tasks.sheet.chatEmpty")}
              searchable
              searchPlaceholder={t("tasks.sheet.chatSearch")}
              size="sm"
              testID="task-sheet-add-chat"
              triggerTestID="task-sheet-add-chat-trigger"
            />
          </View>
          {mode === "edit" ? (
            <Button
              variant="outline"
              size="sm"
              onPress={onStartChat}
              testID="task-sheet-start-chat"
            >
              {t("tasks.sheet.startChat")}
            </Button>
          ) : null}
        </View>
      </View>
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  description: { minHeight: 96, textAlignVertical: "top" },
  generating: { flexDirection: "row", alignItems: "center" },
  spinner: { color: theme.colors.foregroundMuted },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  footerEnd: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
  inlineGrow: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  addTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  addText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chats: { gap: theme.spacing[2] },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chatRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  chatChip: { flex: 1, minWidth: 0, flexDirection: "row" },
  unlink: { padding: theme.spacing[1], borderRadius: theme.borderRadius.base },
  chatActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));
