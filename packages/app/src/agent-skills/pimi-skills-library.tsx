import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "expo-router/react-navigation";
import { View } from "react-native";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { SkillSelectionSheet } from "./selection-sheet";
import { useAgentSkills } from "./use-agent-skills";

export function PimiSkillsLibrary({ serverId }: { serverId: string }) {
  const { connected, status, isLoading, isWorking, refresh, reconcile, saveSelection } =
    useAgentSkills(serverId);
  const [chooserHost, setChooserHost] = useState<string | null>(null);
  const retry = useCallback(() => void refresh(), [refresh]);
  const apply = useCallback(() => void reconcile(), [reconcile]);
  const openChooser = useCallback(() => setChooserHost(serverId), [serverId]);
  const closeChooser = useCallback(() => setChooserHost(null), []);
  const canChoose = !isWorking && Boolean(status?.available.length);
  const choose = useMemo(
    () => (
      <Button variant="outline" onPress={openChooser} disabled={!canChoose}>
        Choose skills
      </Button>
    ),
    [canChoose, openChooser],
  );
  useFocusEffect(
    useCallback(() => {
      if (connected) void refresh();
    }, [connected, refresh]),
  );

  if (!connected || !status) {
    let message = "Connect to this host to manage its Pimi skills.";
    if (connected) {
      if (isLoading) message = "Checking installed skills…";
      else message = "Could not load installed skills.";
    }

    return (
      <SettingsSection title="Pimi skills">
        <SettingsCard>
          <SettingsRow label={message}>
            {connected && !isLoading ? (
              <Button variant="outline" onPress={retry}>
                Retry
              </Button>
            ) : null}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  const installed = new Set(status.installed);
  const catalog = new Set(status.available);
  const operations = new Map(status.ops.map((op) => [op.name, op.kind]));
  const hasAdd = status.ops.some((op) => op.kind === "add");
  const hasUpdate = status.ops.some((op) => op.kind === "update");
  const available = status.available.filter((name) => !installed.has(name));
  let applyLabel = "Install selected";
  if (hasUpdate) applyLabel = hasAdd ? "Install and update selected" : "Update selected";

  return (
    <View testID="pimi-skills-library">
      <SettingsSection
        title="Installed"
        info="This list covers the skills in Pimi’s bundled catalog and its earlier versions."
        testID="pimi-skills-installed"
        trailing={choose}
      >
        <SettingsCard>
          {status.installed.length === 0 ? (
            <SettingsRow label="No Pimi skills installed" />
          ) : (
            status.installed.map((name) => {
              const operation = operations.get(name);
              let hint: string | undefined;
              if (!catalog.has(name)) hint = "From an earlier version";
              else if (operation === "add") hint = "Missing on some harnesses";
              else if (operation === "update") hint = "Update available";
              else if (operation === "delete") hint = "Outside your selection";
              return <SettingsRow key={name} label={name} hint={hint} />;
            })
          )}
        </SettingsCard>
      </SettingsSection>

      {available.length > 0 ? (
        <SettingsSection title="Available" testID="pimi-skills-available">
          <SettingsCard>
            {available.map((name) => (
              <SettingsRow
                key={name}
                label={name}
                hint={operations.get(name) === "add" ? "Selected" : undefined}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {hasAdd || hasUpdate ? (
        <Button onPress={apply} loading={isWorking} disabled={isWorking}>
          {applyLabel}
        </Button>
      ) : null}

      <SkillSelectionSheet
        key={serverId}
        visible={chooserHost === serverId}
        available={status.available}
        selection={status.selection}
        isSaving={isWorking}
        onSave={saveSelection}
        onClose={closeChooser}
      />
    </View>
  );
}
