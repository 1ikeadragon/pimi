import { ListPlus, MoreVertical, Pencil, Trash2 } from "lucide-react-native";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ACTION_ITEM_TEXT_MAX_LENGTH,
  type ActionItem,
  type ActionItemsEdit,
  type ActionItemsState,
  type ActionItemsUsage,
} from "@pimi/protocol/action-items/types";
import { TASK_TITLE_MAX_LENGTH } from "@pimi/protocol/task/types";
import {
  CheckCollapse,
  CheckFade,
  CheckPop,
  useCheckOff,
  type ClosingPhase,
} from "@/action-items/check-off";
import { Enter } from "@/action-items/enter";
import { useActionItems, type UseActionItemsResult } from "@/action-items/use-action-items";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { TaskStatusMark } from "@/components/tasks/task-status-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTaskMutations } from "@/hooks/use-task-mutations";
import { useTranslation } from "@/i18n/use-translation";
import type { Theme } from "@/styles/theme";
import { formatTokens, formatUsd } from "@/usage/overview/format";

const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedListPlus = withUnistyles(ListPlus);
const ThemedTrash = withUnistyles(Trash2);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const NO_ITEMS: readonly ActionItem[] = [];

const MENU_ICON_SIZE = 14;
const kebabIcon = <ThemedKebab size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const taskLeading = <ThemedListPlus size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveMapping} />;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageLine(
  usage: ActionItemsUsage,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (usage.runs === 0) return null;
  const tokens = formatTokens(usage.inputTokens + usage.outputTokens);
  return usage.costUsd === undefined
    ? t("actionItems.usage", { count: usage.runs, tokens })
    : t("actionItems.usageWithCost", {
        count: usage.runs,
        tokens,
        // A few Haiku calls cost a fraction of a cent, which rounds to a misleading $0.00.
        cost:
          usage.costUsd < 0.01 ? t("actionItems.costUnderCent") : formatUsd(usage.costUsd, "en-US"),
      });
}

