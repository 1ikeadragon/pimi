import { useHardwareKeyboardPresent } from "@/keyboard";
import { noProps, overridable, Slot } from "@/extension-points";
import {
  WindowLayoutProvider,
  WindowLayoutActionsHost,
  WindowLayoutSurface,
  WindowLayoutDivisionGap,
  useWindowLayout,
  resolveDesktopDivisionLayout,
} from "@/window-layout";
import { AddHostProvider, AddHostFlowHost } from "@/hosts/add-host";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useIsExplorerSidebarOpen } from "@/workspace-tabs/explorer-sidebar";
import { ComposerEditingSessionsProvider } from "@/composer/editing-session";
import { SheetHostScope } from "@/components/ui/isolated-bottom-sheet-modal";
import "@/styles/unistyles";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider } from "@gorhom/portal";
import { LucideProvider } from "lucide-react-native";
import * as Linking from "expo-linking";
import { Stack, useNavigationContainerRef, usePathname, useRouter } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, useWindowDimensions, View } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AppearanceProvider } from "@/appearance/provider";
import { CommandCenter } from "@/command-center/command-center";
import { CommandCenterRootActions } from "@/command-center/root-registration";
import { CommandCenterSettingsActions } from "@/command-center/settings-registration";
import { CommandCenterProvider } from "@/command-center/provider";
import { CommandCenterWorkspaceActions } from "@/command-center/workspace-registration";
import { PluginCommandCenterActions } from "@/plugins/command-center/registration";
import { AddProjectFlowHost } from "@/components/add-project-flow-host";
import { WorktreeSetupCalloutSource } from "@/components/worktree-setup-callout-source";
import { DownloadToast } from "@/components/download-toast";
import { QuittingOverlay } from "@/components/quitting-overlay";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { ChangelogHost } from "@/changelog";
import { OnboardingHost, useIsSetupDecisionPending } from "@/onboarding";
import { RemoteSshAuthHost } from "@/hosts/remote-ssh-auth-host";
import { RemoteSshUpgradeHost } from "@/hosts/remote-ssh-upgrade-host";
import { AppDiagnosticHost } from "@/components/app-diagnostic-host";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import { LeftSidebar } from "@/components/left-sidebar";
import type { PimiSidebarControls } from "@/components/sidebar/pimi-workspace-navigation";
import { WindowSidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import { DesktopWindowControls } from "@/components/desktop/window-controls";
import { SidebarModelProvider } from "@/components/sidebar/sidebar-model";
import { WorkspacePinShortcutHandler } from "@/components/workspace-pin-shortcut-handler";
import { WorkspaceRenameHost } from "@/components/workspace-rename-host";
import { WorkspaceArchiveUndoShortcutHost } from "@/workspace/archive-undo";
import { WorkspaceExplorerOpenGesture } from "@/mobile-panels/explorer-open-gesture";
import { useFollowWorkbenchMode, usePimiWorkbenchMode } from "@/desktop/use-pimi-workbench";
import { useAttackCoverageReport } from "@/attack/use-attack-coverage-report";
import { useAttackNavigationAudit } from "@/attack/use-attack-navigation-audit";
import { HarnessUpdateNotice } from "@/components/harness-update-notice";
import { ProviderSettingsHost } from "@/components/provider-settings-host";
import { WorkspaceSetupDialog } from "@/components/workspace-setup-dialog";
import { WorkspaceShortcutTargetsSubscriber } from "@/components/workspace-shortcut-targets-subscriber";
import { FloatingPanelPortalHost } from "@/components/ui/floating-panel-portal";
import { HostChooserModal, useHostChooser } from "@/hosts/host-chooser";
import { HostConfirmationSheet } from "@/hosts/host-confirmation-sheet";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarVisibility,
  resolveSidebarActivity,
  resolveLeftSidebarPresentation,
} from "@/components/desktop-sidebar-layout";
import { isNative, isWeb } from "@/constants/platform";
import { HorizontalScrollProvider } from "@/contexts/horizontal-scroll-context";
import { SessionProvider } from "@/contexts/session-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { ToastProvider } from "@/contexts/toast-context";
import { AutomationDraftWatcher } from "@/components/automations/automation-draft-watcher";
import { VoiceProvider } from "@/contexts/voice-context";
import {
  resolveStartupBlocker,
  resolveStartupNavigationReady,
  shouldRunStartupGiveUpTimer,
  startHostRuntimeBootstrap,
  bindHostRuntimeAppState,
  type StartupBlocker,
} from "@/navigation/host-runtime-bootstrap";
import { registerWorkspaceRouteNavigationRef } from "@/navigation/workspace-route-navigation";
import { useSettingsRouteEntry } from "@/navigation/settings-presentation";
import { ThemedStack } from "@/navigation/themed-stack";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { AgentNavigationListener } from "@/desktop/agent-navigation";
import { LegacyAgentSkillsMigration } from "@/agent-skills/legacy-migration";
import { legacyFavoriteProfileMigration } from "@/agent-profiles/migration";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { updateDesktopWindowChrome } from "@/desktop/electron/window";
import { getDesktopHost, usesPimiMacTitlebar } from "@/desktop/host";
import { PimiConsoleContent, PIMI_CONSOLE_CONTENT_ID } from "@/desktop/pimi-console-content";
import { PIMI_AGENT_GRID_ROUTE } from "@/navigation/pimi-agent-grid";
import { PIMI_USAGE_ROUTE } from "@/navigation/pimi-usage";
import { PIMI_LIBRARY_ROUTE } from "@/navigation/pimi-library";
import { PIMI_TASKS_ROUTE } from "@/navigation/pimi-tasks";
import { PIMI_REVIEW_ROUTE } from "@/navigation/pimi-review";
import { PimiVoiceBubble } from "@/desktop/pimi-voice-bubble";
import {
  loadDesktopSettings,
  updatePersistedDesktopSettings,
} from "@/desktop/settings/desktop-settings";
import { DaemonVersionCalloutSource } from "@/desktop/daemon/version-callout-source";
import { RosettaCalloutSource } from "@/desktop/updates/rosetta-callout-source";
import { UpdateCalloutSource } from "@/desktop/updates/update-callout-source";
import { useActiveWorktreeNewAction } from "@/hooks/use-active-worktree-new-action";
import { useGlobalNewWorkspaceAction } from "@/hooks/use-global-new-workspace-action";
import { useLatchedBoolean } from "@/hooks/use-latched-boolean";
import { useFaviconStatus } from "@/hooks/use-favicon-status";
import { useKeyboardShortcuts } from "@/keyboard/use-shortcuts";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { useCompactWebViewportZoomLock } from "@/hooks/use-compact-web-viewport-zoom-lock";
import { useOpenProject } from "@/hooks/use-open-project";
import { useAppSettings } from "@/hooks/use-settings";
import { useOpenAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelsProvider, useIsMobilePanelActive } from "@/mobile-panels/provider";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { polyfillCrypto } from "@/polyfills/crypto";
import {
  getHostRuntimeStore,
  hasConfiguredLocalDaemonOverride,
  useHostRegistryLoaded,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { usePanelStore, type LeftSidebarPresentation } from "@/stores/panel-store";
import { flushDraftPersistStorage } from "@/stores/draft-store";
import { getNextThemePreference, ICON_STROKE_WIDTH } from "@/styles/theme";
import { useSessionStore } from "@/stores/session-store";
import { WorkspaceLayoutModePublisher } from "@/workspace-tabs/layout-mode-publisher";
import { installWebScrollbarStyles } from "@/styles/install-web-scrollbar-styles";
import type { HostProfile } from "@/types/host-connection";
import {
  useHasWindowChromeObstruction,
  WindowChromeProvider,
  WindowChromeRegion,
  WindowChromeSafeArea,
} from "@/utils/desktop-window";
import {
  buildOpenProjectRoute,
  parseHostWorkspaceRouteFromPathname,
  parseServerIdFromPathname,
} from "@/utils/host-routes";
import { PluginCatalogSync } from "@/plugins";
import { NotificationOpenRouter } from "@/notification-open/react";
import { ensureOsNotificationPermission } from "@/utils/os-notifications";
import { installMemoryProbe } from "@/utils/memory-probe";

polyfillCrypto();

export interface HostRuntimeBootstrapState {
  splashError: string | null;
  retry: () => void;
  hasGivenUpWaitingForHost: boolean;
  isWaitingForSetup: boolean;
  storeReady: boolean;
  startupBlocker: StartupBlocker;
}

const HostRuntimeBootstrapContext = createContext<HostRuntimeBootstrapState>({
  splashError: null,
  retry: () => {},
  hasGivenUpWaitingForHost: false,
  isWaitingForSetup: false,
  storeReady: false,
  startupBlocker: { kind: "none" },
});

function ManagedDaemonSession({ daemon }: { daemon: HostProfile }) {
  const client = useHostRuntimeClient(daemon.serverId);

  if (!client) {
    return null;
  }

  return (
    <SessionProvider key={daemon.serverId} serverId={daemon.serverId} client={client}>
      <LegacyFavoriteProfileMigrationBootstrap serverId={daemon.serverId} client={client} />
      <PluginCatalogSync serverId={daemon.serverId} client={client} />
      {getDesktopHost()?.showPimiWorkspace ? (
        <HarnessUpdateNotice serverId={daemon.serverId} />
      ) : null}
    </SessionProvider>
  );
}

function LegacyFavoriteProfileMigrationBootstrap({
  serverId,
  client,
}: {
  serverId: string;
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
}) {
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  const isConnected = useHostRuntimeIsConnected(serverId);

  useEffect(() => {
    if (!serverInfo || !isConnected) {
      return;
    }
    void legacyFavoriteProfileMigration.migrateHost(serverId, client).catch((error) => {
      console.warn("[AgentProfiles] Failed to migrate legacy favourites", error);
    });
  }, [client, isConnected, serverId, serverInfo]);

  return null;
}

function HostSessionManager() {
  const hosts = useHosts();

  if (hosts.length === 0) {
    return null;
  }

  return (
    <>
      {hosts.map((daemon) => (
        <ManagedDaemonSession key={daemon.serverId} daemon={daemon} />
      ))}
    </>
  );
}

export function useEarliestOnlineHostServerId(): string | null {
  const store = getHostRuntimeStore();
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeAll = store.subscribeAll(listener);
      const unsubscribeHostList = store.subscribeHostList(listener);
      return () => {
        unsubscribeAll();
        unsubscribeHostList();
      };
    },
    [store],
  );
  return useSyncExternalStore(
    subscribe,
    () => store.getEarliestOnlineHostServerId(),
    () => store.getEarliestOnlineHostServerId(),
  );
}

