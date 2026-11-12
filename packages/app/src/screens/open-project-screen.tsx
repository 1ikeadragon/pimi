import { useHosts, useHostRuntimeLastError } from "@/runtime/host-runtime";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, Pressable, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import {
  CircleGauge,
  FolderOpen,
  Inbox,
  LayoutGrid,
  MessageSquare,
  NotebookText,
  Plug,
  Smartphone,
} from "lucide-react-native";
import { PimiLogo } from "@/components/icons/pimi-logo";
import { MenuHeader } from "@/components/headers/menu-header";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useImportSession } from "@/hooks/use-import-session";
import { useHostChooser } from "@/hosts/host-chooser";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { getDesktopHost } from "@/desktop/host";
import { PairDeviceModal } from "@/desktop/components/pair-device-modal";
import { buildNewWorkspaceRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { openPimiAgentGrid } from "@/navigation/pimi-agent-grid";
import { openPimiUsage } from "@/navigation/pimi-usage";
import { isPimiAndroid } from "@/utils/pimi-mobile";

const WINDOW_CONTENT_DATASET = { "window-content": "" };
const PIMI_BACKGROUND = { "pimi-background": "" };

export function OpenProjectScreen() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const router = useRouter();
  const showPimiWorkspace = getDesktopHost()?.showPimiWorkspace;
  const pimi = Boolean(showPimiWorkspace) || isPimiAndroid();
  const openMemory = useCallback(
    () => showPimiWorkspace?.({ view: "memory" }),
    [showPimiWorkspace],
  );
  const openDesktopAgentList = usePanelStore((s) => s.openDesktopAgentList);
  const openProjectPicker = useOpenAddProject();
  const importSession = useImportSession();
  const chooseHost = useHostChooser();
  const localServerId = useLocalDaemonServerId();
  const [isPairDeviceOpen, setIsPairDeviceOpen] = useState(false);

  const isCompactLayout = useIsCompactFormFactor();

  useEffect(() => {
    if (!isCompactLayout) {
      openDesktopAgentList();
    }
  }, [isCompactLayout, openDesktopAgentList]);

  const handleOpenPicker = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleOpenPairDevice = useCallback(() => setIsPairDeviceOpen(true), []);
  const handleClosePairDevice = useCallback(() => setIsPairDeviceOpen(false), []);
  const startChat = useCallback(
    () =>
      router.push(
        buildNewWorkspaceRoute({ serverId: localServerId ?? undefined, chooseProject: true }),
      ),
    [localServerId, router],
  );

  const handleOpenProviders = useCallback(() => {
    chooseHost({
      title: "Choose host",
      onChooseHost: (serverId) => {
        router.push(buildSettingsHostSectionRoute(serverId, "providers"));
      },
    });
  }, [chooseHost, router]);

  return (
    <View style={styles.container} dataSet={pimi ? PIMI_BACKGROUND : undefined}>
      <MenuHeader borderless />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        dataSet={WINDOW_CONTENT_DATASET}
      >
        <View style={styles.content}>
          <View style={styles.logo}>
            {pimi ? (
              <View style={styles.pimiIntro}>
                <Text style={styles.pimiBrand}>Pimi</Text>
                <Text style={styles.pimiTitle}>Start a conversation</Text>
                <Text style={styles.pimiHint}>
                  Ask about your code or explore an idea with an agent.
                </Text>
              </View>
            ) : (
              <PimiLogo size={52} />
            )}
          </View>
          {hosts.map((host) => (
            <HostError key={host.serverId} serverId={host.serverId} label={host.label} />
          ))}
          <View style={styles.tiles}>
            {pimi ? (
              <HomeTile
                icon={MessageSquare}
                title={t("newWorkspace.title")}
                description="Choose a project to start a chat or open a workspace."
                onPress={startChat}
                accent
              />
            ) : null}
            {pimi ? (
              <HomeTile
                icon={LayoutGrid}
                title="Agent grid"
                description="Watch live agent conversations side by side."
                onPress={openPimiAgentGrid}
                testID="pimi-open-agent-grid"
              />
            ) : null}
            {showPimiWorkspace ? (
              <HomeTile
                icon={NotebookText}
                title="Memory"
                description="Review notes shared across projects or saved to one project."
                onPress={openMemory}
                testID="pimi-open-memory"
              />
            ) : null}
            {pimi ? (
              <HomeTile
                icon={CircleGauge}
                title="Usage"
                description="See context, tokens, and provider limits."
                onPress={openPimiUsage}
                testID="pimi-open-usage"
              />
            ) : null}
            <HomeTile
              icon={FolderOpen}
              title={t("openProject.tiles.addProject.title")}
              description={t("openProject.tiles.addProject.description")}
              onPress={handleOpenPicker}
              testID="open-project-submit"
              accent={!pimi}
            />
            <HomeTile
              icon={Inbox}
              title={t("openProject.tiles.importSession.title")}
              description={t("openProject.tiles.importSession.description")}
              onPress={importSession.open}
              testID="open-project-import-session"
            />
            <HomeTile
              icon={Plug}
              title={t("openProject.tiles.setupProviders.title")}
              description={t("openProject.tiles.setupProviders.description")}
              onPress={handleOpenProviders}
              testID="open-project-setup-providers"
            />
            {localServerId ? (
              <HomeTile
                icon={Smartphone}
                title={t("openProject.tiles.pairDevice.title")}
                description={
                  pimi
                    ? "Connect your phone to Pimi."
                    : t("openProject.tiles.pairDevice.description")
                }
                onPress={handleOpenPairDevice}
                testID="open-project-pair-device"
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
      <PairDeviceModal
        serverId={localServerId ?? ""}
        visible={isPairDeviceOpen}
        onClose={handleClosePairDevice}
        testID="open-project-pair-device-modal"
      />
      {importSession.sheet}
    </View>
  );
}

function HostError({ serverId, label }: { serverId: string; label: string }) {
  const error = useHostRuntimeLastError(serverId);
  return error ? (
    <Text accessibilityRole="alert" style={styles.hostError}>
      {label}: {error}
    </Text>
  ) : null;
}

interface HomeTileProps {
  icon: ComponentType<{ size: number; color: string }>;
  title: string;
  description: string;
  onPress: () => void;
  testID?: string;
  accent?: boolean;
}

function HomeTile({ icon: Icon, title, description, onPress, testID, accent }: HomeTileProps) {
  // useUnistyles is acceptable here: leaf component, off the hot path (home screen renders once).
  const { theme } = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const iconColor = accent ? theme.colors.accent : theme.colors.foregroundMuted;

  const pressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.tile,
      hovered && styles.tileHovered,
      pressed && styles.tilePressed,
    ],
    [hovered],
  );

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      testID={testID}
      style={pressableStyle}
    >
      <Icon size={20} color={iconColor} />
      <View style={styles.tileText}>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileDescription}>{description}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    position: "relative",
    flexGrow: 1,
    flexShrink: 0,
    justifyContent: { xs: "flex-start", md: "center" },
    alignItems: "center",
    gap: 0,
    padding: theme.spacing[6],
    paddingTop: { xs: theme.spacing[12], md: theme.spacing[6] },
  },
  logo: {
    marginBottom: theme.spacing[8],
  },
  pimiIntro: { alignItems: "center", gap: 6 },
  pimiBrand: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.semibold },
  pimiTitle: {
    color: theme.colors.foreground,
    fontSize: 30,
    fontWeight: theme.fontWeight.semibold,
  },
  pimiHint: { color: theme.colors.foregroundMuted, textAlign: "center" },
  hostError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    maxWidth: 452,
    textAlign: "center",
  },
  tiles: {
    marginTop: { xs: theme.spacing[6], md: theme.spacing[12] },
    width: "100%",
    maxWidth: 452,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  tile: {
    width: { xs: "100%", md: 220 },
    minHeight: { xs: 0, md: 132 },
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    gap: theme.spacing[3],
  },
  tileHovered: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  tilePressed: {
    opacity: 0.85,
  },
  tileText: {
    gap: theme.spacing[1],
  },
  tileTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tileDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 18,
  },
}));
