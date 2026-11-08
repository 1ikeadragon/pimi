import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderHarnessUpdateChannel } from "@pimi/protocol/provider-harness-updates";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHarnessUpdates } from "@/hooks/use-harness-updates";
import { settingsStyles } from "@/styles/settings";

const updateGuides: Record<ProviderHarnessUpdateChannel, string> = {
  "claude-stable": "https://code.claude.com/docs/en/setup#update-claude-code",
  "codex-cli": "https://developers.openai.com/codex/cli",
  "codex-app": "https://developers.openai.com/codex/app",
  copilot:
    "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  omp: "https://github.com/can1357/oh-my-pi#install",
  "opencode-v1": "https://docs.opencode.ai/docs/cli/#upgrade",
  "opencode-v2": "https://opencode.ai/docs/cli#upgrade",
  pi: "https://pi.dev/",
};

export function HarnessUpdatesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { data, enabled, isFetching, isError, checkNow } = useHarnessUpdates(serverId);
  const handleCheck = useCallback(() => void checkNow().catch(() => undefined), [checkNow]);
  const checkButton = useMemo(
    () => (
      <Button
        size="sm"
        variant="ghost"
        loading={isFetching}
        onPress={handleCheck}
        testID="provider-harness-check-now"
      >
        {t("harnessUpdates.check")}
      </Button>
    ),
    [handleCheck, isFetching, t],
  );
  if (!enabled) return null;
  const updates = data?.updates ?? [];
  let emptyLabel = "harnessUpdates.empty";
  if (isError) emptyLabel = "harnessUpdates.failed";
  if (isFetching) emptyLabel = "harnessUpdates.checking";
  return (
    <SettingsSection
      title={t("harnessUpdates.title")}
      testID="provider-harness-updates"
      trailing={checkButton}
    >
      <View style={settingsStyles.card}>
        {isError || updates.length === 0 ? (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint} accessibilityLiveRegion="polite">
              {t(emptyLabel)}
            </Text>
          </View>
        ) : null}
        {updates.map(
          ({ provider, label, channel, installedVersion, latestVersion, status }, index) => (
            <View
              key={provider}
              style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}
            >
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {channel === "claude-stable"
                    ? t("harnessUpdates.stableChannel", { label })
                    : label}
                </Text>
                <Text style={settingsStyles.rowHint}>
                  {t("harnessUpdates.installed", { version: installedVersion })}
                </Text>
                <Text
                  style={[settingsStyles.rowHint, status === "update_available" && styles.update]}
                >
                  {t(`harnessUpdates.status.${status}`, { version: latestVersion })}
                </Text>
              </View>
              <ExternalLink href={updateGuides[channel]} label={t("harnessUpdates.guide")} />
            </View>
          ),
        )}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  update: {
    color: theme.colors.statusWarning,
    fontWeight: theme.fontWeight.semibold,
  },
}));