function useDaemonStartLastError(): string | null {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getLastError(),
    () => service.getLastError(),
  );
}

function useDaemonStartIsRunning(): boolean {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.isRunning(),
    () => service.isRunning(),
  );
}

const NO_SLOT_CONTEXT = {};
const STARTUP_GIVE_UP_TIMEOUT_MS = 5_000;
// How long the splash waits on top of host startup to learn whether setup opens. A slow host
// lands on the home instead, and setup opens over it once it is decided.
const STARTUP_SETUP_WAIT_TIMEOUT_MS = 3_000;

async function shouldStartBuiltInDaemon(): Promise<boolean> {
  if (!shouldUseDesktopDaemon()) {
    return false;
  }
  if (hasConfiguredLocalDaemonOverride()) {
    return false;
  }
  const settings = await loadDesktopSettings();
  if (settings.daemon.manageBuiltInDaemon) {
    return true;
  }
  // Recovery: daemon management was disabled (e.g. host removal) but no hosts
  // are configured, so the app has nothing to connect to. Re-enable it so the
  // user isn't stranded on the welcome screen with no way to start the daemon.
  if (getHostRuntimeStore().getHosts().length === 0) {
    await updatePersistedDesktopSettings({ daemon: { manageBuiltInDaemon: true } });
    return true;
  }
  return false;
}

function HostRuntimeBootstrapProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const store = getHostRuntimeStore();
    return bindHostRuntimeAppState(store, AppState);
  }, []);

  useEffect(() => {
    const store = getHostRuntimeStore();
    const daemonStartService = getDaemonStartService({ store });
    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: shouldStartBuiltInDaemon,
    });
  }, []);

  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const daemonStartError = useDaemonStartLastError();
  const daemonStartIsRunning = useDaemonStartIsRunning();
  const [hasGivenUpWaitingForHost, setHasGivenUpWaitingForHost] = useState(false);
  const isDesktopRuntime = shouldUseDesktopDaemon();
  const startupBlocker = useMemo(
    () =>
      resolveStartupBlocker({
        isDesktopRuntime,
        anyOnlineHostServerId,
        daemonStartIsRunning,
        daemonStartError,
      }),
    [anyOnlineHostServerId, daemonStartError, daemonStartIsRunning, isDesktopRuntime],
  );
  const shouldRunGiveUpTimer = shouldRunStartupGiveUpTimer({
    startupBlocker,
    anyOnlineHostServerId,
    hasGivenUpWaitingForHost,
  });

  useEffect(() => {
    if (!shouldRunGiveUpTimer) {
      return;
    }
    const handle = setTimeout(() => {
      setHasGivenUpWaitingForHost(true);
    }, STARTUP_GIVE_UP_TIMEOUT_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [shouldRunGiveUpTimer]);

  const isSetupDecisionPending = useIsSetupDecisionPending();
  const [hasGivenUpWaitingForSetup, setHasGivenUpWaitingForSetup] = useState(false);
  const isWaitingForSetup = isSetupDecisionPending && !hasGivenUpWaitingForSetup;
  const shouldRunSetupWaitTimer = isWaitingForSetup && startupBlocker.kind === "none";

  useEffect(() => {
    if (!shouldRunSetupWaitTimer) {
      return;
    }
    const handle = setTimeout(() => {
      setHasGivenUpWaitingForSetup(true);
    }, STARTUP_SETUP_WAIT_TIMEOUT_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [shouldRunSetupWaitTimer]);

  const retry = useCallback(() => {
    const daemonStartService = getDaemonStartService({ store: getHostRuntimeStore() });
    void daemonStartService.startIfEnabled({ shouldStart: shouldStartBuiltInDaemon });
  }, []);

  const splashError =
    startupBlocker.kind === "managed-daemon-error" ? startupBlocker.message : null;
  const storeReady = resolveStartupNavigationReady({ startupBlocker });

  const state = useMemo<HostRuntimeBootstrapState>(
    () => ({
      splashError,
      retry,
      hasGivenUpWaitingForHost,
      isWaitingForSetup,
      storeReady,
      startupBlocker,
    }),
    [splashError, retry, hasGivenUpWaitingForHost, isWaitingForSetup, storeReady, startupBlocker],
  );

  return (
    <HostRuntimeBootstrapContext.Provider value={state}>
      {children}
    </HostRuntimeBootstrapContext.Provider>
  );
}

export function useStoreReady(): boolean {
  return useContext(HostRuntimeBootstrapContext).storeReady;
}

export function useHostRuntimeBootstrapState(): HostRuntimeBootstrapState {
  return useContext(HostRuntimeBootstrapContext);
}

const rowStyle = { flex: 1, flexDirection: "row" } as const;
const flexStyle = { flex: 1 } as const;
const MOBILE_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

interface AppContainerProps {
  children: ReactNode;
  chromeEnabled?: boolean;
}

const WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING = 12;

function useAppearanceCycle() {
  const { settings, updateSettings } = useAppSettings();
  const cycle = useCallback(() => {
    void updateSettings({ theme: getNextThemePreference(settings.theme) });
  }, [settings.theme, updateSettings]);
  return getDesktopHost()?.pimiAppearance ? undefined : cycle;
}

function WorkspaceSetupSuggestion({ inWorkspace }: { inWorkspace: boolean }) {
  if (inWorkspace && getDesktopHost()?.pimiAppearance) return null;
  return <WorktreeSetupCalloutSource />;
}

function AppContainer({ children, chromeEnabled: chromeEnabledOverride }: AppContainerProps) {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const daemons = useHosts();
  const toggleMobileAgentList = usePanelStore((state) => state.toggleMobileAgentList);
  const toggleDesktopAgentList = usePanelStore((state) => state.toggleDesktopAgentList);
  const exitFocusMode = usePanelStore((state) => state.exitFocusMode);
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);

  const cycleTheme = useAppearanceCycle();

  const isCompactLayout = useIsCompactFormFactor();
  useCompactWebViewportZoomLock(isCompactLayout);
  const pathname = usePathname();
  const isWorkspaceRoute = parseHostWorkspaceRouteFromPathname(pathname) !== null;
  const isWorkspaceFocusModeEnabled = isWorkspaceRoute && isFocusModeEnabled;
  const chromeEnabled = chromeEnabledOverride ?? daemons.length > 0;
  const toggleAgentList = isCompactLayout ? toggleMobileAgentList : toggleDesktopAgentList;
  const toggleDesktopSidebars = useCallback(() => {
    // The focused workspace owns its layout key, its checkout, and therefore the
    // only correct answer to "is the explorer open". Let it decide when there is
    // one: the pathname alone cannot identify the active workspace, because
    // desktop cold-starts at "/" and restores the workspace from route params.
    if (keyboardActionDispatcher.dispatch({ id: "sidebar.toggle.both", scope: "sidebar" })) {
      return;
    }
    // Off a workspace route there is no explorer — only the agent list.
    toggleAgentList();
  }, [keyboardActionDispatcher, toggleAgentList]);
  // TODO: stop matching pathname here as a branch. `chromeEnabled` should not
  // conflate workspace/project-specific chrome (sidebar, mobile gesture) with
  // global concerns like keyboard shortcuts. Split those out so settings (and
  // other non-workspace routes) don't need a special-case to keep shortcuts alive.
  const keyboardShortcutsEnabled = chromeEnabled || pathname.startsWith("/settings");

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    isMobile: isCompactLayout,
    isWorkspaceFocusModeEnabled,
    toggleAgentList,
    toggleBothSidebars: toggleDesktopSidebars,
    exitFocusMode,
    cycleTheme,
  });

  useActiveWorktreeNewAction();
  useGlobalNewWorkspaceAction();

  const {
    appChromeLayout,
    desktopSidebarMounted,
    divisionLayout,
    pimiSidebar,
    sidebarOccupiesColumn,
    sidebarPresentation,
  } = useAppSidebarLayout({
    chromeEnabled,
    isCompactLayout,
    isWorkspaceFocusModeEnabled,
    isWorkspaceRoute,
    pathname,
  });
  const ideProjects = pimiSidebar?.ide ? pimiSidebar : undefined;
  const sidebarChrome = (
    <SidebarChrome
      mounted={
        isCompactLayout ? chromeEnabled : desktopSidebarMounted && ideProjects?.mode !== "rail"
      }
      presentation={sidebarPresentation}
      keyboardShortcutsEnabled={keyboardShortcutsEnabled}
      pimiSidebar={pimiSidebar}
    />
  );
  let themedSidebarChrome = sidebarChrome;
  if (isWeb) {
    themedSidebarChrome = <AppearanceStyleBoundary>{sidebarChrome}</AppearanceStyleBoundary>;
  }
  const workspaceChrome = (
    <WindowLayoutSurface compact={isCompactLayout} style={rowStyle}>
      <WorkspaceLayoutModePublisher />
      {!isCompactLayout ? (
        <WindowChromeRegion corners={appChromeLayout.sidebarCorners}>
          {themedSidebarChrome}
        </WindowChromeRegion>
      ) : null}
      <WindowLayoutDivisionGap
        layout={divisionLayout}
        sidebarVisible={sidebarOccupiesColumn}
        compact={isCompactLayout}
      />
      <WorkspaceExplorerOpenGesture enabled={chromeEnabled && isCompactLayout}>
        <WindowChromeRegion
          corners={
            usesPimiMacTitlebar() || (isCompactLayout && chromeEnabled)
              ? "both"
              : appChromeLayout.contentCorners
          }
        >
          <PimiConsoleContent
            sidebar={sidebarOccupiesColumn}
            pathname={pathname}
            projects={ideProjects}
          >
            {children}
          </PimiConsoleContent>
        </WindowChromeRegion>
      </WorkspaceExplorerOpenGesture>
    </WindowLayoutSurface>
  );

  // Native panel gesture hosts outlive appearance keys, like native navigators.
  // Their tracked styles update in place; web numeric styles still need remounting.
  const surface = (
    <View style={layoutStyles.surfaceFill}>
      {workspaceChrome}
      <AddHostFlowHost />
      <AppearanceStyleBoundary>
        {!isCompactLayout && appChromeLayout.sidebarToggleOwner === "window" ? (
          <WindowChromeRegion corners="top-left">
            <WindowChromeSafeArea
              placement="inline"
              horizontalPadding={WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING}
              pointerEvents="box-none"
              style={layoutStyles.windowSidebarToggle}
            >
              <WindowSidebarMenuToggle />
            </WindowChromeSafeArea>
          </WindowChromeRegion>
        ) : null}
        <DesktopWindowControls />
        <FloatingPanelPortalHost />
      </AppearanceStyleBoundary>
      {isCompactLayout ? themedSidebarChrome : null}
      <PimiVoiceBubble
        enabled={chromeEnabled}
        aboveComposer={isWorkspaceRoute || pathname === "/new"}
      />
      <AppearanceStyleBoundary>
        <DownloadToast />
        <RosettaCalloutSource />
        <UpdateCalloutSource />
        <DaemonVersionCalloutSource />
        <LegacyAgentSkillsMigration />
        <WorkspaceSetupSuggestion inWorkspace={isWorkspaceRoute} />
        <CommandCenterRootActions />
        <CommandCenterSettingsActions />
        <CommandCenterWorkspaceActions />
        <PluginCommandCenterActions />
        <WorkspacePinShortcutHandler />
        <WorkspaceRenameHost />
        <WorkspaceArchiveUndoShortcutHost />
        <CommandCenter />
        <AddProjectFlowHost />
        <HostChooserModal />
        <HostConfirmationSheet />
        <ProviderSettingsHost />
        <WorkspaceSetupDialog />
        <KeyboardShortcutsDialog />
        <AppDiagnosticHost />
        <ChangelogHost />
        <Slot id="shell.overlays" context={NO_SLOT_CONTEXT} />
        <QuittingOverlay />
      </AppearanceStyleBoundary>
      {/* Setup changes the theme while it is open, so it stays out of the remount above. Its
          colors are CSS variables and themed props, which update in place, and setup changes no
          font size. */}
      <OnboardingHost />
      <RemoteSshUpgradeHost />
      <RemoteSshAuthHost />
    </View>
  );

  return (
    <AppContainerLifetime sidebarGesturesEnabled={sidebarPresentation === "overlay"}>
      <SheetHostScope enabled={isCompactLayout}>{surface}</SheetHostScope>
    </AppContainerLifetime>
  );
}

