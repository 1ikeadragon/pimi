// Pimi addition to the Paseo fork. Apache-2.0.
import { useIsFocused } from "expo-router/react-navigation";
import { X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PimiSkillsLibrary } from "@/agent-skills/pimi-skills-library";
import { MenuHeader } from "@/components/headers/menu-header";
import { SettingsCard, SettingsSelect } from "@/components/settings";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { closePimiLibrary, type PimiLibrarySection } from "@/navigation/pimi-library";
import { useHosts } from "@/runtime/host-runtime";
import { TerminalHooksSection } from "@/terminal-hooks";
import { orderHostsLocalFirst } from "@/types/host-connection";

const BACKGROUND = { "pimi-background": "" };

export function PimiLibraryScreen({ section }: { section: PimiLibrarySection }) {
  const focused = useIsFocused();
  const covered = usePimiWorkspaceSection() !== null;
  const localServerId = useLocalDaemonServerId();
  const hosts = useHosts();
  const [selectedServerId, setSelectedServerId] = useState<string>();
  const orderedHosts = orderHostsLocalFirst(hosts, localServerId);
  const host = hosts.find(({ serverId }) => serverId === selectedServerId) ?? orderedHosts[0];
  const title = section === "skills" ? "Skills" : "Hooks";
  const close = useMemo(
    () => (
      <ToolbarButton label={`Close ${title}`} onPress={closePimiLibrary}>
        <DensityIcon icon={X} size="sm" color="foregroundMuted" />
      </ToolbarButton>
    ),
    [title],
  );

  if (!focused || covered) return <View style={styles.screen} />;
  return (
    <View style={styles.screen} dataSet={BACKGROUND} testID={`pimi-library-${section}`}>
      <MenuHeader title={title} rightContent={close} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {host ? (
          <>
            <SettingsCard>
              <SettingsSelect
                label="Host"
                value={host.serverId}
                options={orderedHosts.map(({ serverId, label }) => ({ value: serverId, label }))}
                onValueChange={setSelectedServerId}
                disabled={orderedHosts.length < 2}
              />
            </SettingsCard>
            {section === "skills" ? (
              <PimiSkillsLibrary key={host.serverId} serverId={host.serverId} />
            ) : (
              <TerminalHooksSection key={host.serverId} serverId={host.serverId} />
            )}
          </>
        ) : (
          <Text style={styles.empty}>Connect a host to manage {title.toLowerCase()}.</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1 },
  content: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
