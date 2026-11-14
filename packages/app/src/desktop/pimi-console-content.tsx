// Pimi. PolyForm-Noncommercial-1.0.0.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PimiWorkspaceSection } from "@pimi/protocol/pimi-task";
import { Text, View } from "react-native";
import { CodeXml, FolderOpen, MessageSquare, Swords } from "lucide-react-native";
import { useTranslation } from "@/i18n/use-translation";
import type { PimiSidebarControls } from "@/components/sidebar/pimi-workspace-navigation";
import { DensityIcon } from "@/components/ui/density-icon";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { useToast } from "@/contexts/toast-context";
import { findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkbenchMode } from "@/stores/workspace-workbench";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { PimiTitlebarSlot } from "@/components/headers/menu-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { DESKTOP_TRAFFIC_LIGHT_WIDTH, HEADER_INNER_HEIGHT } from "@/constants/layout";
import {
  useHasWindowChromeObstruction,
  WindowChromeRegion,
  WindowChromeSafeArea,
} from "@/utils/desktop-window";
import { isWeb } from "@/constants/platform";
import { getDesktopHost, usesPimiMacTitlebar } from "./host";
import { PimiNavigationHistory } from "./pimi-navigation-history";
import { PimiDraftEditorAction, usePimiWorkbench } from "./use-pimi-workbench";

export const PIMI_CONSOLE_CONTENT_ID = "pimi-console-content";
const fill = { flex: 1 } as const;
const PIMI_GLASS = { "pimi-glass": "" };
type ProjectPickerControls = Pick<PimiSidebarControls, "mode" | "openPeek" | "closePeek">;
const SLOT_STYLE = { flex: 1, minWidth: 0, height: "100%", display: "flex" } as const;
const SECTION_TITLES: Record<PimiWorkspaceSection, string> = {
  memory: "Memory",
  spaces: "Spaces",
};
const subscribe = (listener: () => void) =>
  getDesktopHost()?.pimiWorkspaceSection?.subscribe(listener) ?? (() => {});
const getSection = () => getDesktopHost()?.pimiWorkspaceSection?.get() ?? null;

export function usePimiWorkspaceSection() {
  return useSyncExternalStore(subscribe, getSection, () => null);
}

function shouldShowPimiTitlebar(pathname: string, covered: boolean): boolean {
  return isWeb && Boolean(getDesktopHost()?.showPimiWorkspace) && (pathname !== "/" || covered);
}

const WORKBENCH_OPTIONS: SegmentedControlOption<WorkbenchMode>[] = [
  {
    value: "agent",
    label: "Agent",
    accessibilityLabel: "Agent Mode",
    icon: (props) => <MessageSquare {...props} />,
    testID: "pimi-agent-mode",
  },
  {
    value: "editor",
    label: "IDE",
    accessibilityLabel: "IDE Mode",
    icon: (props) => <CodeXml {...props} />,
    testID: "pimi-ide-mode",
  },
];

const ThemedChatIcon = withUnistyles(MessageSquare);

function WorkbenchChatButton({ workspaceKey }: { workspaceKey: string }) {
  const open = useWorkspaceLayoutStore((state) => {
    const layout = state.layoutByWorkspace[workspaceKey];
    const paneId = state.sidePaneIdByWorkspace[workspaceKey];
    const pane = layout && paneId ? findPaneById(layout.root, paneId) : null;
    return Boolean(pane && !pane.hidden);
  });
  const toast = useToast();
  const toggle = useCallback(() => {
    if (useWorkspaceLayoutStore.getState().toggleWorkbenchChat(workspaceKey) === "unsaved") {
      toast.show("Save your changes before hiding this pane.");
    }
  }, [toast, workspaceKey]);
  return (
    <ToolbarButton
      testID="pimi-ide-chat-toggle"
      label={open ? "Hide chat pane" : "Show chat pane"}
      selected={open}
      onPress={toggle}
    >
      <ThemedChatIcon
        size={paneContentToolbarIconSize(false)}
        strokeWidth={1.5}
        uniProps={extraMutedIconColorMapping}
      />
    </ToolbarButton>
  );
}

function PimiWorkbenchToggle({ covered }: { covered: boolean }) {
  const { t } = useTranslation();
  const { mode, select, activeWorkspaceKey, available } = usePimiWorkbench();
  const options = useMemo<SegmentedControlOption<WorkbenchMode>[]>(
    () => [
      ...WORKBENCH_OPTIONS,
      {
        value: "attack",
        label: t("attack.mode.label"),
        accessibilityLabel: t("attack.mode.accessibilityLabel"),
        icon: (props) => <Swords {...props} />,
        testID: "pimi-attack-mode",
      },
    ],
    [t],
  );
  if (!available) return null;
  return (
    <WindowChromeRegion corners="top-right">
      <WindowChromeSafeArea placement="inline" style={styles.workbenchActions}>
        {!covered && mode === "editor" && activeWorkspaceKey ? (
          <WorkbenchChatButton workspaceKey={activeWorkspaceKey} />
        ) : null}
        <SegmentedControl
          options={options}
          value={mode}
          onValueChange={select}
          size="sm"
          appearance="track"
          accessibilityLabel="Workspace mode"
          testID="pimi-workbench-switch"
        />
      </WindowChromeSafeArea>
    </WindowChromeRegion>
  );
}