function useAppSidebarLayout({
  chromeEnabled,
  isCompactLayout,
  isWorkspaceFocusModeEnabled,
  isWorkspaceRoute,
  pathname,
}: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isWorkspaceFocusModeEnabled: boolean;
  isWorkspaceRoute: boolean;
  pathname: string;
}) {
  const hasMountedDesktopSidebar = useLatchedBoolean(chromeEnabled);
  const isDesktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const viewportWidth = windowWidth - insets.left - insets.right;
  const divisionLayout = resolveDesktopDivisionLayout({
    geometry: useWindowLayout(),
    windowWidth,
    windowHeight,
    leftInset: insets.left,
    rightInset: insets.right,
  });

  const activeWorkspace = useActiveWorkspaceSelection();
  const activeWorkspaceKey = activeWorkspace
    ? `${activeWorkspace.serverId}:${activeWorkspace.workspaceId}`
    : null;
  // Editor and Attack Mode both collapse the projects sidebar to its rail.
  const workbenchMode = usePimiWorkbenchMode(activeWorkspaceKey);
  const ide = workbenchMode === "editor" || workbenchMode === "attack";
  const explorerVisible = useIsExplorerSidebarOpen({
    isCompact: isCompactLayout,
    workspaceKey: activeWorkspaceKey,
  });
  const appContentMinimumWidth = resolveDesktopAppContentMinimum({
    explorerVisible: isWorkspaceRoute && explorerVisible,
    isSettingsRoute: pathname.includes("/settings"),
  });
  const desktopSidebarMounted = hasMountedDesktopSidebar && !isWorkspaceFocusModeEnabled;
  const pimiSidebarEnabled =
    chromeEnabled &&
    !isCompactLayout &&
    !isWorkspaceFocusModeEnabled &&
    Boolean(getDesktopHost()?.showPimiWorkspace);
  useFollowWorkbenchMode(activeWorkspaceKey, Boolean(getDesktopHost()?.showPimiWorkspace));
  useAttackNavigationAudit();
  useAttackCoverageReport();
  const desktopSidebarVisible = resolveDesktopSidebarVisibility({
    chromeEnabled,
    isCompactLayout,
    isMounted: desktopSidebarMounted,
    isOpen: isDesktopAgentListOpen,
    divisionLayout,
    canShare:
      pimiSidebarEnabled ||
      canDesktopAppSidebarShare({
        contentMinimumWidth: appContentMinimumWidth,
        requestedSidebarWidth: sidebarWidth,
        viewportWidth,
      }),
  });
  const pimiSidebar = usePimiSidebar(
    pimiSidebarEnabled,
    desktopSidebarVisible && !ide,
    pathname,
    ide,
  );
  const ideProjectsClosed = pimiSidebar?.ide === true && pimiSidebar.mode === "rail";
  const sidebarOccupiesColumn =
    !ideProjectsClosed && (desktopSidebarVisible || pimiSidebar !== undefined);
  const sidebarPresentation = resolveLeftSidebarPresentation({
    chromeEnabled,
    isCompactLayout,
    isFocusModeEnabled: isWorkspaceFocusModeEnabled || ideProjectsClosed,
    desktopSidebarVisible: sidebarOccupiesColumn,
  });
  const applyPanelLayout = usePanelStore((state) => state.applyPanelLayout);
  // Publishes the layout to the store, which owns the panel targets each layout allows.
  useLayoutEffect(() => {
    applyPanelLayout({ isCompact: isCompactLayout, leftSidebar: sidebarPresentation });
  }, [applyPanelLayout, isCompactLayout, sidebarPresentation]);
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  const appChromeLayout = resolveDesktopAppChromeLayout({
    desktopSidebarRendered: sidebarOccupiesColumn,
    hasTopLeftWindowControls,
    sidebarControlsEnabled:
      chromeEnabled &&
      !isWorkspaceFocusModeEnabled &&
      (!pimiSidebar || pimiSidebar.mode === "dock"),
  });
  return {
    appChromeLayout,
    desktopSidebarMounted,
    divisionLayout,
    pimiSidebar,
    sidebarOccupiesColumn,
    sidebarPresentation,
  };
}