/** The docked panel: reads one chat's list and shows it. */
export function ActionItemsView({
  serverId,
  agentId,
  active,
  footerAction,
}: {
  serverId: string;
  agentId: string | null;
  active: boolean;
  footerAction?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const { config } = useDaemonConfig(serverId);
  const featureOff = config?.metadataGeneration.actionItems === false;
  const model = useActionItems({ serverId, agentId, active: active && !featureOff });
  if (featureOff) return <Centered text={t("actionItems.off")} />;
  if (!agentId) return <Centered text={t("actionItems.noChat")} />;
  return (
    <ActionItemsContent
      serverId={serverId}
      agentId={agentId}
      model={model}
      variant="panel"
      footerAction={footerAction}
    />
  );
}

/**
 * The action items of one chat: what is being checked there and what is still open. The daemon
 * keeps the list and decides which chats a model reads; this view shows it and sends edits.
 * `card` sizes to its content for the floating note; `panel` fills its pane.
 */
export function ActionItemsContent({
  serverId,
  agentId,
  model,
  variant,
  footerAction,
}: {
  serverId: string;
  agentId: string;
  model: UseActionItemsResult;
  variant: "panel" | "card";
  footerAction?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const { state, isConnected, loadError, edit } = model;
  const { createTask } = useTaskMutations({ serverId });
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setFailure(null);
    setNotice(null);
  }, [agentId]);

  const send = useCallback(
    async (change: ActionItemsEdit) => {
      setNotice(null);
      try {
        await edit(change);
        setFailure(null);
      } catch (error) {
        setFailure(errorText(error));
        throw error;
      }
    },
    [edit],
  );

  const handleAdd = useCallback((text: string) => send({ kind: "add", text }), [send]);
  const handleResume = useCallback(() => {
    void send({ kind: "set_tracking", tracking: true }).catch(() => undefined);
  }, [send]);
  const handlePause = useCallback(() => {
    void send({ kind: "set_tracking", tracking: false }).catch(() => undefined);
  }, [send]);
  const handleClearDone = useCallback(() => {
    void send({ kind: "clear_done" }).catch(() => undefined);
  }, [send]);
  const handleToggle = useCallback(
    (item: ActionItem) => {
      void send({ kind: "set_done", itemId: item.id, done: !item.done }).catch(() => undefined);
    },
    [send],
  );
  const handleKeepOpen = useCallback(
    (item: ActionItem) => {
      void send({ kind: "dismiss_suggestion", itemId: item.id }).catch(() => undefined);
    },
    [send],
  );
  const handleDelete = useCallback(
    (item: ActionItem) => {
      void send({ kind: "delete", itemId: item.id }).catch(() => undefined);
    },
    [send],
  );
  const handleRename = useCallback(
    (item: ActionItem, text: string) => send({ kind: "set_text", itemId: item.id, text }),
    [send],
  );
  const handleAddToTasks = useCallback(
    (item: ActionItem) => {
      if (!agentId) return;
      setNotice(null);
      createTask({
        title: item.text.slice(0, TASK_TITLE_MAX_LENGTH),
        links: [{ kind: "agent", agentId, role: "creator" }],
      })
        .then(() => {
          setFailure(null);
          setNotice(t("actionItems.addedToTasks"));
          return undefined;
        })
        .catch((error: unknown) => setFailure(errorText(error)));
    },
    [agentId, createTask, t],
  );

  const items = state?.agentId === agentId ? state.items : NO_ITEMS;
  // An item that was just checked stays under Open while it animates (check-off.tsx).
  const closing = useCheckOff(agentId, items);
  const open = useMemo(
    () => items.filter((item) => !item.done || closing.has(item.id)),
    [items, closing],
  );
  const done = useMemo(
    () => items.filter((item) => item.done && !closing.has(item.id)),
    [items, closing],
  );

  // Rows present at the first render appear in place; only later arrivals animate in.
  const seen = useRef<Set<string> | null>(null);
  if (state && state.agentId === agentId && seen.current === null) {
    seen.current = new Set(state.items.map((item) => `${item.id}:${item.done}`));
  }
  // A closing item's check-off is its animation; it regroups under Done without another one.
  for (const id of closing.keys()) seen.current?.add(`${id}:true`);
  const isNew = (item: ActionItem) => !seen.current?.has(`${item.id}:${item.done}`);

  if (!state || state.agentId !== agentId) {
    if (loadError) return <Centered text={loadError} />;
    if (!isConnected) return <Centered text={t("workspace.terminal.hostDisconnected")} />;
    return (
      <View style={styles.centered}>
        <LoadingSpinner size={14} color={styles.muted.color} />
      </View>
    );
  }

  const isEmpty = state.items.length === 0;

  return (
    <View
      style={variant === "panel" ? styles.container : styles.cardContainer}
      testID="action-items-panel"
    >
      <View style={styles.add}>
        <QuickAdd onSubmit={handleAdd} />
      </View>
      <ScrollView
        style={variant === "panel" ? styles.scroll : styles.cardScroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.list}>
          {isEmpty ? (
            <Text style={styles.empty}>
              {t(state.tracking === "off" ? "actionItems.emptyPaused" : "actionItems.empty")}
            </Text>
          ) : null}
          {open.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              animate={isNew(item)}
              closing={closing.get(item.id)}
              lastRunAt={state.lastRunAt}
              onKeepOpen={handleKeepOpen}
              onToggle={handleToggle}
              onRename={handleRename}
              onDelete={handleDelete}
              onAddToTasks={handleAddToTasks}
            />
          ))}
          {done.length > 0 ? (
            <View style={styles.groupHeading}>
              <Text style={styles.groupTitle}>
                {t("actionItems.doneHeading", { count: done.length })}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                onPress={handleClearDone}
                testID="action-items-clear-done"
              >
                {t("actionItems.clearDone")}
              </Button>
            </View>
          ) : null}
          {done.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              animate={isNew(item)}
              closing={undefined}
              lastRunAt={state.lastRunAt}
              onKeepOpen={handleKeepOpen}
              onToggle={handleToggle}
              onRename={handleRename}
              onDelete={handleDelete}
              onAddToTasks={handleAddToTasks}
            />
          ))}
        </View>
      </ScrollView>
      <Footer
        state={state}
        failure={failure}
        notice={notice}
        onPause={handlePause}
        onResume={handleResume}
        action={footerAction}
      />
    </View>
  );
}

