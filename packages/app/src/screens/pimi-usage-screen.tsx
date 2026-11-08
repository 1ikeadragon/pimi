// Pimi addition to the Paseo fork. Apache-2.0.
import { useIsFocused } from "expo-router/react-navigation";
import { useLocalSearchParams } from "expo-router";
import { X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { closePimiUsage } from "@/navigation/pimi-usage";
import { useHostUsageWithControls, type UsageHostSelection } from "@/usage/controls";
import { useUsageDisplay } from "@/usage/display";
import { useUsageHostSelection } from "@/usage/hosts";
import { PimiRecapUsage } from "@/usage/pimi-recap-usage";
import { PimiSessionUsage } from "@/usage/pimi-session-usage";
import { UsageBody, UsageMessage } from "@/usage/usage-section";
import { isPimiAndroid } from "@/utils/pimi-mobile";

type UsageTab = "sessions" | "limits" | "recap";
const tabs: SegmentedControlOption<UsageTab>[] = [
  { value: "sessions", label: "Sessions" },
  { value: "limits", label: "Provider limits" },
  { value: "recap", label: "Recap" },
];
const PIMI_BACKGROUND = { "pimi-background": "" };
const close = (
  <ToolbarButton label="Close Usage" onPress={closePimiUsage}>
    <DensityIcon icon={X} size="sm" color="foregroundMuted" />
  </ToolbarButton>
);

export function PimiUsageScreen() {
  const focused = useIsFocused();
  const covered = usePimiWorkspaceSection() !== null;
  const [tab, setTab] = useState<UsageTab>("sessions");
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
    if (requestedTab === "limits" || requestedTab === "sessions") setTab(requestedTab);
    if (requestedTab === "recap" && !isPimiAndroid()) setTab(requestedTab);
  }, [requestedTab, session, serverId, agentId]);
  const visibleTabs = isPimiAndroid() ? tabs.filter((option) => option.value !== "recap") : tabs;

  if (!focused || covered) return <View style={styles.screen} />;
  return (
    <View style={styles.screen} dataSet={PIMI_BACKGROUND} testID="pimi-usage">
      <MenuHeader title="Usage" rightContent={close} />
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
      {tab === "limits" && <ProviderLimits />}
      {tab === "recap" && <PimiRecapUsage />}
    </View>
  );
}

function ProviderLimits() {
  const { t } = useTranslation();
  const { serverId, connectedHosts, select } = useUsageHostSelection();
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
  screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface0 },
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