function usePimiSidebar(
  enabled: boolean,
  docked: boolean,
  pathname: string,
  ide: boolean,
): PimiSidebarControls | undefined {
  const [peekPath, setPeekPath] = useState<string | null>(null);
  const openDesktopAgentList = usePanelStore((state) => state.openDesktopAgentList);
  const openPeek = useCallback(() => setPeekPath(pathname), [pathname]);
  const closePeek = useCallback(() => setPeekPath(null), []);
  const pin = useCallback(() => {
    closePeek();
    openDesktopAgentList();
  }, [closePeek, openDesktopAgentList]);
  const peeking = enabled && !docked && peekPath === pathname;

  useEffect(() => {
    if (!peeking) return;
    const content = document.getElementById(PIMI_CONSOLE_CONTENT_ID);
    const unlisten = getDesktopHost()?.onPimiWorkspaceClick?.(closePeek);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closePeek();
    };
    content?.addEventListener("click", closePeek, true);
    window.addEventListener("keydown", handleEscape);
    return () => {
      content?.removeEventListener("click", closePeek, true);
      window.removeEventListener("keydown", handleEscape);
      unlisten?.();
    };
  }, [closePeek, peeking]);

  useEffect(() => {
    if (!peeking) closePeek();
  }, [closePeek, peeking]);

  const unpinnedMode = peeking ? "peek" : "rail";
  return useMemo(
    () =>
      enabled ? { mode: docked ? "dock" : unpinnedMode, openPeek, closePeek, pin, ide } : undefined,
    [enabled, docked, unpinnedMode, openPeek, closePeek, pin, ide],
  );
}

