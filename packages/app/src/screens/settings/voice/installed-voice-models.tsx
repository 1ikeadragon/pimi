// Pimi addition to the Paseo fork. Apache-2.0.
import { useCallback, useMemo } from "react";
import { FolderOpen } from "lucide-react-native";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import type { LocalSpeechModel } from "@pimi/protocol/speech/rpc-schemas";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsRow,
  SettingsSection,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { useToast } from "@/contexts/toast-api-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { settingsStyles } from "@/styles/settings";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

export function InstalledVoiceModels({
  models,
  serverId,
}: {
  models: LocalSpeechModel[];
  serverId: string;
}) {
  const { t } = useTranslation();
  const isLocal = useIsLocalDaemon(serverId);
  const installed = models.filter((model) => model.status === "installed");
  const { targets } = useDesktopOpenTargets({
    isLocalExecution: isLocal && installed.some((model) => model.installation),
  });
  const fileManager = targets.find((target) => target.kind === "file-manager");

  if (installed.length === 0) return null;

  return (
    <SettingsSection title={t("settings.voice.installation.title")} testID="installed-voice-models">
      <SettingsCard>
        {installed.map((model) => (
          <InstalledVoiceModel key={model.id} model={model} fileManagerId={fileManager?.id} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function InstalledVoiceModel({
  model,
  fileManagerId,
}: {
  model: LocalSpeechModel;
  fileManagerId?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { id, label, archiveUrl, archiveSha256, installation } = model;
  const directory = installation?.directory;
  const reveal = useCallback(() => {
    if (!fileManagerId || !directory) return;
    void openDesktopTarget({
      editorId: fileManagerId,
      workspacePath: directory,
      filePath: directory,
    }).catch(() => toast.error(t("sidebar.project.actions.openFolderFailed")));
  }, [directory, fileManagerId, t, toast]);
  const hints = useMemo(
    () => ({
      directory: selectableDetail(directory),
      source: selectableDetail(archiveUrl),
      checksum: selectableDetail(archiveSha256),
    }),
    [archiveSha256, archiveUrl, directory],
  );

  if (!installation || !archiveUrl) {
    return <SettingsRow label={label} hint={t("settings.voice.installation.unavailable")} />;
  }
  let status = t("settings.voice.installation.noPublishedDigest");
  if (archiveSha256) {
    status = installation.archiveVerified
      ? t("settings.voice.installation.verified")
      : t("settings.voice.installation.unrecorded");
  }
  return (
    <SettingsCollapsibleRow label={label} summary={status} testID={`voice-installation-${id}`}>
      <SettingsRow label={t("settings.voice.installation.location")} hint={hints.directory}>
        {fileManagerId ? (
          <Button
            variant="ghost"
            leftIcon={FolderOpen}
            onPress={reveal}
            testID={`voice-installation-${id}-reveal`}
          >
            {t("settings.voice.installation.reveal")}
          </Button>
        ) : null}
      </SettingsRow>
      <SettingsRow label={t("settings.voice.installation.source")} hint={hints.source}>
        <ExternalLink href={archiveUrl} label={t("settings.voice.installation.openSource")} />
      </SettingsRow>
      {archiveSha256 ? (
        <SettingsRow label={t("settings.voice.installation.checksum")} hint={hints.checksum} />
      ) : null}
    </SettingsCollapsibleRow>
  );
}

function selectableDetail(value: string | undefined) {
  return (
    <Text selectable style={settingsStyles.rowHint}>
      {value}
    </Text>
  );
}
