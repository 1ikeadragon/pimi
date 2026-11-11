import { MoreVertical, Pause, Pencil, Play, RotateCw, Trash2 } from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useProviderIcon } from "@/components/provider-icons";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { AutomationDerivedState } from "@/automations/automation-derivation";
import { formatNextRun, formatTrigger, resolveAutomationTitle } from "@/utils/automation-format";
import { useTimeAgo } from "@/hooks/use-time-ago";
import type { Automation } from "@pimi/protocol/automation/types";

// Themed lucide wrappers — module-scope so only the icon re-renders on theme
// change (never call useUnistyles in render). See docs/unistyles.md.
const ThemedPencil = withUnistyles(Pencil);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedKebab = withUnistyles(MoreVertical);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const MENU_ICON_SIZE = 14;
const PROVIDER_ICON_SIZE = 16;

// Pending flags for each action so the parent table can wire a mutation hook
// and the row reflects in-flight state without owning the mutation itself.
export interface AutomationRowPending {
  pause?: boolean;
  resume?: boolean;
  approve?: boolean;
  runNow?: boolean;
  delete?: boolean;
}

export interface AutomationRowActions {
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onApprove: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}

interface AutomationRowProps extends AutomationRowActions {
  serverId: string;
  automation: Automation;
  /** Project name, or the shortened project path. */
  projectLabel: string;
  /** Provider glyph of the automation's agent step. */
  provider: string | null;
  /** "Created by agent …" when an agent made the automation. */
  originLabel: string | null;
  /** Client-derived state — the single source for the badge and next-run copy. */
  state: AutomationDerivedState;
  /** Host name, rendered when the list spans more than one host. */
  serverName?: string;
  /** True when only one host exists and the host name would be redundant. */
  singleHost?: boolean;
  pending?: AutomationRowPending;
  isFirst: boolean;
}

function stateBadge(state: AutomationDerivedState): {
  label: string;
  variant: "success" | "warning" | "error" | "muted";
} {
  switch (state) {
    case "pending":
      return { label: "Needs your approval", variant: "warning" };
    case "active":
      return { label: "Active", variant: "success" };
    case "paused":
      return { label: "Paused", variant: "muted" };
    case "failing":
      return { label: "Paused after failures", variant: "error" };
    case "expired":
      return { label: "Expired", variant: "muted" };
    case "finished":
      return { label: "Finished", variant: "muted" };
  }
}

// Meta reads left-to-right as identity → history → future: how often, when it
// was created, when it last ran, and (only while it can still run) when it runs
// next. Status lives on the badge, never repeated here.
function buildMeta(input: {
  automation: Automation;
  state: AutomationDerivedState;
  createdAgo: string;
  lastRunAgo: string;
  serverName: string | undefined;
  singleHost: boolean;
}): string {
  const { automation, state, serverName, singleHost } = input;
  const parts = [
    formatTrigger(automation),
    `Created ${input.createdAgo}`,
    formatLastRun(automation, input.lastRunAgo),
  ];
  if (state === "active") {
    const next = formatNextRun(automation.nextRunAt);
    if (next) {
      parts.push(`Next run ${next}`);
    }
  }
  if (serverName && !singleHost) {
    parts.unshift(serverName);
  }
  return parts.join(" · ");
}

function formatLastRun(automation: Automation, lastRunAgo: string): string {
  const lastRun = automation.lastRun;
  if (!lastRun) {
    return "Never run";
  }
  if (lastRun.status === "running") {
    return "Running now";
  }
  if (lastRun.status === "succeeded") {
    return `Last run ${lastRunAgo}`;
  }
  return `Last run ${lastRun.status} ${lastRunAgo}`;
}

function AutomationMeta({
  automation,
  state,
  serverName,
  singleHost,
}: {
  automation: Automation;
  state: AutomationDerivedState;
  serverName: string | undefined;
  singleHost: boolean;
}) {
  const createdAgo = useTimeAgo(new Date(automation.createdAt));
  const lastRunAgo = useTimeAgo(automation.lastRun ? new Date(automation.lastRun.startedAt) : null);
  const meta = buildMeta({ automation, state, createdAgo, lastRunAgo, serverName, singleHost });
  return (
    <Text style={settingsStyles.rowHint} numberOfLines={1}>
      {meta}
    </Text>
  );
}

/** Small provider glyph. Reads the icon color off a StyleSheet object so the
 * dynamic component (useProviderIcon) stays compliant without useUnistyles. */
function ProviderGlyph({
  provider,
  serverId,
}: {
  provider: string | null;
  serverId: string;
}): ReactElement | null {
  const Icon = useProviderIcon(provider ?? "", serverId);
  if (!provider) {
    return null;
  }
  return <Icon size={PROVIDER_ICON_SIZE} color={styles.providerIcon.color} />;
}

/**
 * One automation, rendered as a settings-style card row: provider glyph + title,
 * a muted secondary line (model · cadence · next run), a StatusBadge, and the
 * kebab menu that owns every row action. Tapping the row opens the editor.
 *
 * Hover lives on the outer plain View (docs/hover.md): the inner Pressable owns
 * press, the nested kebab Pressable never fights it, and the row background
 * highlights without reflow.
 */