function AppContainerLifetime({
  children,
  sidebarGesturesEnabled,
}: {
  children: ReactNode;
  sidebarGesturesEnabled: boolean;
}) {
  return (
    <ComposerEditingSessionsProvider>
      <CommandCenterProvider>
        <MobileGestureWrapper chromeEnabled={sidebarGesturesEnabled}>
          {children}
        </MobileGestureWrapper>
      </CommandCenterProvider>
    </ComposerEditingSessionsProvider>
  );
}

function SidebarChrome({
  mounted,
  presentation,
  keyboardShortcutsEnabled,
  pimiSidebar,
}: {
  mounted: boolean;
  presentation: LeftSidebarPresentation;
  keyboardShortcutsEnabled: boolean;
  pimiSidebar?: PimiSidebarControls;
}) {
  const isCompactLayout = useIsCompactFormFactor();
  const isMobileActive = useIsMobilePanelActive("agent-list");
  const overlay = presentation === "overlay";
  const active = pimiSidebar
    ? pimiSidebar.mode !== "rail"
    : resolveSidebarActivity(presentation !== "hidden", overlay, isMobileActive);
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  return (
    <SidebarModelProvider
      active={active}
      keyboardNavigationActive={keyboardShortcutsEnabled && hardwareKeyboardPresent}
    >
      {mounted ? (
        <LeftSidebar
          active={active}
          desktopOverlay={overlay && !isCompactLayout}
          pimiSidebar={pimiSidebar}
        />
      ) : null}
      <WorkspaceShortcutTargetsSubscriber enabled={keyboardShortcutsEnabled} />
    </SidebarModelProvider>
  );
}

function MobileGestureWrapper({
  children,
  chromeEnabled,
}: {
  children: ReactNode;
  chromeEnabled: boolean;
}) {
  const isCompactLayout = useIsCompactFormFactor();
  const openGesture = useOpenAgentListGesture(chromeEnabled);

  return (
    <GestureDetector gesture={openGesture} touchAction={MOBILE_WEB_GESTURE_TOUCH_ACTION}>
      <View
        collapsable={false}
        style={layoutStyles.surfaceFill}
        testID={isCompactLayout ? "compact-shell" : "wide-shell"}
      >
        {children}
      </View>
    </GestureDetector>
  );
}