function PimiTitlebar({
  pathname,
  section,
  padding,
  slotRef,
  projects,
}: {
  pathname: string;
  section: PimiWorkspaceSection | null;
  padding: number;
  slotRef: (element: HTMLDivElement | null) => void;
  projects?: ProjectPickerControls;
}) {
  const projectsOpen = projects?.mode === "peek";
  return (
    <View
      style={[styles.historyBar, { paddingLeft: padding }]}
      testID="pimi-titlebar-history"
      dataSet={PIMI_GLASS}
    >
      <TitlebarDragRegion />
      <PimiNavigationHistory pathname={pathname} section={section} />
      {projects ? (
        <ToolbarButton
          testID="pimi-ide-projects"
          label="Projects"
          aria-expanded={projectsOpen}
          selected={projectsOpen}
          onPress={projectsOpen ? projects.closePeek : projects.openPeek}
          style={styles.projectsButton}
        >
          <DensityIcon icon={FolderOpen} size="sm" color="foregroundMuted" />
          <Text style={styles.projectsLabel}>Projects</Text>
        </ToolbarButton>
      ) : null}
      {section ? (
        <ScreenTitle testID="pimi-view-title">{SECTION_TITLES[section]}</ScreenTitle>
      ) : null}
      <div ref={slotRef} style={SLOT_STYLE} />
      <PimiWorkbenchToggle covered={section !== null} />
    </View>
  );
}

export function PimiConsoleContent({
  children,
  sidebar,
  pathname,
  projects,
}: {
  children: ReactNode;
  sidebar: boolean;
  pathname: string;
  projects?: ProjectPickerControls;
}) {
  const host = getDesktopHost();
  const publishBounds = host?.setPimiContentBounds;
  const section = usePimiWorkspaceSection();
  const covered = section !== null;
  const hasHistoryBar = shouldShowPimiTitlebar(pathname, covered);
  const macTitlebar = usesPimiMacTitlebar();
  const hasTopLeftControls = useHasWindowChromeObstruction("top-left");
  const topInset = !hasHistoryBar && macTitlebar && hasTopLeftControls ? HEADER_INNER_HEIGHT : 0;
  const [leftOffset, setLeftOffset] = useState(0);
  const [titlebarSlot, setTitlebarSlot] = useState<HTMLDivElement | null>(null);
  const previousPath = useRef(pathname);
  const openDraftInEditor = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (pathname === previousPath.current) return;
    previousPath.current = pathname;
    host?.dismissPimiWorkspace?.();
  }, [host, pathname]);

  useLayoutEffect(() => {
    if (!publishBounds) return;
    const element = document.getElementById(PIMI_CONSOLE_CONTENT_ID);
    if (!element) return;
    // Sidebar drag and dock transitions change the content rect without resizing the window.
    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      if (macTitlebar) setLeftOffset(Math.min(DESKTOP_TRAFFIC_LIGHT_WIDTH, Math.max(0, x)));
      publishBounds({ x, y: y + topInset, width, height: height - topInset, sidebar });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [macTitlebar, publishBounds, sidebar, topInset]);

  useLayoutEffect(() => {
    if (!publishBounds) return;
    const element = document.getElementById(PIMI_CONSOLE_CONTENT_ID);
    if (!element) return;
    // No fade on uncover: the workspace view is already gone, and an opacity ramp from 0.84 reads
    // as a dim flash of the whole console.
    element.inert = covered;
  }, [covered, publishBounds]);

  const slot = covered ? null : titlebarSlot;
  const console = (
    <View style={fill} nativeID={publishBounds ? PIMI_CONSOLE_CONTENT_ID : undefined}>
      <PimiTitlebarSlot.Provider value={hasHistoryBar ? slot : undefined}>
        {children}
      </PimiTitlebarSlot.Provider>
    </View>
  );
  if (!macTitlebar && !hasHistoryBar) return console;
  const ownsTopLeft = macTitlebar && leftOffset < DESKTOP_TRAFFIC_LIGHT_WIDTH;
  const consoleCorners = ownsTopLeft ? "both" : "top-right";
  const historyPadding =
    ownsTopLeft && hasTopLeftControls ? DESKTOP_TRAFFIC_LIGHT_WIDTH - leftOffset : 0;
  return (
    <PimiDraftEditorAction.Provider value={openDraftInEditor}>
      <View style={fill}>
        {hasHistoryBar ? (
          <PimiTitlebar
            pathname={pathname}
            section={section}
            padding={historyPadding}
            slotRef={setTitlebarSlot}
            projects={projects}
          />
        ) : null}
        <WindowChromeRegion
          corners={hasHistoryBar ? "none" : consoleCorners}
          topLeftOffset={!hasHistoryBar && ownsTopLeft ? leftOffset : 0}
        >
          {console}
        </WindowChromeRegion>
        {covered && topInset > 0 ? (
          <View style={styles.titlebar} testID="pimi-workspace-titlebar">
            <TitlebarDragRegion />
          </View>
        ) : null}
      </View>
    </PimiDraftEditorAction.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  projectsButton: {
    width: "auto",
    flexDirection: "row",
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
  },
  projectsLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  workbenchActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  historyBar: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surfaceSidebar,
  },
  titlebar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: HEADER_INNER_HEIGHT,
    backgroundColor: theme.colors.surfaceSidebar,
    zIndex: 2,
  },
}));