export function AutomationRow({
  serverId,
  automation,
  projectLabel,
  provider,
  originLabel,
  state,
  serverName,
  singleHost,
  pending,
  isFirst,
  onEdit,
  onPause,
  onResume,
  onApprove,
  onRunNow,
  onDelete,
}: AutomationRowProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const title = resolveAutomationTitle(automation);
  const badge = stateBadge(state);
  const canRun = state === "active" || state === "paused" || state === "failing";
  const targetLine = originLabel ? `${originLabel} · ${projectLabel}` : projectLabel;
  // A pending row shows what the agent asked to run, so the owner can judge it before approving.
  const pendingPrompt = state === "pending" ? agentPrompt(automation) : null;

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      isHovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact],
  );

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel={`Edit automation ${title}`}
        testID={`automation-row-${automation.id}`}
      >
        <View style={styles.main}>
          <View style={styles.leading}>
            <ProviderGlyph provider={provider} serverId={serverId} />
          </View>
          <View style={styles.textGroup}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.target} numberOfLines={1}>
              {targetLine}
            </Text>
            {pendingPrompt ? (
              <Text
                style={styles.pendingPrompt}
                numberOfLines={6}
                testID={`automation-pending-prompt-${automation.id}`}
              >
                {pendingPrompt}
              </Text>
            ) : null}
            <AutomationMeta
              automation={automation}
              state={state}
              serverName={serverName}
              singleHost={singleHost ?? false}
            />
          </View>
        </View>

        <View style={styles.trailing}>
          <StatusBadge label={badge.label} variant={badge.variant} />
          {state === "pending" ? (
            <Button
              variant="outline"
              size="sm"
              loading={pending?.approve}
              onPress={onApprove}
              // The row is a web <button>; a nested one is invalid DOM. Same as the kebab.
              accessibilityRole={isNative ? "button" : "none"}
              accessibilityLabel={`Approve ${title}`}
              testID={`automation-approve-${automation.id}`}
            >
              Approve
            </Button>
          ) : null}
          <AutomationKebabMenu
            automation={automation}
            canRun={canRun}
            pending={pending}
            onEdit={onEdit}
            onPause={onPause}
            onResume={onResume}
            onRunNow={onRunNow}
            onDelete={onDelete}
          />
        </View>
      </Pressable>
    </View>
  );
}

// Every agent step's prompt, titled when there is more than one, so a pending graph can be
// judged from the row.
function agentPrompt(automation: Automation): string | null {
  const agents = automation.flow.nodes.flatMap((node) => (node.kind === "agent" ? [node] : []));
  if (agents.length === 1) {
    return agents[0]?.prompt.trim() || null;
  }
  const lines = agents.map((node) => `${node.title}: ${node.prompt.trim().replace(/\s+/g, " ")}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const pauseLeading = <ThemedPause size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const resumeLeading = <ThemedPlay size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const runLeading = <ThemedRotateCw size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash2 size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

function AutomationExecutionMenuItems({
  automation,
  canRun,
  pending,
  onPause,
  onResume,
  onRunNow,
}: Pick<AutomationRowProps, "automation" | "pending" | "onPause" | "onResume" | "onRunNow"> & {
  canRun: boolean;
}): ReactElement | null {
  // A pending automation is approved from its row; it has nothing to pause or run.
  if (automation.status === "pending") {
    return null;
  }

  let cadenceAction: ReactElement;
  if (automation.status === "paused") {
    cadenceAction = (
      <DropdownMenuItem
        leading={resumeLeading}
        disabled={!canRun}
        status={pending?.resume ? "pending" : "idle"}
        pendingLabel="Resuming..."
        onSelect={onResume}
        testID={`automation-menu-resume-${automation.id}`}
      >
        Resume automation
      </DropdownMenuItem>
    );
  } else {
    cadenceAction = (
      <DropdownMenuItem
        leading={pauseLeading}
        disabled={automation.status === "ended" || !canRun}
        status={pending?.pause ? "pending" : "idle"}
        pendingLabel="Pausing..."
        onSelect={onPause}
        testID={`automation-menu-pause-${automation.id}`}
      >
        Pause automation
      </DropdownMenuItem>
    );
  }

  return (
    <>
      {cadenceAction}
      <DropdownMenuItem
        leading={runLeading}
        disabled={!canRun}
        status={pending?.runNow ? "pending" : "idle"}
        pendingLabel="Starting..."
        onSelect={onRunNow}
        testID={`automation-menu-run-${automation.id}`}
      >
        Run now
      </DropdownMenuItem>
    </>
  );
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

function AutomationKebabMenu({
  automation,
  canRun,
  pending,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: Pick<
  AutomationRowProps,
  "automation" | "pending" | "onEdit" | "onPause" | "onResume" | "onRunNow" | "onDelete"
> & {
  canRun: boolean;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel="Automation actions"
        testID={`automation-kebab-${automation.id}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          leading={editLeading}
          onSelect={onEdit}
          testID={`automation-menu-edit-${automation.id}`}
        >
          Edit automation
        </DropdownMenuItem>
        <AutomationExecutionMenuItems
          automation={automation}
          canRun={canRun}
          pending={pending}
          onPause={onPause}
          onResume={onResume}
          onRunNow={onRunNow}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          status={pending?.delete ? "pending" : "idle"}
          pendingLabel="Deleting..."
          onSelect={onDelete}
          testID={`automation-menu-delete-${automation.id}`}
        >
          Delete automation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  // Static color holder for the dynamic provider icon (compliant idiom).
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  leading: {
    width: PROVIDER_ICON_SIZE,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  target: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  pendingPrompt: {
    marginTop: theme.spacing[1],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