function ProvidersWrapper({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider>
      <VoiceProvider>
        <DesktopWindowControlsSync />
        <OfferLinkListener />
        <HostSessionManager />
        <FaviconStatusSync />
        {children}
      </VoiceProvider>
    </AppearanceProvider>
  );
}

function DesktopWindowControlsSync() {
  const { isLoading } = useAppSettings();
  const { theme } = useUnistyles();
  const backgroundColor = usesPimiMacTitlebar()
    ? theme.colors.surfaceSidebar
    : theme.colors.surface0;

  useEffect(() => {
    if (isLoading || isNative) return;
    void updateDesktopWindowChrome({
      backgroundColor,
      trafficLightOffsetY: -4,
    }).catch((error) => {
      console.warn("[DesktopWindow] Failed to update window controls overlay", error);
    });
  }, [isLoading, backgroundColor]);

  return null;
}

function OfferLinkListener() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const handleUrl = async (url: string | null) => {
      if (!url) return;
      if (url.startsWith("pimi://pair")) return; // handled by the /pair route
      if (!url.includes("#offer=") && !url.includes("#connect=") && !url.startsWith("relay://"))
        return;
      try {
        const result = await getHostRuntimeStore().importConnectionLink(url, "openProject");
        if (!cancelled && result.status === "connected") router.replace(buildOpenProjectRoute());
      } catch (error) {
        console.warn("[OfferLinkListener] Pairing link failed", error);
      }
    };

    void Linking.getInitialURL()
      .then((url) => handleUrl(url))
      .catch(() => undefined);

    const subscription = Linking.addEventListener("url", (event) => {
      void handleUrl(event.url);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [router]);

  return null;
}

interface OpenProjectEventPayload {
  path?: unknown;
}

interface PendingOpenProjectRequest {
  id: number;
  serverId: string;
  path: string;
}

let nextOpenProjectRequestId = 1;

