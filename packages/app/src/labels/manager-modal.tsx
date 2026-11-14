import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Pencil } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  LABEL_COLORS,
  normalizeLabelName,
  type Label,
  type LabelColor,
} from "@pimi/protocol/labels";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { HostFilter } from "@/components/hosts/host-filter";
import { Button } from "@/components/ui/button";
import type { ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  createLabelManagerModel,
  useLabelProjection,
  labelErrorMessage,
  labels,
  type LabelManagerDraft,
} from "@/labels/store";
import { LabelDot, LabelSwatchRow } from "./swatch";
import { useTranslation } from "@/i18n/use-translation";

/** The size the host pill's own glyphs use, so the row's trailing mark matches the controls above it. */
const EDIT_ICON_SIZE = 14;

/** Grows the pencil to a 44pt target without moving it off the trailing rail. */
const EDIT_HIT_SLOP = (44 - EDIT_ICON_SIZE) / 2;

const ThemedPencil = withUnistyles(Pencil);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The whole label catalog of one host, and editing any one of them.
 *
 * Two views, one sheet: the list, and the edit view the pencil opens. The edit view is reached
 * the way every other sheet reaches a second page — the header's back arrow returns from it —
 * because a label row is a label, not a button that swaps the surface under you.
 */
export function LabelManagerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { hosts: labelHosts } = useLabelProjection();
  const snapshots = useMemo(
    () => Object.fromEntries(labelHosts.map((host) => [host.serverId, host])),
    [labelHosts],
  );
  const [model] = useState(() =>
    createLabelManagerModel({
      update: (input) => labels.update(input),
      inspectDelete: (input) => labels.inspectDelete(input),
      delete: (input) => labels.delete(input),
    }),
  );

  useEffect(() => {
    // Closing ends the edit, so reopening lands on the list rather than on whatever was half
    // typed a session ago.
    if (!visible) {
      model.reset();
      return;
    }
    model.syncHosts(
      hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label || host.serverId,
        status: snapshots[host.serverId]?.status ?? "offline",
        labels: snapshots[host.serverId]?.labels ?? [],
        error: snapshots[host.serverId]?.error,
      })),
    );
  }, [hosts, model, snapshots, visible]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const draft = state.draft;
  const editing = state.editing;
  const disabled = state.host?.status !== "online" || state.pending;

  const selectHost = useCallback((serverId: string) => model.selectHost(serverId), [model]);
  const setQuery = useCallback((value: string) => model.setQuery(value), [model]);
  const edit = useCallback((label: Label) => model.edit(label), [model]);
  const cancelEdit = useCallback(() => model.cancelEdit(), [model]);
  const setDraftName = useCallback((value: string) => model.setDraftName(value), [model]);
  const setDraftColor = useCallback((color: LabelColor) => model.setDraftColor(color), [model]);
  const save = useCallback(() => {
    void model.save();
  }, [model]);
  const remove = useCallback((): void => {
    if (!editing) return;
    void model.delete((affected) =>
      confirmDialog({
        title: t("labels.manage.deleteTitle", { name: editing.name }),
        message: t("labels.manage.deleteMessage", { count: affected }),
        confirmLabel: t("labels.manage.delete"),
        destructive: true,
      }),
    );
  }, [editing, model, t]);

  const isEditing = draft !== null;
  // Search belongs to the sheet's header, where it spans the header's own rails and needs no
  // layout from this caller. `resetKey` empties the uncontrolled field on the same event that
  // clears the model's query, so the box and the list never disagree about what is filtered.
  const header = useMemo<SheetHeader>(
    () =>
      isEditing
        ? {
            title: t("labels.manage.edit"),
            back: { onPress: cancelEdit },
          }
        : {
            title: t("labels.manage.title"),
            search: {
              onChange: setQuery,
              resetKey: Number(visible),
              placeholder: t("labels.manage.search"),
              testID: "label-manager-search",
            },
          },
    [cancelEdit, isEditing, setQuery, t, visible],
  );
  const footer = useMemo(
    () =>
      isEditing ? (
        <View style={styles.footer}>
          <Button
            // Red belongs to the confirm dialog, not to the surface that opens it — docs/design.md.
            variant="outline"
            disabled={disabled}
            onPress={remove}
            testID="label-manager-delete"
          >
            {t("labels.manage.delete")}
          </Button>
          <Button
            style={styles.saveButton}
            disabled={disabled || !state.dirty}
            loading={state.pending}
            onPress={save}
            testID="label-manager-save"
          >
            {t("labels.manage.save")}
          </Button>
        </View>
      ) : undefined,
    [disabled, isEditing, remove, save, state.dirty, state.pending, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      footer={footer}
      testID="label-manager"
    >
      {draft && editing ? (
        <LabelEditView
          draft={draft}
          disabled={disabled}
          error={state.error}
          onChangeName={setDraftName}
          onChangeColor={setDraftColor}
          onSubmit={save}
        />
      ) : (
        <>
          {hosts.length > 1 ? (
            <HostFilter
              hosts={hosts}
              selectedHost={state.serverId}
              onSelectHost={selectHost}
              includeAllHost={false}
              triggerTestID="label-manager-host"
              hostOptionTestID={managerHostOptionTestID}
            />
          ) : null}
          {state.host?.status === "online" ? (
            <LabelCreateForm serverId={state.serverId} disabled={state.pending} />
          ) : null}
          <View style={styles.list}>
            {state.labels.map((label) => (
              <LabelManagerRow key={label.id} label={label} disabled={disabled} onEdit={edit} />
            ))}
            {state.labels.length === 0 ? (
              <Text style={styles.muted}>{t("labels.manage.empty")}</Text>
            ) : null}
          </View>
          {state.host?.status === "offline" ? (
            <Text style={styles.muted}>{t("labels.manage.offline")}</Text>
          ) : null}
          {(state.error ?? state.host?.error) ? (
            <Text style={styles.error} testID="label-manager-error">
              {state.error ?? state.host?.error}
            </Text>
          ) : null}
        </>
      )}
    </AdaptiveModalSheet>
  );
}

