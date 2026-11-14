import { memo, useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import { ArrowRight } from "lucide-react-native";
import type {
  AgentHandoffMarker,
  AgentProviderSwitchEndpoint,
  AgentProviderSwitchMarker,
} from "@pimi/protocol/agent-types";
import { ModelProviderGlyph } from "@/components/model-browser";
import { Button } from "@/components/ui/button";
import { DensityIcon } from "@/components/ui/density-icon";
import { useToast } from "@/contexts/toast-api-context";
import { useTranslation } from "@/i18n/use-translation";
import { useSessionStore } from "@/stores/session-store";

const GLYPH_SIZE = 13;

function endpointLabel(endpoint: AgentProviderSwitchEndpoint): string {
  const provider = endpoint.providerLabel ?? endpoint.provider;
  const model = endpoint.modelLabel ?? endpoint.model;
  return model ? `${provider} · ${model}` : provider;
}

function Endpoint({
  endpoint,
  serverId,
}: {
  endpoint: AgentProviderSwitchEndpoint;
  serverId: string;
}) {
  return (
    <View style={styles.endpoint}>
      <ModelProviderGlyph provider={endpoint.provider} serverId={serverId} size={GLYPH_SIZE} />
      <Text style={styles.label} numberOfLines={1}>
        {endpointLabel(endpoint)}
      </Text>
    </View>
  );
}

function describePermissionMode(
  mode: AgentProviderSwitchMarker["permissionMode"],
  t: TFunction,
): string | null {
  if (!mode?.label) return null;
  return mode.carried
    ? t("agentStream.providerSwitch.modeCarried", { mode: mode.label })
    : t("agentStream.providerSwitch.modeReset", { mode: mode.label });
}

/** True once `resetsAt` has passed, re-rendering the moment it does. */
function useHasPassed(resetsAt: string | undefined): boolean {
  const target = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(target)) return undefined;
    const remaining = target - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return undefined;
    }
    // Timers past ~24 days fire immediately; a chat that old is re-checked on its next render.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [target]);
  return Number.isFinite(target) && now >= target;
}

/**
 * What a limit move says under the seam: which provider hit its limit and when it recovers, what
 * became of the permission mode, and, once the limit has lifted, a way back.
 */
function LimitNote({
  marker,
  serverId,
  agentId,
}: {
  marker: AgentProviderSwitchMarker;
  serverId: string;
  agentId: string | undefined;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const currentProvider = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agents?.get(agentId)?.provider : undefined,
  );
  const lifted = useHasPassed(marker.resetsAt);
  const [pending, setPending] = useState(false);
  const fromLabel = marker.from.providerLabel ?? marker.from.provider;
  const limitText = marker.resetsAt
    ? t("agentStream.providerSwitch.limitHitResets", {
        provider: fromLabel,
        // Undefined locale: the user's own clock format, with AM/PM where their locale uses it.
        time: new Date(marker.resetsAt).toLocaleTimeString(undefined, { timeStyle: "short" }),
      })
    : t("agentStream.providerSwitch.limitHit", { provider: fromLabel });
  const modeText = describePermissionMode(marker.permissionMode, t);
  // Only the move the chat is still sitting on can be undone.
  const canSwitchBack =
    lifted && client !== null && agentId !== undefined && currentProvider === marker.to.provider;

  const handleSwitchBack = useCallback(async () => {
    if (!client || !agentId) return;
    setPending(true);
    try {
      await client.switchAgentProvider(agentId, {
        provider: marker.from.provider,
        ...(marker.from.model ? { model: marker.from.model } : {}),
      });
    } catch (error) {
      toast.error(
        `${t("agentStream.providerSwitch.switchBackFailed")}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setPending(false);
    }
  }, [agentId, client, marker.from.model, marker.from.provider, t, toast]);

  return (
    <View style={styles.note} testID="provider-switch-limit-note">
      <Text style={styles.noteText}>{limitText}</Text>
      {modeText ? <Text style={styles.noteText}>{modeText}</Text> : null}
      {canSwitchBack ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onPress={handleSwitchBack}
          testID="provider-switch-back"
        >
          {t("agentStream.providerSwitch.switchBack", { provider: fromLabel })}
        </Button>
      ) : null}
    </View>
  );
}

/** What the new provider was told about the chat, shown where the history was delivered. */
export const HandoffNote = memo(function HandoffNote({ marker }: { marker: AgentHandoffMarker }) {
  const { t } = useTranslation();
  let text: string;
  switch (marker.mode) {
    case "summary":
      text = t("agentStream.providerSwitch.handoffSummary");
      break;
    case "excerpt":
      text = t("agentStream.providerSwitch.handoffExcerpt");
      break;
    case "verbatim":
      text = t("agentStream.providerSwitch.handoffVerbatim");
      break;
  }
  return (
    <View style={styles.note} testID="handoff-note">
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );
});

/** Shown under the switch seam while the first prompt waits for the summary of the chat. */
function SummarisingNote({
  marker,
  serverId,
  agentId,
}: {
  marker: AgentProviderSwitchMarker;
  serverId: string;
  agentId: string | undefined;
}) {
  const { t } = useTranslation();
  const summarising = useSessionStore((state) => {
    const agent = agentId ? state.sessions[serverId]?.agents?.get(agentId) : undefined;
    return agent?.handoffSummarising === true && agent.provider === marker.to.provider;
  });
  if (!summarising) return null;
  return (
    <View style={styles.note} testID="provider-switch-summarising">
      <Text style={styles.noteText}>{t("agentStream.providerSwitch.summarising")}</Text>
    </View>
  );
}

/**
 * Marks where in a chat the provider changed: a rule across the thread with the two providers
 * at its center, so the change reads as a seam in the conversation rather than as a message.
 */
export const ProviderSwitchMarker = memo(function ProviderSwitchMarker({
  marker,
  serverId,
  agentId,
}: {
  marker: AgentProviderSwitchMarker;
  serverId: string;
  agentId?: string;
}) {
  return (
    <View
      style={styles.block}
      testID="provider-switch-marker"
      accessibilityLabel={`${endpointLabel(marker.from)} → ${endpointLabel(marker.to)}`}
    >
      <View style={styles.row}>
        <View style={styles.rule} />
        <View style={styles.center}>
          <Endpoint endpoint={marker.from} serverId={serverId} />
          <DensityIcon icon={ArrowRight} size="sm" sizeAdjustment={-4} color="foregroundMuted" />
          <Endpoint endpoint={marker.to} serverId={serverId} />
        </View>
        <View style={styles.rule} />
      </View>
      {marker.reason === "limit" ? (
        <LimitNote marker={marker} serverId={serverId} agentId={agentId} />
      ) : null}
      <SummarisingNote marker={marker} serverId={serverId} agentId={agentId} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  block: {
    gap: theme.spacing[1],
  },
  note: {
    alignItems: "center",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  noteText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  // The rules give way first, so two long model names still fit a narrow chat.
  rule: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: theme.spacing[4],
    height: 1,
    backgroundColor: theme.colors.border,
  },
  center: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  endpoint: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