function Footer({
  state,
  failure,
  notice,
  onPause,
  onResume,
  action,
}: {
  state: ActionItemsState;
  failure: string | null;
  notice: string | null;
  onPause: () => void;
  onResume: () => void;
  action?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const tracking = state.tracking !== "off";
  let status = usageLine(state.usage, t);
  if (state.updating) status = t("actionItems.updating");
  else if (!tracking) status = t("actionItems.paused");
  else if (state.tracking === "unset") status = t("actionItems.waiting");
  const error =
    failure ?? (state.error ? t("actionItems.updateFailed", { error: state.error }) : null);
  return (
    <View style={styles.footer}>
      <View style={styles.footerText}>
        {error ? (
          <Text style={styles.error} numberOfLines={3} testID="action-items-error">
            {error}
          </Text>
        ) : null}
        {notice ? <Text style={styles.meta}>{notice}</Text> : null}
        <View style={styles.statusRow}>
          {state.updating ? <LoadingSpinner size={14} color={styles.muted.color} /> : null}
          {status ? (
            <Text style={styles.meta} numberOfLines={1} testID="action-items-status">
              {status}
            </Text>
          ) : null}
        </View>
      </View>
      <Button
        variant="ghost"
        size="sm"
        onPress={tracking ? onPause : onResume}
        testID="action-items-tracking-toggle"
      >
        {t(tracking ? "actionItems.pause" : "actionItems.resume")}
      </Button>
      {action}
    </View>
  );
}

function Centered({ text }: { text: string }): ReactElement {
  return (
    <View style={styles.centered}>
      <Text style={styles.empty}>{text}</Text>
    </View>
  );
}

function QuickAdd({ onSubmit }: { onSubmit: (text: string) => Promise<void> }): ReactElement {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [text, setText] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(() => {
    const value = text.trim().slice(0, ACTION_ITEM_TEXT_MAX_LENGTH);
    if (!value || busy) return;
    setBusy(true);
    onSubmit(value)
      .then(() => {
        setText("");
        setResetKey((key) => key + 1);
        return undefined;
      })
      // The panel shows the failure; the typed text stays.
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        inputRef.current?.focus();
      });
  }, [busy, onSubmit, text]);

  return (
    <FormTextInput
      ref={inputRef}
      size="sm"
      initialValue=""
      resetKey={resetKey}
      onChangeText={setText}
      onSubmitEditing={handleSubmit}
      placeholder={t("actionItems.addPlaceholder")}
      returnKeyType="done"
      blurOnSubmit={false}
      editable={!busy}
      accessibilityLabel={t("actionItems.addPlaceholder")}
      testID="action-items-add"
    />
  );
}

interface ItemRowProps {
  item: ActionItem;
  /** Fade in on mount: a new item, or one that just moved between Open and Done. */
  animate: boolean;
  /** Set while the item is being checked off: it is done, and still listed under Open. */
  closing: ClosingPhase | undefined;
  /** When the model's latest run ended; an item it closed in that run can be undone. */
  lastRunAt: string | undefined;
  onKeepOpen: (item: ActionItem) => void;
  onToggle: (item: ActionItem) => void;
  onRename: (item: ActionItem, text: string) => Promise<void>;
  onDelete: (item: ActionItem) => void;
  onAddToTasks: (item: ActionItem) => void;
}

