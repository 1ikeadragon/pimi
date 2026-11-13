import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Pencil, Plus } from "lucide-react-native";
import { create } from "zustand";
import {
  labelTargetKey,
  LABEL_COLORS,
  normalizeLabelName,
  type Label,
  type LabelColor,
  type LabelTarget,
} from "@pimi/protocol/labels";
import { useTranslation } from "@/i18n/use-translation";
import {
  MenuHint,
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  MenuTextField,
  menuRowContentInset,
  useMenuContext,
  useMenuDepth,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { Theme } from "@/styles/theme";
import {
  createLabelPickerModel,
  labelErrorMessage,
  labels as labelsController,
  useHostLabels,
  useTargetLabelIds,
} from "./store";
import { LabelDot, LabelSwatchRow } from "./swatch";

/** The `MenuSubTrigger` id on a menu that opens the assign page. */
export const LABEL_PAGE_ID = "labels";
const LABEL_CREATE_PAGE_ID = "labelsCreate";
const LABEL_EDIT_PAGE_ID = "labelsEdit";

const MENU_ICON_SIZE = 14;

const ThemedPlus = withUnistyles(Plus);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCheck = withUnistyles(Check);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// The create row keeps the leading column the label rows above it sit in. Without a mark there
// its label would start on the text rail while every label starts 24pt further in.
const CREATE_LEADING = <ThemedPlus size={MENU_ICON_SIZE} uniProps={mutedMapping} />;

const DEFAULT_CREATE_COLOR: LabelColor = LABEL_COLORS[0];

/** Which label the edit page is showing. Set by a row's pencil right before the page opens. */
const useLabelEditSelection = create<{ labelId: string | null }>(() => ({ labelId: null }));

const NO_PAGES: readonly MenuPageDefinition[] = [];

/**
 * The pages behind a `Labels` row, for whichever menu is asking: assign (toggle labels on the
 * target, each row carrying a pencil), create, and edit (rename, recolor, delete). One
 * definition serves the kebab dropdown, the context menu and the chat header, so a page is
 * improved once. Dismissal (outside press, Escape, page back) belongs to the menu engine.
 */
export function useLabelMenuPages(
  serverId: string,
  target: LabelTarget | null,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  const targetKey = target ? labelTargetKey(target) : null;
  return useMemo(() => {
    if (!target) return NO_PAGES;
    return [
      {
        id: LABEL_PAGE_ID,
        title: t("workspaceLabels.title"),
        content: <LabelPickerPage serverId={serverId} target={target} />,
      },
      {
        id: LABEL_CREATE_PAGE_ID,
        title: t("workspaceLabels.create"),
        // A page you type into is not one the pointer opens or dismisses on its own.
        hoverIntent: false,
        content: <LabelCreatePage serverId={serverId} target={target} />,
      },
      {
        id: LABEL_EDIT_PAGE_ID,
        title: t("workspaceLabels.manage.edit"),
        hoverIntent: false,
        content: <LabelEditPage serverId={serverId} />,
      },
    ];
    // `target` is rebuilt by callers; the key is its identity.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [t, serverId, targetKey]);
}

function LabelPickerPage({
  serverId,
  target,
}: {
  serverId: string;
  target: LabelTarget;
}): ReactElement {
  const { t } = useTranslation();
  const host = useHostLabels(serverId);
  const assignedIds = useTargetLabelIds(serverId, target);
  const catalog = host?.labels;
  const model = useMemo(
    () =>
      createLabelPickerModel({
        mutate: ({ label, assigned }) =>
          labelsController.setAssignment({
            serverId,
            target,
            labelId: label.id,
            assigned,
          }),
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [serverId, labelTargetKey(target)],
  );
  useEffect(() => {
    model.sync({
      labels: catalog ?? [],
      assigned: assignedIds,
      online: host?.status === "online",
    });
  }, [assignedIds, catalog, host?.status, model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const offline = !snapshot.online;
  const error = snapshot.error ?? (host?.error ? t("workspaceLabels.errors.load") : null);
  const pending = useMemo(() => new Set(snapshot.pendingIds), [snapshot.pendingIds]);
  const toggle = useCallback(
    (label: Label, assigned: boolean) => {
      void model.toggle(label, assigned);
    },
    [model],
  );

  return (
    <>
      {snapshot.rows.map((row) => (
        <LabelAssignRow
          key={row.id}
          row={row}
          offline={offline}
          pending={pending.has(row.id)}
          onToggle={toggle}
        />
      ))}
      {snapshot.rows.length > 0 ? <MenuSeparator /> : null}
      <MenuSubTrigger
        id={LABEL_CREATE_PAGE_ID}
        leading={CREATE_LEADING}
        disabled={offline}
        testID="label-picker-create"
      >
        {t("workspaceLabels.create")}
      </MenuSubTrigger>
      {error ? <MenuHint testID="label-picker-error">{error}</MenuHint> : null}
    </>
  );
}

function LabelAssignRow({
  row,
  offline,
  pending,
  onToggle,
}: {
  row: Label & { assigned: boolean };
  offline: boolean;
  pending: boolean;
  onToggle: (label: Label, assigned: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useMenuContext("LabelAssignRow");
  const depth = useMenuDepth();
  const leading = useMemo(() => <LabelDot color={row.color} />, [row.color]);
  const select = useCallback(
    () => onToggle({ id: row.id, name: row.name, color: row.color }, !row.assigned),
    [onToggle, row.assigned, row.color, row.id, row.name],
  );
  const edit = useCallback(() => {
    useLabelEditSelection.setState({ labelId: row.id });
    menu.openSub({ id: LABEL_EDIT_PAGE_ID, depth });
  }, [depth, menu, row.id]);
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        <ToolbarButton
          compact
          label={t("workspaceLabels.manage.editLabel", { name: row.name })}
          disabled={offline}
          onPress={edit}
          testID={`label-picker-edit-${row.name}`}
        >
          <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedMapping} />
        </ToolbarButton>
        <View style={styles.checkSlot}>
          {row.assigned ? <ThemedCheck size={16} uniProps={mutedMapping} /> : null}
        </View>
      </View>
    ),
    [edit, offline, row.assigned, row.name, t],
  );
  return (
    <MenuItem
      leading={leading}
      trailing={trailing}
      selected={row.assigned}
      disabled={offline}
      status={pending ? "pending" : "idle"}
      closeOnSelect={false}
      onSelect={select}
      testID={`label-picker-row-${row.name}`}
    >
      {row.name}
    </MenuItem>
  );
}

/**
 * Naming a new label and giving it a colour, in place of the list rather than under it. The
 * label is created and assigned to the target in one press; a failure keeps the draft.
 */
function LabelCreatePage({
  serverId,
  target,
}: {
  serverId: string;
  target: LabelTarget;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useMenuContext("LabelCreatePage");
  const host = useHostLabels(serverId);
  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>(DEFAULT_CREATE_COLOR);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = host?.status !== "online";

  const submit = useCallback(() => {
    const trimmed = normalizeLabelName(name);
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    labelsController
      .create({ serverId, name: trimmed, color })
      .then((label) =>
        labelsController.setAssignment({ serverId, target, labelId: label.id, assigned: true }),
      )
      .then(() => menu.goBack())
      .catch((cause: unknown) => setError(labelErrorMessage(cause)))
      .finally(() => setPending(false));
  }, [color, menu, name, pending, serverId, target]);

  return (
    <>
      <MenuTextField
        onChangeText={setName}
        placeholder={t("workspaceLabels.name")}
        autoFocus
        editable={!offline && !pending}
        onSubmitEditing={submit}
        testID="label-picker-create-name"
      />
      <View style={styles.swatches}>
        <LabelSwatchRow
          value={color}
          onChange={setColor}
          disabled={offline || pending}
          testID="label-picker-create-colors"
        />
      </View>
      <MenuSeparator />
      <MenuItem
        disabled={offline || !normalizeLabelName(name)}
        status={pending ? "pending" : "idle"}
        pendingLabel={t("workspaceLabels.creating")}
        closeOnSelect={false}
        onSelect={submit}
        testID="label-picker-create-submit"
      >
        {t("workspaceLabels.createConfirm")}
      </MenuItem>
      {error ? <MenuHint testID="label-picker-error">{error}</MenuHint> : null}
    </>
  );
}

/**
 * Rename, recolor and delete the label a row's pencil selected. Rename and recolor are one
 * Save; delete asks first, with the count of targets that lose the label.
 */
function LabelEditPage({ serverId }: { serverId: string }): ReactElement | null {
  const { t } = useTranslation();
  const menu = useMenuContext("LabelEditPage");
  const labelId = useLabelEditSelection((state) => state.labelId);
  const host = useHostLabels(serverId);
  const label = host?.labels.find((candidate) => candidate.id === labelId) ?? null;
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState<LabelColor>(label?.color ?? DEFAULT_CREATE_COLOR);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = host?.status !== "online";

  // Seeded once per label; a rename pushed from elsewhere does not clobber what is being typed.
  const [seededFor, setSeededFor] = useState<string | null>(label?.id ?? null);
  useEffect(() => {
    if (label && seededFor !== label.id) {
      setSeededFor(label.id);
      setName(label.name);
      setColor(label.color);
    }
  }, [label, seededFor]);

  // Deleted from elsewhere, or never selected: nothing to edit.
  useEffect(() => {
    if (host && !label) menu.goBack();
  }, [host, label, menu]);

  const trimmed = normalizeLabelName(name);
  const dirty =
    label !== null && trimmed.length > 0 && (trimmed !== label.name || color !== label.color);

  const save = useCallback(() => {
    if (!label || !dirty || pending) return;
    setPending(true);
    setError(null);
    labelsController
      .update({
        serverId,
        labelId: label.id,
        ...(trimmed === label.name ? {} : { name: trimmed }),
        ...(color === label.color ? {} : { color }),
      })
      .then(() => menu.goBack())
      .catch((cause: unknown) => setError(labelErrorMessage(cause)))
      .finally(() => setPending(false));
  }, [color, dirty, label, menu, pending, serverId, trimmed]);

  const remove = useCallback(() => {
    if (!label || pending) return;
    setPending(true);
    setError(null);
    void (async () => {
      try {
        const { affectedCount } = await labelsController.inspectDelete({
          serverId,
          labelId: label.id,
        });
        const confirmed = await confirmDialog({
          title: t("workspaceLabels.manage.deleteTitle", { name: label.name }),
          message: t("workspaceLabels.manage.deleteMessage", { count: affectedCount }),
          confirmLabel: t("workspaceLabels.manage.delete"),
          destructive: true,
        });
        if (!confirmed) return;
        await labelsController.delete({ serverId, labelId: label.id });
        menu.goBack();
      } catch (cause) {
        setError(labelErrorMessage(cause));
      } finally {
        setPending(false);
      }
    })();
  }, [label, menu, pending, serverId, t]);

  if (!label) return null;
  return (
    <>
      <MenuTextField
        initialValue={label.name}
        onChangeText={setName}
        placeholder={t("workspaceLabels.name")}
        autoFocus
        editable={!offline && !pending}
        onSubmitEditing={save}
        testID="label-picker-edit-name"
      />
      <View style={styles.swatches}>
        <LabelSwatchRow
          value={color}
          onChange={setColor}
          disabled={offline || pending}
          testID="label-picker-edit-colors"
        />
      </View>
      <MenuSeparator />
      <MenuItem
        disabled={offline || !dirty}
        status={pending ? "pending" : "idle"}
        closeOnSelect={false}
        onSelect={save}
        testID="label-picker-edit-save"
      >
        {t("workspaceLabels.manage.save")}
      </MenuItem>
      <MenuItem
        destructive
        disabled={offline || pending}
        closeOnSelect={false}
        onSelect={remove}
        testID="label-picker-edit-delete"
      >
        {t("workspaceLabels.manage.delete")}
      </MenuItem>
      {error ? <MenuHint testID="label-picker-error">{error}</MenuHint> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // Fixed width so a ticked row and an unticked one keep the pencil on one rail.
  checkSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  swatches: {
    paddingHorizontal: menuRowContentInset(theme),
    paddingVertical: theme.spacing[2],
  },
}));
