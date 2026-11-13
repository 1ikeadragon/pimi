import { useCallback, useEffect, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { isWeb } from "@/constants/platform";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  usePaneContext,
} from "@/panels/pane-context";
import { getPanelRegistration } from "@/panels/panel-registry";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { AttackFocusView } from "./attack-store";
import type { AttackRunAgent } from "./use-attack-run-agents";

const FOCUS_PANE = createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true });

/** One of the existing agent or browser panels, mounted inside the board for the focused agent. */
export function FocusPanel({ target }: { target: WorkspaceTabTarget }) {
  const board = usePaneContext();
  const Component = getPanelRegistration(target.kind)?.component;
  const value = useMemo(
    () => ({ ...board, tabId: `attack-focus:${JSON.stringify(target)}`, target, state: undefined }),
    [board, target],
  );
  if (!Component) return null;
  return (
    <PaneProvider value={value}>
      <PaneFocusProvider value={FOCUS_PANE}>
        <Component key={value.tabId} />
      </PaneFocusProvider>
    </PaneProvider>
  );
}

export function AttackAgentFocus({
  agents,
  focusedAgentId,
  view,
  onView,
  onSelect,
  onBack,
  escapeEnabled,
}: {
  agents: AttackRunAgent[];
  focusedAgentId: string;
  view: AttackFocusView;
  onView: (view: AttackFocusView) => void;
  onSelect: (agentId: string) => void;
  onBack: () => void;
  /** False while an overlay is open above the focus view: Esc then closes the overlay only. */
  escapeEnabled: boolean;
}) {
  const { t } = useTranslation();
  const row = agents.find((item) => item.agent.id === focusedAgentId) ?? null;
  const browser = row?.browsers.at(-1) ?? null;
  const effectiveView: AttackFocusView = view === "browser" && browser ? "browser" : "chat";
  useEffect(() => {
    if (!isWeb || !escapeEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      // Esc inside the chat composer belongs to the composer, not the grid.
      const el = event.target instanceof HTMLElement ? event.target : null;
      if (el?.closest("input, textarea, [contenteditable='true'], [role='textbox']")) return;
      if (event.key === "Escape") onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [escapeEnabled, onBack]);
  const options = useMemo<SegmentedControlOption<AttackFocusView>[]>(
    () => [
      { value: "chat", label: t("attack.focus.chat") },
      { value: "browser", label: t("attack.focus.browser"), disabled: !browser },
    ],
    [browser, t],
  );
  const target = useMemo<WorkspaceTabTarget>(
    () =>
      effectiveView === "browser" && browser
        ? { kind: "browser", browserId: browser.browserId }
        : { kind: "agent", agentId: focusedAgentId },
    [browser, effectiveView, focusedAgentId],
  );
  return (
    <View style={styles.root} testID="attack-agent-focus">
      <View style={styles.bar}>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={ArrowLeft}
          onPress={onBack}
          testID="attack-focus-back"
        >
          {t("attack.focus.back")}
        </Button>
        <ScrollView horizontal style={styles.chips} contentContainerStyle={styles.chipsContent}>
          {agents.map((item) => (
            <Chip
              key={item.agent.id}
              item={item}
              active={item.agent.id === focusedAgentId}
              onSelect={onSelect}
            />
          ))}
        </ScrollView>
        <SegmentedControl
          options={options}
          value={effectiveView}
          onValueChange={onView}
          size="sm"
        />
      </View>
      <View style={styles.body}>
        <FocusPanel target={target} />
      </View>
    </View>
  );
}

function Chip({
  item,
  active,
  onSelect,
}: {
  item: AttackRunAgent;
  active: boolean;
  onSelect: (agentId: string) => void;
}) {
  const press = useCallback(() => onSelect(item.agent.id), [item.agent.id, onSelect]);
  return (
    <PressHighlight
      onPress={press}
      style={[styles.chip, active && styles.chipActive]}
      testID={`attack-focus-chip-${item.agent.id}`}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
        {item.role}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  chips: { flex: 1, minWidth: 0 },
  chipsContent: { gap: theme.spacing[1], alignItems: "center" },
  chip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipActive: { backgroundColor: theme.colors.surface2 },
  chipText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chipTextActive: { color: theme.colors.foreground },
  body: { flex: 1, minHeight: 0 },
}));