// Hover lives on the outer plain View and only reveals the kebab (docs/hover.md).
const ItemRow = memo(function ItemRow({
  item,
  animate,
  closing,
  lastRunAt,
  onKeepOpen,
  onToggle,
  onRename,
  onDelete,
  onAddToTasks,
}: ItemRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const draft = useRef(item.text);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const kebab = useOpenKebabMenuVisibility(isHovered || isNative || isCompact);

  const handleToggle = useCallback(() => onToggle(item), [item, onToggle]);
  const handleKeepOpen = useCallback(() => onKeepOpen(item), [item, onKeepOpen]);
  const handleDelete = useCallback(() => onDelete(item), [item, onDelete]);
  const handleAddToTasks = useCallback(() => onAddToTasks(item), [item, onAddToTasks]);
  const handleEdit = useCallback(() => {
    draft.current = item.text;
    setEditing(true);
  }, [item.text]);
  const handleDraft = useCallback((text: string) => {
    draft.current = text;
  }, []);
  const handleCancel = useCallback(() => setEditing(false), []);
  const handleSave = useCallback(() => {
    const text = draft.current.trim().slice(0, ACTION_ITEM_TEXT_MAX_LENGTH);
    if (!text || text === item.text) {
      setEditing(false);
      return;
    }
    // On failure the field stays open with the typed text and the panel shows the error.
    onRename(item, text)
      .then(() => setEditing(false))
      .catch(() => undefined);
  }, [item, onRename]);

  return (
    <CheckCollapse active={closing === "collapsing"}>
      <Enter kind="item" animate={animate}>
        <View
          style={styles.row}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          testID={`action-item-${item.done ? "done" : "open"}`}
        >
          <View style={styles.mark}>
            <CheckPop active={closing !== undefined}>
              <TaskStatusMark
                status={item.done ? "done" : "todo"}
                label={t(item.done ? "actionItems.markOpen" : "actionItems.markDone", {
                  text: item.text,
                })}
                onToggle={handleToggle}
                testID={`action-item-mark-${item.id}`}
              />
            </CheckPop>
          </View>
          <View style={styles.rowText}>
            {editing ? (
              <FormTextInput
                size="sm"
                autoFocus
                initialValue={item.text}
                onChangeText={handleDraft}
                onSubmitEditing={handleSave}
                onBlur={handleCancel}
                returnKeyType="done"
                accessibilityLabel={t("actionItems.edit")}
                testID={`action-item-edit-${item.id}`}
              />
            ) : (
              <ItemLine item={item} closing={closing} />
            )}
            {editing ? null : (
              <ItemProof
                item={item}
                lastRunAt={lastRunAt}
                onKeepOpen={handleKeepOpen}
                onToggle={handleToggle}
              />
            )}
          </View>
          <View
            style={[styles.kebab, !kebab.showKebab && styles.kebabHidden]}
            pointerEvents={kebab.showKebab ? "auto" : "none"}
          >
            <DropdownMenu compactMode="sheet" {...kebab.menuProps}>
              <DropdownMenuTrigger
                hitSlop={8}
                style={kebabTriggerStyle}
                accessibilityRole={isNative ? "button" : undefined}
                accessibilityLabel={t("actionItems.rowActions")}
                testID={`action-item-kebab-${item.id}`}
              >
                {kebabIcon}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width={200} sheetTitle={t("actionItems.rowActions")}>
                <DropdownMenuItem leading={editLeading} onSelect={handleEdit}>
                  {t("actionItems.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem leading={taskLeading} onSelect={handleAddToTasks}>
                  {t("actionItems.addToTasks")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem leading={deleteLeading} destructive onSelect={handleDelete}>
                  {t("actionItems.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        </View>
      </Enter>
    </CheckCollapse>
  );
});

// The item's text. While it is being checked off it is the muted, struck line with the same line
// in the foreground colour fading out over it: that is the colour change (see CheckFade).
function ItemLine({
  item,
  closing,
}: {
  item: ActionItem;
  closing: ClosingPhase | undefined;
}): ReactElement {
  if (!closing) {
    return (
      <Text style={[styles.itemText, item.done && styles.itemTextDone]} numberOfLines={4}>
        {item.text}
      </Text>
    );
  }
  return (
    <View>
      <Text style={[styles.itemText, styles.itemTextDone]} numberOfLines={4}>
        {item.text}
      </Text>
      <CheckFade active style={styles.fadeOverlay}>
        <Text
          style={[styles.itemText, styles.itemTextStruck]}
          numberOfLines={4}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
        >
          {item.text}
        </Text>
      </CheckFade>
    </View>
  );
}

// What the model said about the item's state, as plain text: never markdown, since the evidence
// quotes command output.
function ItemProof({
  item,
  lastRunAt,
  onKeepOpen,
  onToggle,
}: {
  item: ActionItem;
  lastRunAt: string | undefined;
  onKeepOpen: () => void;
  onToggle: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!item.done && item.suggestion) {
    return (
      <View style={styles.proof} testID={`action-item-suggestion-${item.id}`}>
        <Text style={styles.proofText} numberOfLines={3}>
          {t("actionItems.looksDone", { evidence: item.suggestion.evidence })}
        </Text>
        <View style={styles.proofActions}>
          <Button
            variant="ghost"
            size="sm"
            onPress={onKeepOpen}
            testID={`action-item-keep-open-${item.id}`}
          >
            {t("actionItems.keepOpen")}
          </Button>
          <Button size="sm" onPress={onToggle} testID={`action-item-accept-${item.id}`}>
            {t("actionItems.markDoneAction")}
          </Button>
        </View>
      </View>
    );
  }
  if (item.done && item.doneSetBy === "model" && item.doneEvidence !== undefined) {
    // Only the latest run's closures offer Undo: older ones have been seen and left alone.
    const canUndo = item.completedAt === lastRunAt;
    return (
      <View style={styles.proof} testID={`action-item-closed-by-${item.id}`}>
        <Text style={styles.proofText} numberOfLines={3}>
          {t("actionItems.closedByPimi", { evidence: item.doneEvidence })}
        </Text>
        {canUndo ? (
          <View style={styles.proofActions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={onToggle}
              testID={`action-item-undo-${item.id}`}
            >
              {t("actionItems.undo")}
            </Button>
          </View>
        ) : null}
      </View>
    );
  }
  return null;
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  cardContainer: { flexShrink: 1, minHeight: 0 },
  cardScroll: { flexGrow: 0, flexShrink: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  muted: { color: theme.colors.foregroundMuted },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
  add: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  scroll: { flex: 1 },
  list: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  mark: {
    width: 18,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, minWidth: 0 },
  itemText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  itemTextDone: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  // The done text in its colour from before the check, laid over `itemTextDone` while it fades.
  itemTextStruck: {
    color: theme.colors.foreground,
    textDecorationLine: "line-through",
  },
  fadeOverlay: { position: "absolute", top: 0, left: 0, right: 0 },
  proof: { gap: theme.spacing[1], paddingTop: theme.spacing[1] },
  proofText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  proofActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  kebab: { height: 20, justifyContent: "center" },
  kebabHidden: { opacity: 0 },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: { backgroundColor: theme.colors.surface2 },
  groupHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 20,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
