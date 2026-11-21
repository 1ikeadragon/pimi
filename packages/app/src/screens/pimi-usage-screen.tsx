// Pimi. PolyForm-Noncommercial-1.0.0.
import { useIsFocused } from "expo-router/react-navigation";
import { useLocalSearchParams } from "expo-router";
import { X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { closePimiUsage } from "@/navigation/pimi-usage";
import { useHostUsageWithControls, type UsageHostSelection } from "@/usage/controls";
import { useUsageDisplay } from "@/usage/display";
import { useUsageHostSelection } from "@/usage/hosts";
import { UsageRecap } from "@/usage/recap";
import { UsageOverview } from "@/usage/overview";
import { PimiSessionUsage } from "@/usage/pimi-session-usage";
import { UsageBody, UsageMessage } from "@/usage/usage-section";
import { isPimiAndroid } from "@/utils/pimi-mobile";

type UsageTab = "overview" | "limits" | "sessions" | "recap";
const PIMI_BACKGROUND = { "pimi-background": "" };

/**
 * Settings renders this screen for one host: `hostServerId` pins the host and replaces the picker,
 * the close button goes away, and `onBack` swaps the titlebar for a back header on compact.
 */
interface PimiUsageScreenProps {
  hostServerId?: string;
  onBack?: () => void;
}

export function PimiUsageScreen({ hostServerId, onBack }: PimiUsageScreenProps = {}) {
  const focused = useIsFocused();
  const covered = usePimiWorkspaceSection() !== null;
  const { t } = useTranslation();
  const [tab, setTab] = useState<UsageTab>("overview");
  const tabs = useMemo<SegmentedControlOption<UsageTab>[]>(
    () => [
      { value: "overview", label: t("usageOverview.tabs.overview") },
      { value: "limits", label: t("usageOverview.tabs.limits") },
      { value: "sessions", label: t("usageOverview.tabs.chats") },
      { value: "recap", label: t("usageOverview.tabs.recap") },
    ],
    [t],
  );
  const close = useMemo(
    () =>
      hostServerId ? undefined : (
        <ToolbarButton label={t("usageOverview.close")} onPress={closePimiUsage}>
          <DensityIcon icon={X} size="sm" color="foregroundMuted" />
        </ToolbarButton>
      ),
    [t, hostServerId],
  );
  const {
    tab: requestedTab,
    session,
    serverId,
    agentId,
  } = useLocalSearchParams<{
    tab?: string;
    session?: string;
    serverId?: string;
    agentId?: string;
  }>();
  useEffect(() => {
    if (
      requestedTab === "sessions" ||
      requestedTab === "limits" ||
      (requestedTab === "recap" && !isPimiAndroid())
    ) {
      setTab(requestedTab);
    } else {
      setTab("overview");
    }
  }, [requestedTab, session, serverId, agentId]);
  const visibleTabs = isPimiAndroid() ? tabs.filter((option) => option.value !== "recap") : tabs;

  if (!focused || covered) return <View style={styles.screen} />;
  return (
    <View style={styles.screen} dataSet={PIMI_BACKGROUND} testID="pimi-usage">
      {onBack ? (
        <BackHeader title={t("usageOverview.title")} onBack={onBack} />
      ) : (
        <MenuHeader
          title={t("usageOverview.title")}
          rightContent={close}
          inPimiTitlebar={!hostServerId}
        />
      )}
      <View style={styles.toolbar}>
        <SegmentedControl options={visibleTabs} value={tab} onValueChange={setTab} />
      </View>
      {tab === "sessions" && (
        <PimiSessionUsage
          key={JSON.stringify([session, serverId, agentId])}
          initialQuery={session}
          initialSessionKey={
            !session && serverId && agentId ? JSON.stringify([serverId, agentId]) : undefined
          }
        />
      )}
      {tab === "overview" && <OverviewTab pinnedServerId={hostServerId} />}
      {tab === "limits" && <ProviderLimits pinnedServerId={hostServerId} />}
      {tab === "recap" && <RecapTab pinnedServerId={hostServerId} />}
    </View>
  );
}

/** The host a tab shows: the pinned one inside Settings, otherwise the saved pick. */
function useTabHost(pinnedServerId: string | undefined) {
  const selection = useUsageHostSelection();
  if (pinnedServerId) return { serverId: pinnedServerId, connectedHosts: [], select: noSelect };
  return selection;
}

function noSelect(): void {}

function OverviewTab({ pinnedServerId }: { pinnedServerId?: string }) {
  const { t } = useTranslation();
  const { serverId } = useTabHost(pinnedServerId);
  return (
    <ScrollView style={styles.scroll}>
      <View style={styles.limits} testID="pimi-usage-overview">
        {serverId ? (
          <UsageOverview key={serverId} serverId={serverId} />
        ) : (
          <UsageMessage text={t("providerUsage.noHosts")} />
        )}
      </View>
    </ScrollView>
  );
}

function RecapTab({ pinnedServerId }: { pinnedServerId?: string }) {
  const { t } = useTranslation();
  const { serverId } = useTabHost(pinnedServerId);
  if (!serverId) return <UsageMessage text={t("providerUsage.noHosts")} />;
  return <UsageRecap key={serverId} serverId={serverId} />;
}

function ProviderLimits({ pinnedServerId }: { pinnedServerId?: string }) {
  const { t } = useTranslation();
  const { serverId, connectedHosts, select } = useTabHost(pinnedServerId);
  return (
    <ScrollView style={styles.scroll}>
      <View style={styles.limits} testID="pimi-usage-limits">
        {serverId ? (
          <HostLimits key={serverId} serverId={serverId} hosts={connectedHosts} onSelect={select} />
        ) : (
          <UsageMessage text={t("providerUsage.noHosts")} />
        )}
      </View>
    </ScrollView>
  );
}

function HostLimits({ serverId, hosts, onSelect }: UsageHostSelection) {
  const selection = useMemo(() => ({ serverId, hosts, onSelect }), [serverId, hosts, onSelect]);
  const { view, refresh, controls } = useHostUsageWithControls(selection);
  const { display } = useUsageDisplay(view.kind === "ready" ? view.reports : []);
  return (
    <>
      {controls}
      <UsageBody serverId={serverId} view={view} display={display} onRefresh={refresh} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surfaceWindow },
  toolbar: {
    width: "100%",
    maxWidth: 980,
    alignSelf: "center",
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
  },
  scroll: { flex: 1 },
  limits: {
    width: "100%",
    maxWidth: 980,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[4],
  },
}));