/**
 * Creating a label from the manager: a name, a colour, one Create press. Unlike the picker's
 * create page it assigns nothing, because the manager has no target.
 */
function LabelCreateForm({
  serverId,
  disabled,
}: {
  serverId: string;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>(LABEL_COLORS[0]);
  const [resetKey, setResetKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = normalizeLabelName(name);
  const submit = useCallback(() => {
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    void (async () => {
      try {
        await labels.create({ serverId, name: trimmed, color });
        setName("");
        setResetKey((key) => key + 1);
      } catch (cause) {
        setError(labelErrorMessage(cause));
      } finally {
        setPending(false);
      }
    })();
  }, [color, pending, serverId, trimmed]);
  return (
    <View style={styles.createForm}>
      <Field label={t("labels.create")}>
        <FormTextInput
          size="md"
          initialValue=""
          resetKey={resetKey}
          onChangeText={setName}
          onSubmitEditing={submit}
          editable={!disabled && !pending}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("labels.name")}
          accessibilityLabel={t("labels.name")}
          testID="label-manager-create-name"
        />
      </Field>
      <LabelSwatchRow
        value={color}
        onChange={setColor}
        disabled={disabled || pending}
        testID="label-manager-create-colors"
      />
      <Button
        variant="outline"
        disabled={disabled || !trimmed}
        loading={pending}
        onPress={submit}
        testID="label-manager-create-submit"
      >
        {t("labels.createConfirm")}
      </Button>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const managerHostOptionTestID = (serverId: string) => `label-manager-host-${serverId}`;

/**
 * One label: its colour, its name, and the pencil that opens it.
 *
 * Hover lives on the plain outer `View` and press on the inner `Pressable`, which is the one
 * shape that survives a pressable inside a hover target (docs/hover.md). The pencil fades rather
 * than mounts, so revealing it cannot move the row out from under the pointer.
 */
function LabelManagerRow({
  label,
  disabled,
  onEdit,
}: {
  label: Label;
  disabled: boolean;
  onEdit: (label: Label) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const edit = useCallback(() => onEdit(label), [label, onEdit]);
  const revealed = isHovered || isNative || isCompact;
  const editStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.rowEdit,
      !revealed && styles.rowEditHidden,
      pressed && styles.rowEditPressed,
    ],
    [revealed],
  );

  return (
    <View
      style={styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`label-manager-label-${label.name}`}
    >
      <LabelDot color={label.color} />
      <Text style={styles.rowName} numberOfLines={1}>
        {label.name}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("labels.manage.editLabel", { name: label.name })}
        disabled={disabled}
        hitSlop={EDIT_HIT_SLOP}
        onPress={edit}
        pointerEvents={revealed ? "auto" : "none"}
        style={editStyle}
        testID={`label-manager-edit-${label.name}`}
      >
        <ThemedPencil size={EDIT_ICON_SIZE} uniProps={mutedMapping} />
      </Pressable>
    </View>
  );
}

/**
 * A label's name and colour, changed together and committed once by the footer's Save.
 *
 * Picking a colour picks a colour — nothing leaves for the host until Save, so a failure has one
 * thing to report and the draft is still exactly what was typed.
 */
function LabelEditView({
  draft,
  disabled,
  error,
  onChangeName,
  onChangeColor,
  onSubmit,
}: {
  draft: LabelManagerDraft;
  disabled: boolean;
  error: string | null;
  onChangeName: (value: string) => void;
  onChangeColor: (color: LabelColor) => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const size: ControlSize = "md";
  return (
    <>
      <Field label={t("labels.manage.name")}>
        <FormTextInput
          size={size}
          initialValue={draft.name}
          resetKey={draft.name}
          onChangeText={onChangeName}
          onSubmitEditing={onSubmit}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("labels.manage.name")}
          testID="label-manager-name"
        />
      </Field>
      <Field label={t("labels.manage.color")}>
        <LabelSwatchRow
          value={draft.color}
          onChange={onChangeColor}
          disabled={disabled}
          testID="label-manager-colors"
        />
      </Field>
      {error ? (
        <Text style={styles.error} testID="label-manager-error">
          {error}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  createForm: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  // Fixed height so the pencil appearing cannot resize the row under the pointer. The dot leads
  // at the content inset and the pencil ends on it; nothing here indents, so the list holds one
  // rail down its whole length.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowEdit: {
    // The glyph is the whole control — its 44pt target comes from hitSlop, which grows outward
    // and leaves the trailing rail where it is.
    alignItems: "center",
    justifyContent: "center",
  },
  rowEditHidden: {
    opacity: 0,
  },
  rowEditPressed: {
    opacity: 0.6,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  saveButton: {
    minWidth: 112,
  },
}));
