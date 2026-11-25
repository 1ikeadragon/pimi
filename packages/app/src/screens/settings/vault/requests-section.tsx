import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultRequest, VaultRequestDecision } from "@pimi/protocol/vault/types";
import { SettingsCard } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { useVaultAction, vaultErrorMessage } from "./use-vault";

interface RequestsSectionProps {
  serverId: string;
  requests: VaultRequest[];
  operator: boolean;
}

interface ResolveInput {
  vaultRequestId: string;
  decision: VaultRequestDecision;
  argvPrefixLength: number;
  scopeToProject: boolean;
}

export function RequestsSection({ serverId, requests, operator }: RequestsSectionProps) {
  const { t } = useTranslation();
  const resolve = useVaultAction(serverId, (client, input: ResolveInput) =>
    client.vaultResolveRequest(input),
  );
  if (requests.length === 0) return null;
  return (
    <SettingsSection title={t("settings.vault.requests.title")}>
      {operator ? null : (
        <Alert size="sm" variant="warning" title={t("settings.vault.requests.needsOperator")} />
      )}
      {resolve.error ? (
        <Alert size="sm" variant="error" title={vaultErrorMessage(resolve.error)} />
      ) : null}
      <SettingsCard testID="vault-requests">
        {requests.map((request) => (
          <RequestRow
            key={request.id}
            request={request}
            operator={operator}
            pending={resolve.isPending}
            onResolve={resolve.mutate}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

interface RequestRowProps {
  request: VaultRequest;
  operator: boolean;
  pending: boolean;
  onResolve: (input: ResolveInput) => void;
}

function RequestRow({ request, operator, pending, onResolve }: RequestRowProps) {
  const { t } = useTranslation();
  const args = request.argv.slice(1);
  const [prefixLength, setPrefixLength] = useState(args.length);
  const [scopeToProject, setScopeToProject] = useState(request.projectId !== null);
  const decide = useCallback(
    (decision: VaultRequestDecision) =>
      onResolve({
        vaultRequestId: request.id,
        decision,
        argvPrefixLength: prefixLength,
        scopeToProject,
      }),
    [onResolve, prefixLength, request.id, scopeToProject],
  );
  const deny = useCallback(() => decide("deny"), [decide]);
  const once = useCallback(() => decide("once"), [decide]);
  const always = useCallback(() => decide("always"), [decide]);
  const fixedPart = [request.argv[0], ...args.slice(0, prefixLength)].join(" ");
  return (
    <View style={styles.row} testID={`vault-request-${request.id}`}>
      <Text style={styles.command} selectable>
        {request.argv.join(" ")}
      </Text>
      <Text style={settingsStyles.rowHint}>
        {t("settings.vault.requests.detail", {
          cwd: request.cwd,
          agent: request.agentId ?? t("settings.vault.requests.unknownAgent"),
          secrets: request.secrets.map((s) => `${s.secret} → ${s.envName}`).join(", "),
        })}
      </Text>
      {request.runsProjectCode ? (
        <Alert size="sm" variant="warning" title={t("settings.vault.requests.runsProjectCode")} />
      ) : null}
      <View style={styles.always}>
        <Text style={settingsStyles.rowHint}>
          {t("settings.vault.requests.alwaysFor", { command: fixedPart })}
        </Text>
        <PrefixPicker count={args.length} value={prefixLength} onChange={setPrefixLength} />
        {request.projectId === null ? null : (
          <View style={styles.scope}>
            <Switch
              value={scopeToProject}
              onValueChange={setScopeToProject}
              accessibilityLabel={t("settings.vault.requests.thisProjectOnly")}
            />
            <Text style={settingsStyles.rowHint}>
              {t("settings.vault.requests.thisProjectOnly")}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.actions}>
        <Button variant="outline" onPress={deny} disabled={!operator || pending}>
          {t("settings.vault.requests.deny")}
        </Button>
        <Button variant="secondary" onPress={once} disabled={!operator || pending}>
          {t("settings.vault.requests.once")}
        </Button>
        <Button onPress={always} disabled={!operator || pending}>
          {t("settings.vault.requests.always")}
        </Button>
      </View>
    </View>
  );
}

function PrefixPicker({
  count,
  value,
  onChange,
}: {
  count: number;
  value: number;
  onChange: (next: number) => void;
}) {
  const { t } = useTranslation();
  const options = Array.from({ length: count + 1 }, (_, index) => index);
  return (
    <DropdownMenu>
      <DropdownTrigger
        accessibilityRole="button"
        accessibilityLabel={t("settings.vault.requests.prefix")}
      >
        {t("settings.vault.requests.prefixValue", { count: value })}
      </DropdownTrigger>
      <DropdownMenuContent side="bottom" align="start" width={240}>
        {options.map((option) => (
          <PrefixOption
            key={option}
            option={option}
            selected={option === value}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PrefixOption({
  option,
  selected,
  onChange,
}: {
  option: number;
  selected: boolean;
  onChange: (next: number) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onChange(option), [onChange, option]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {option === 0
        ? t("settings.vault.requests.prefixAny")
        : t("settings.vault.requests.prefixValue", { count: option })}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  command: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  always: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  scope: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
}));