function OpenProjectListener() {
  const chooseHost = useHostChooser();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const [request, setRequest] = useState<PendingOpenProjectRequest | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const openProject = useOpenProject(request?.serverId ?? null);

  const openPathOnChosenHost = useCallback(
    (path: string) => {
      const nextPath = path.trim();
      if (!nextPath) {
        return;
      }

      if (!hostRegistryLoaded) {
        setPendingPath(nextPath);
        return;
      }

      chooseHost({
        title: "Choose host",
        onChooseHost: (serverId) => {
          setRequest({
            id: nextOpenProjectRequestId++,
            serverId,
            path: nextPath,
          });
        },
      });
    },
    [chooseHost, hostRegistryLoaded],
  );

  useEffect(() => {
    if (!hostRegistryLoaded || !pendingPath) {
      return;
    }
    const nextPath = pendingPath;
    setPendingPath(null);
    openPathOnChosenHost(nextPath);
  }, [hostRegistryLoaded, openPathOnChosenHost, pendingPath]);

  useEffect(() => {
    if (!request) {
      return;
    }
    let cancelled = false;
    void openProject(request.path).then((result) => {
      if (cancelled) {
        return null;
      }

      if (!result.ok) {
        setRequest((current) => (current?.id === request.id ? null : current));
        return null;
      }

      setRequest((current) => (current?.id === request.id ? null : current));
      return null;
    });
    return () => {
      cancelled = true;
    };
  }, [openProject, request]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getDesktopHost()
      ?.getPendingOpenProject?.()
      ?.then((pending) => {
        if (!disposed && pending) {
          openPathOnChosenHost(pending);
        }
        return;
      })
      .catch(() => undefined);

    // Listen for hot-start paths relayed via the second-instance event.
    void listenToDesktopEvent<OpenProjectEventPayload>("open-project", (payload) => {
      if (disposed) {
        return;
      }
      const nextPath = typeof payload?.path === "string" ? payload.path.trim() : "";
      openPathOnChosenHost(nextPath);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        return;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPathOnChosenHost]);

  return null;
}

function AppWithSidebar({ children }: { children: ReactNode }) {
  useSettingsRouteEntry();
  const pathname = usePathname();
  const hosts = useHosts();
  const storeReady = useStoreReady();
  const routeServerId = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  const routeHasKnownHost =
    routeServerId !== null && hosts.some((host) => host.serverId === routeServerId);
  const shouldShowAppChrome =
    storeReady &&
    (pathname === "/open-project" ||
      pathname === PIMI_AGENT_GRID_ROUTE ||
      pathname === PIMI_USAGE_ROUTE ||
      pathname === PIMI_TASKS_ROUTE ||
      pathname === PIMI_REVIEW_ROUTE ||
      pathname === PIMI_LIBRARY_ROUTE ||
      pathname === "/new" ||
      pathname === "/sessions" ||
      pathname === "/automations" ||
      pathname.startsWith("/automations/") ||
      pathname === "/profiles" ||
      pathname.startsWith("/profiles/") ||
      routeHasKnownHost);

  return <AppContainer chromeEnabled={shouldShowAppChrome}>{children}</AppContainer>;
}

function FaviconStatusSync() {
  useFaviconStatus();
  return null;
}

const ROOT_STACK_SCREEN_OPTIONS = {
  headerShown: false,
  animation: "none" as const,
};
const ROOT_STACK_NESTED_NAVIGATOR_SCREENS = ["h/[serverId]"] as const;

function RootStack() {
  const storeReady = useStoreReady();
  return (
    <ThemedStack
      screenOptions={ROOT_STACK_SCREEN_OPTIONS}
      nestedNavigatorScreens={ROOT_STACK_NESTED_NAVIGATOR_SCREENS}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="pair" />
      <Stack.Protected guard={storeReady}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/[section]" />
        <Stack.Screen name="new" />
        <Stack.Screen name="open-project" />
        <Stack.Screen name="pimi-agent-grid" />
        <Stack.Screen name="pimi-usage" />
        <Stack.Screen name="pimi-tasks" />
        <Stack.Screen name="pimi-review" />
        <Stack.Screen name="pimi-library" />
        <Stack.Screen name="sessions" />
        <Stack.Screen name="automations/index" />
        <Stack.Screen name="automations/new" />
        <Stack.Screen name="automations/[serverId]/[automationId]" />
        <Stack.Screen name="profiles/index" />
        <Stack.Screen name="profiles/[serverId]/[profileId]" />
      </Stack.Protected>
      <Stack.Screen name="h/[serverId]" />
      <Stack.Screen name="settings/hosts/[serverId]/index" />
      <Stack.Screen name="settings/hosts/[serverId]/[hostSection]" />
      <Stack.Screen name="settings/hosts/[serverId]/plugins/[pluginId]/[screenId]" />
      <Stack.Screen name="settings/hosts/[serverId]/projects/index" />
      <Stack.Screen name="settings/hosts/[serverId]/projects/[projectId]" />
    </ThemedStack>
  );
}

function WorkspaceRouteNavigationBridge() {
  const navigationRef = useNavigationContainerRef();

  useEffect(() => {
    return registerWorkspaceRouteNavigationRef(navigationRef);
  }, [navigationRef]);

  return null;
}

function AppShellBase() {
  useEffect(() => {
    if (getDesktopHost()) void ensureOsNotificationPermission();
  }, []);
  return (
    <MobilePanelsProvider>
      <HorizontalScrollProvider>
        <OpenProjectListener />
        <AgentNavigationListener />
        <AutomationDraftWatcher />
        <AppWithSidebar>
          <WorkspaceRouteNavigationBridge />
          <RootStack />
        </AppWithSidebar>
      </HorizontalScrollProvider>
    </MobilePanelsProvider>
  );
}

/** The whole app frame is a point, so a plugin can wrap or replace it. Safe mode renders this one. */
const AppShell = overridable("shell.root", AppShellBase, noProps());

function NotificationOpenBridge() {
  const { startupBlocker } = useHostRuntimeBootstrapState();
  return <NotificationOpenRouter startupBlocked={startupBlocker.kind !== "none"} />;
}

function RuntimeProviders({ children }: { children: ReactNode }) {
  return (
    <HostRuntimeBootstrapProvider>
      <NotificationOpenBridge />
      <SidebarCalloutProvider>
        <ProvidersWrapper>{children}</ProvidersWrapper>
      </SidebarCalloutProvider>
    </HostRuntimeBootstrapProvider>
  );
}

// PortalProvider must stay inside normal app-wide context providers.
// `@gorhom/portal` renders portaled children at the host's location in the
// tree, so any context a portaled sheet might consume (QueryClient, theme,
// auth, settings, ...) must wrap PortalProvider, not be wrapped by it.
// BottomSheetModalProvider is the exception: Gorhom modals consume portal
// context and need one shared provider for sibling sheets to stack.
function RootOverlayProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <PortalProvider>
        <BottomSheetModalProvider>
          {children}
          <WindowLayoutActionsHost />
        </BottomSheetModalProvider>
      </PortalProvider>
    </ToastProvider>
  );
}

function RootProviders({ children }: { children: ReactNode }) {
  return (
    <KeyboardActionDispatcherProvider>
      <WindowLayoutProvider>
        <WindowChromeProvider>
          <KeyboardProvider>
            <KeyboardShiftProvider>
              <RootOverlayProviders>{children}</RootOverlayProviders>
            </KeyboardShiftProvider>
          </KeyboardProvider>
        </WindowChromeProvider>
      </WindowLayoutProvider>
    </KeyboardActionDispatcherProvider>
  );
}

function RootAppTree() {
  return (
    <GestureHandlerRootView style={flexStyle}>
      <View style={layoutStyles.surfaceFill}>
        <LucideProvider strokeWidth={ICON_STROKE_WIDTH}>
          <AddHostProvider>
            <RootProviders>
              <RuntimeProviders>
                <AppShell />
              </RuntimeProviders>
            </RootProviders>
          </AddHostProvider>
        </LucideProvider>
      </View>
    </GestureHandlerRootView>
  );
}

installMemoryProbe();

export default function RootLayout() {
  useEffect(() => installWebScrollbarStyles(), []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        void flushDraftPersistStorage();
      }
    });
    return () => subscription.remove();
  }, []);

  return <RootAppTree />;
}

const layoutStyles = StyleSheet.create((theme) => ({
  surfaceFill: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  windowSidebarToggle: {
    position: "absolute",
    top: 1,
    left: 0,
    zIndex: 20,
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
}));
