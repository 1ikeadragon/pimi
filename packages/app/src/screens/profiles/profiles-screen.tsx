import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@pimi/protocol/messages";
import type { ProviderSnapshotEntry } from "@pimi/protocol/agent-types";
import { AgentProfileGlyph, buildAgentProfileTags, useAgentProfiles } from "@/agent-profiles";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { buildProfileEditorRoute } from "@/utils/host-routes";
import { profileUsageKey, useProfileUsage, type ProfileUsage } from "./use-profile-usage";

export function ProfilesScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <ProfilesScreenContent />;
}

function ProfilesScreenContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const usage = useProfileUsage();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const visibleHosts = useMemo(
    () =>
      selectedHost === ALL_HOSTS_OPTION_ID
        ? hosts
        : hosts.filter((host) => host.serverId === selectedHost),
    [hosts, selectedHost],
  );
  const multipleHosts = hosts.length > 1;

  return (
    <View style={styles.container}>
      <MenuHeader title={t("profiles.title")} inPimiTitlebar />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="profiles-list"
      >
        <View style={styles.intro}>
          <Text style={styles.description}>{t("profiles.description")}</Text>
          {multipleHosts ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={setSelectedHost}
              triggerTestID="profiles-host-filter-trigger"
            />
          ) : null}
        </View>
        {visibleHosts.map((host) => (
          <HostProfilesSection
            key={host.serverId}
            serverId={host.serverId}
            serverName={host.label}
            showHostName={multipleHosts}
            usage={usage}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function HostProfilesSection({
  serverId,
  serverName,
  showHostName,
  usage,
}: {
  serverId: string;
  serverName: string;
  showHostName: boolean;
  usage: ProfileUsage;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { profiles } = useAgentProfiles(isConnected ? serverId : null);
  const { entries } = useProvidersSnapshot(isConnected ? serverId : null, { cwd: null });

  const openNew = useCallback(() => {
    router.push(buildProfileEditorRoute(serverId, "new"));
  }, [router, serverId]);

  let body: ReactElement;
  if (!isConnected) {
    body = <Text style={styles.muted}>{t("profiles.unavailable")}</Text>;
  } else if (profiles === null) {
    body = (
      <View style={styles.loadingRow}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
        <Text style={styles.muted}>{t("profiles.loading")}</Text>
      </View>
    );
  } else if (profiles.length === 0) {
    body = <Text style={styles.muted}>{t("profiles.empty")}</Text>;
  } else {
    body = (
      <View style={styles.grid}>
        {profiles.map((profile) => (
          <ProfileCard
            key={profile.id}
            serverId={serverId}
            profile={profile}
            entries={entries}
            usedBy={usage.byProfile.get(profileUsageKey(serverId, profile.id))?.length ?? 0}
          />
        ))}
      </View>
    );
  }

  return (
    <View style={styles.section} testID={`profiles-host-${serverId}`}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{showHostName ? serverName : ""}</Text>
        <Button
          variant="outline"
          leftIcon={Plus}
          onPress={openNew}
          disabled={!isConnected || profiles === null}
          testID="profiles-new"
        >
          {t("profiles.newProfile")}
        </Button>
      </View>
      {body}
    </View>
  );
}

function ProfileCard({
  serverId,
  profile,
  entries,
  usedBy,
}: {
  serverId: string;
  profile: AgentProfile;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  usedBy: number;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const open = useCallback(() => {
    router.push(buildProfileEditorRoute(serverId, profile.id));
  }, [profile.id, router, serverId]);
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const cardStyle = useMemo(() => [styles.card, hovered ? styles.cardHovered : null], [hovered]);
  const summary = useMemo(
    () =>
      buildAgentProfileTags({
        profile,
        entries,
        formatFeatureCount: (count) =>
          count === 1
            ? t("settings.host.agentProfiles.featureCountOne", { count })
            : t("settings.host.agentProfiles.featureCount", { count }),
        anyProviderLabel: t("profiles.anyProvider"),
      })
        .map((tag) => tag.label)
        .join(" · "),
    [entries, profile, t],
  );

  return (
    <PressHighlight
      onPress={open}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={cardStyle}
      highlightStyle={styles.cardHovered}
      accessibilityRole="button"
      accessibilityLabel={profile.name}
      testID={`profile-card-${profile.id}`}
    >
      <View style={styles.cardHeader}>
        <AgentProfileGlyph icon={profile.icon} color={profile.color} />
        <Text style={styles.cardTitle} numberOfLines={1}>
          {profile.name}
        </Text>
        {profile.builtin ? (
          <View style={styles.tag}>
            <Text style={styles.tagText}>{t("profiles.builtIn")}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.cardSummary} numberOfLines={1}>
        {summary}
      </Text>
      {profile.notes ? (
        <Text style={styles.cardNotes} numberOfLines={3}>
          {profile.notes}
        </Text>
      ) : null}
      {usedBy > 0 ? (
        <Text style={styles.cardUsage}>
          {usedBy === 1
            ? t("profiles.usedByOne", { count: usedBy })
            : t("profiles.usedBy", { count: usedBy })}
        </Text>
      ) : null}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[6],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
  intro: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  description: {
    flex: 1,
    minWidth: 240,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  section: {
    gap: theme.spacing[3],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  card: {
    width: { xs: "100%", md: 300 },
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardHovered: {
    backgroundColor: theme.colors.surface2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  tag: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  tagText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  cardSummary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  cardNotes: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  cardUsage: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
