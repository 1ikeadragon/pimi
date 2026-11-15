import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft, MoreHorizontal, Settings2, Trash2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import {
  AutomationCanvasViewport,
  type CanvasReveal,
} from "@/components/automations/automation-canvas-viewport";
import { AutomationEditorCanvas } from "@/components/automations/automation-editor-canvas";
import { AutomationEditorInspector } from "@/components/automations/automation-editor-inspector";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { EditingTextInput } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProjects } from "@/hooks/use-projects";
import { useHosts } from "@/runtime/host-runtime";
import { useTranslation } from "@/i18n/use-translation";
import {
  clearAutomationEditorDraft,
  draftKeyFor,
  readAutomationEditorDraft,
} from "@/stores/automation-editor-draft-store";
import {
  buildFlowEditorDefinition,
  type AutomationEditorHost,
  type AutomationEditorModel,
  type AutomationEditorSnapshot,
  type AutomationEditorState,
  type EditorSelection,
} from "@/automations/automation-editor-model";
import {
  layoutAutomationGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "@/automations/automation-editor-layout";
import { buildAutomationProjectTargets } from "@/automations/automation-project-targets";
import { useAutomationEditorModel } from "@/automations/use-automation-editor-model";
import {
  EditorNotices,
  inspectorTitle,
  Palette,
  styles as editorStyles,
  UnsavedBar,
  useBlockedReason,
  useCanvasHandlers,
  useNodeText,
} from "@/screens/automation-editor-screen";
import { confirmDialog } from "@/utils/confirm-dialog";
import { getDeviceTimeZone } from "@/utils/device-timezone";
import { toErrorMessage } from "@/utils/error-messages";
import { buildFlowEditorRoute } from "@/utils/host-routes";
import { PIMI_LIBRARY_ROUTE } from "@/navigation/pimi-library";
import { useFlow, useFlowMutations } from "./use-flows";

const NEW_FLOW_ID = "new";

export interface FlowEditorScreenProps {
  serverId: string;
  /** "new" opens an empty editor. */
  flowId: string;
}

function leaveForLibrary(router: ReturnType<typeof useRouter>) {
  router.replace({ pathname: PIMI_LIBRARY_ROUTE, params: { section: "flows" } });
}

/**
 * The flow editor: the automation editor's canvas, model and inspector in flow mode. The start node
 * is a fixed Chat node, and there is no trigger, cadence, project or limit to set.
 */
export function FlowEditorScreen(props: FlowEditorScreenProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const creating = props.flowId === NEW_FLOW_ID;
  const stored = useFlow(props.serverId, creating ? undefined : props.flowId);
  // The editor opens once on the stored flow; refetches after a save must not remount it.
  const latched = useRef(stored.data ?? null);
  if (stored.data) latched.current = stored.data;
  const flow = stored.data ?? latched.current;
  const draftKey = draftKeyFor({
    serverId: props.serverId,
    automationId: creating ? undefined : `flow:${props.flowId}`,
    origin: "flow:new",
  });
  const [discardCount, setDiscardCount] = useState(0);
  const discardDraft = useCallback(() => {
    clearAutomationEditorDraft(draftKey);
    setDiscardCount((count) => count + 1);
  }, [draftKey]);
  const goBack = useCallback(() => leaveForLibrary(router), [router]);
  const back = useMemo(
    () => (
      <Button variant="ghost" leftIcon={ChevronLeft} onPress={goBack} testID="flow-editor-back">
        {t("flowEditor.back")}
      </Button>
    ),
    [goBack, t],
  );

  let body: ReactElement;
  if (!creating && !flow) {
    body = (
      <View style={editorStyles.centered}>
        {stored.isError ? (
          <>
            <Text style={editorStyles.muted}>{t("flowEditor.notFound")}</Text>
            {back}
          </>
        ) : (
          <LoadingSpinner size="large" color={editorStyles.spinner.color} />
        )}
      </View>
    );
  } else {
    body = (
      <FlowEditor
        key={`${draftKey}#${discardCount}`}
        {...props}
        creating={creating}
        stored={creating ? null : flow}
        draftKey={draftKey}
        onDiscard={discardDraft}
        back={back}
      />
    );
  }
  return <View style={editorStyles.container}>{body}</View>;
}

function FlowEditor({
  serverId,
  creating,
  stored,
  draftKey,
  onDiscard,
  back,
}: FlowEditorScreenProps & {
  creating: boolean;
  stored: NonNullable<ReturnType<typeof useFlow>["data"]> | null;
  draftKey: string;
  onDiscard: () => void;
  back: ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const compact = useIsCompactFormFactor();
  const { projects } = useProjects();
  const hostProfiles = useHosts();
  const hosts = useMemo<AutomationEditorHost[]>(
    () => hostProfiles.map((host) => ({ serverId: host.serverId, label: host.label })),
    [hostProfiles],
  );
  const { preferences } = useFormPreferences();
  const projectTargets = useMemo(() => buildAutomationProjectTargets(projects), [projects]);
  const [initial] = useState(() => ({
    draft: readAutomationEditorDraft(draftKey) ?? undefined,
    flowSource: stored
      ? {
          name: stored.name,
          description: stored.description,
          argumentHint: stored.argumentHint,
          flow: stored.flow,
        }
      : undefined,
  }));
  const snapshot = useMemo<AutomationEditorSnapshot>(
    () => ({
      kind: "flow",
      mode: creating ? "create" : "edit",
      draft: initial.draft,
      flowSource: initial.flowSource,
      hosts,
      serverId,
      projectTargets,
      preferences,
      timezone: getDeviceTimeZone(),
      newStepTitles: {
        agent: t("automationEditor.palette.agent"),
        check: t("automationEditor.palette.check"),
        gate: t("automationEditor.palette.gate"),
      },
    }),
    [creating, hosts, initial, preferences, projectTargets, serverId, t],
  );
  const { model, state, providers } = useAutomationEditorModel(snapshot, draftKey);
  const mutations = useFlowMutations(serverId);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteInset, setPaletteInset] = useState(0);

  const save = useCallback(async () => {
    if (!state.canSave || saving) return;
    setSaving(true);
    model.setSubmitError(null);
    try {
      const definition = buildFlowEditorDefinition(state);
      if (stored) {
        await mutations.updateFlow({ flowId: stored.id, definition });
        model.markSaved();
        return;
      }
      const created = await mutations.createFlow(definition);
      model.markSaved();
      router.replace(buildFlowEditorRoute(serverId, created.id));
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [model, mutations, router, saving, serverId, state, stored]);
  const handleSave = useCallback(() => void save(), [save]);
  const handleApprove = useCallback(async () => {
    if (!stored) return;
    setActionError(null);
    try {
      await mutations.approveFlow(stored.id);
    } catch (error) {
      setActionError(toErrorMessage(error));
    }
  }, [mutations, stored]);
  const handleDelete = useCallback(async () => {
    if (!stored) return;
    const confirmed = await confirmDialog({
      title: t("flowEditor.confirmDeleteTitle"),
      message: t("flowEditor.confirmDeleteMessage", { name: stored.name }),
      confirmLabel: t("flowEditor.confirmDelete"),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      clearAutomationEditorDraft(draftKey);
      await mutations.deleteFlow(stored.id);
      leaveForLibrary(router);
    } catch (error) {
      setActionError(toErrorMessage(error));
    }
  }, [draftKey, mutations, router, stored, t]);
  const openSettings = useCallback(() => {
    model.select({ kind: "none" });
    setSettingsOpen(true);
  }, [model]);

  const nodeText = useNodeText(state);
  const { handleAddAfter, handleInsert, handleConnect, linkRefusal, handlePalette, revealRequest } =
    useCanvasHandlers(model, state);
  // The Chat start node has nothing to edit.
  const handleSelect = useCallback(
    (selection: EditorSelection) =>
      model.select(selection.kind === "trigger" ? { kind: "none" } : selection),
    [model],
  );
  const inspector = (
    <AutomationEditorInspector model={model} state={state} providers={providers} runView={null} />
  );
  const sheetVisible = compact && (state.selection.kind !== "none" || settingsOpen);
  const closeSheet = useCallback(() => {
    setSettingsOpen(false);
    model.select({ kind: "none" });
  }, [model]);
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: inspectorTitle(state, t) }), [state, t]);
  const blockedReason = useBlockedReason(state);
  const direction = compact ? "down" : "right";
  const layout = useMemo(
    () => layoutAutomationGraph({ steps: state.steps, edges: state.edges, direction }),
    [direction, state.edges, state.steps],
  );
  const reveal = useMemo<CanvasReveal | null>(() => {
    const box = revealRequest ? layout.nodes.get(revealRequest.id) : undefined;
    return revealRequest && box
      ? {
          key: revealRequest.key,
          box: { x: box.x, y: box.y, width: NODE_WIDTH, height: NODE_HEIGHT },
        }
      : null;
  }, [layout.nodes, revealRequest]);

  return (
    <>
      <MenuHeader
        title={state.name.trim() || t("flowEditor.newTitle")}
        inPimiTitlebar
        rightContent={back}
      />
      <FlowToolbar
        model={model}
        state={state}
        compact={compact}
        saving={saving}
        blockedReason={blockedReason}
        approved={stored ? stored.approved : null}
        onSave={handleSave}
        onApprove={handleApprove}
        onDelete={handleDelete}
        onSettings={openSettings}
        canDelete={stored !== null}
      />
      {state.dirty ? (
        <UnsavedBar
          canSave={state.canSave}
          saving={saving}
          onSave={handleSave}
          onDiscard={onDiscard}
        />
      ) : null}
      <EditorNotices message={state.submitError ?? actionError ?? linkRefusal} />
      <View style={editorStyles.body}>
        <View style={editorStyles.canvasArea}>
          <Palette onAdd={handlePalette} onInset={setPaletteInset} />
          <AutomationCanvasViewport
            width={layout.width}
            height={layout.height}
            topInset={paletteInset}
            fitKey={direction}
            reveal={reveal}
          >
            <AutomationEditorCanvas
              state={state}
              direction={direction}
              layout={layout}
              nodeText={nodeText}
              runStatuses={null}
              editable
              onSelect={handleSelect}
              onAddAfter={handleAddAfter}
              onInsert={handleInsert}
              onDisconnect={model.disconnect}
              onConnect={handleConnect}
            />
          </AutomationCanvasViewport>
        </View>
        {compact ? null : <View style={editorStyles.inspector}>{inspector}</View>}
      </View>
      {compact ? (
        <AdaptiveModalSheet
          header={sheetHeader}
          visible={sheetVisible}
          onClose={closeSheet}
          snapPoints={["70%", "92%"]}
          testID="flow-inspector-sheet"
        >
          {inspector}
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const ThemedSettings = withUnistyles(Settings2);
const ThemedTrash = withUnistyles(Trash2);
const menuIconProps = (theme: { colors: { foregroundMuted: string } }) => ({
  size: 14,
  color: theme.colors.foregroundMuted,
});
const settingsMenuIcon = <ThemedSettings uniProps={menuIconProps} />;
const deleteMenuIcon = <ThemedTrash uniProps={menuIconProps} />;

function FlowToolbar(props: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  compact: boolean;
  saving: boolean;
  blockedReason: string | null;
  /** Null for a flow that is not saved yet. */
  approved: boolean | null;
  canDelete: boolean;
  onSave: () => void;
  onApprove: () => void;
  onDelete: () => void;
  onSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { model, state, compact } = props;
  const [initialName] = useState(state.name);
  const handleName = useCallback((next: string) => model.setName(next), [model]);
  return (
    <View style={editorStyles.toolbar}>
      <View style={editorStyles.toolbarStart}>
        <EditingTextInput
          initialValue={initialName}
          onChangeText={handleName}
          placeholder={t("flowEditor.namePlaceholder")}
          placeholderTextColor={editorStyles.placeholder.color}
          accessibilityLabel={t("flowEditor.nameLabel")}
          style={editorStyles.nameInput}
          autoCapitalize="none"
          autoCorrect={false}
          testID="flow-name-input"
        />
        {props.approved === null ? null : (
          <StatusBadge
            label={props.approved ? t("flowEditor.approved") : t("flowEditor.waiting")}
            variant={props.approved ? "success" : "warning"}
          />
        )}
      </View>
      <View style={editorStyles.toolbarEnd}>
        {props.approved === false ? (
          <Button
            size="sm"
            variant="outline"
            onPress={props.onApprove}
            disabled={state.dirty}
            testID="flow-approve"
          >
            {t("flowEditor.approve")}
          </Button>
        ) : null}
        {props.blockedReason && !compact ? (
          <Text style={editorStyles.blocked} numberOfLines={1} testID="flow-save-blocked">
            {t("automationEditor.saveBlocked", { reason: props.blockedReason })}
          </Text>
        ) : null}
        <Button
          size="sm"
          variant="default"
          onPress={props.onSave}
          loading={props.saving}
          disabled={!state.canSave}
          accessibilityHint={props.blockedReason ?? undefined}
          testID="flow-save"
        >
          {props.canDelete ? t("flowEditor.save") : t("flowEditor.create")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            style={editorStyles.overflowTrigger}
            accessibilityRole="button"
            accessibilityLabel={t("flowEditor.more")}
            testID="flow-more"
          >
            <MoreHorizontal size={18} color={editorStyles.menuIcon.color} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={240} sheetTitle={t("flowEditor.more")}>
            {compact ? (
              <DropdownMenuItem
                leading={settingsMenuIcon}
                onSelect={props.onSettings}
                testID="flow-open-settings"
              >
                {t("flowEditor.settingsTitle")}
              </DropdownMenuItem>
            ) : null}
            {props.canDelete ? (
              <>
                {compact ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  destructive
                  leading={deleteMenuIcon}
                  onSelect={props.onDelete}
                  testID="flow-delete"
                >
                  {t("flowEditor.delete")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
      {props.blockedReason && compact ? (
        <Text style={editorStyles.blockedCompact} numberOfLines={2} testID="flow-save-blocked">
          {t("automationEditor.saveBlocked", { reason: props.blockedReason })}
        </Text>
      ) : null}
    </View>
  );
}
