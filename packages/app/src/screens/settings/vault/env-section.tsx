import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultEnvCandidate, VaultEnvImportAction } from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { useVaultAction, vaultErrorMessage } from "./use-vault";

// Variables the agent CLIs read to run at all: Claude Code (ANTHROPIC_API_KEY, CLAUDE_CODE_*, such
// as its OAuth token) and Codex (OPENAI_API_KEY, CODEX_*). Hiding one stops that CLI, so they sit
// last, with Move and Hide off.
const AGENT_TOOL_ENV_NAMES: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
const AGENT_TOOL_ENV_PREFIXES = ["CLAUDE_CODE_", "CODEX_"] as const;

function isAgentToolEnv(name: string): boolean {
  return (
    AGENT_TOOL_ENV_NAMES.has(name) ||
    AGENT_TOOL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

interface EnvSectionProps {
  serverId: string;
  candidates: VaultEnvCandidate[];
  operator: boolean;
}

interface ImportInput {
  name: string;
  action: VaultEnvImportAction;
}

export function EnvSection({ serverId, candidates, operator }: EnvSectionProps) {
  const { t } = useTranslation();
  const run = useVaultAction(serverId, (client, input: ImportInput) =>
    client.vaultEnvImport({ names: [input.name], action: input.action }),
  );
  if (candidates.length === 0) return null;
  const ordinary = candidates.filter((candidate) => !isAgentToolEnv(candidate.name));
  const needed = candidates.filter((candidate) => isAgentToolEnv(candidate.name));
  const skipped = run.data?.skipped ?? [];
  return (
    <SettingsSection title={t("settings.vault.env.title")} info={t("settings.vault.env.info")}>
      {run.error ? <Alert size="sm" variant="error" title={vaultErrorMessage(run.error)} /> : null}
      {skipped.length > 0 ? (
        <Alert
          size="sm"
          variant="warning"
          title={t("settings.vault.env.skipped", {
            names: skipped.map((entry) => `${entry.name} (${entry.reason})`).join(", "),
          })}
        />
      ) : null}
      <SettingsCard testID="vault-env-candidates">
        {ordinary.map((candidate) => (
          <EnvRow
            key={candidate.name}
            candidate={candidate}
            operator={operator}
            pending={run.isPending}
            onRun={run.mutate}
          />
        ))}
      </SettingsCard>
      {needed.length > 0 ? (
        <>
          <Text style={settingsStyles.rowTitle}>{t("settings.vault.env.needed")}</Text>
          <SettingsCard testID="vault-env-needed">
            {needed.map((candidate) => (
              <SettingsRow
                key={candidate.name}
                label={candidate.name}
                hint={t("settings.vault.env.neededHint")}
              >
                <View style={styles.trailing}>
                  <Button variant="outline" disabled>
                    {t("settings.vault.env.hide")}
                  </Button>
                  <Button disabled>{t("settings.vault.env.move")}</Button>
                </View>
              </SettingsRow>
            ))}
          </SettingsCard>
        </>
      ) : null}
    </SettingsSection>
  );
}

function EnvRow({
  candidate,
  operator,
  pending,
  onRun,
}: {
  candidate: VaultEnvCandidate;
  operator: boolean;
  pending: boolean;
  onRun: (input: ImportInput) => void;
}) {
  const { t } = useTranslation();
  const move = useCallback(
    () => onRun({ name: candidate.name, action: "import" }),
    [candidate.name, onRun],
  );
  const hide = useCallback(
    () => onRun({ name: candidate.name, action: "scrub_only" }),
    [candidate.name, onRun],
  );
  return (
    <SettingsRow label={candidate.name} hint={t("settings.vault.env.rowHint")}>
      <View style={styles.trailing}>
        {candidate.scrubbed ? (
          <StatusBadge label={t("settings.vault.env.hidden")} variant="success" size="xs" />
        ) : (
          <>
            <Button variant="outline" onPress={hide} disabled={!operator || pending}>
              {t("settings.vault.env.hide")}
            </Button>
            <Button onPress={move} disabled={!operator || pending}>
              {t("settings.vault.env.move")}
            </Button>
          </>
        )}
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
