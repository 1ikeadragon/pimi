import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CREW_ROLES, CREW_TIER_PROFILE_IDS, type CrewRole } from "@pimi/protocol/agent-labels";
import type { AgentProfile } from "@pimi/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Switch } from "@/components/ui/switch";
import { useAgentProfiles } from "@/agent-profiles/internal/use-agent-profiles";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useTranslation } from "@/i18n/use-translation";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { PimiModelControls, type PimiModelChoice } from "@/screens/settings/pimi-model-row";

const SNAP_POINTS = ["60%", "90%"];

interface CrewSheetProps {
  visible: boolean;
  onClose: () => void;
  serverId: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  presentation?: "push";
}

/**
 * Crew for one chat: the on/off switch, and each member's model and thinking. These settings are
 * saved in its host-wide tier profile; a profile without a provider means the
 * member runs on the lead's own model.
 */
export function CrewSheet({
  visible,
  onClose,
  serverId,
  enabled,
  onChange,
  disabled = false,
  presentation,
}: CrewSheetProps) {
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("agentControls.crew.title") }), [t]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      presentation={presentation}
      testID="crew-sheet"
    >
      <View style={styles.body}>
        <View style={styles.switchRow}>
          <View style={styles.rowText}>
            <Text style={styles.label}>{t("agentControls.crew.switch")}</Text>
            <Text style={styles.hint}>{t("agentControls.crew.switchHint")}</Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={onChange}
            disabled={disabled}
            accessibilityLabel={t("agentControls.crew.switch")}
            testID="crew-switch"
          />
        </View>
        <Text style={styles.sectionTitle}>{t("agentControls.crew.modelsTitle")}</Text>
        <Text style={styles.hint}>{t("agentControls.crew.modelsHint")}</Text>
        {visible ? <CrewTierRows serverId={serverId} /> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function CrewTierRows({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const snapshot = useProvidersSnapshot(serverId, { cwd: null });
  const { profiles, saveProfiles } = useAgentProfiles(serverId);
  const [saving, setSaving] = useState(false);

  const saveTier = useCallback(
    async (role: CrewRole, choice: PimiModelChoice | null) => {
      if (!profiles || saving) return;
      const id = CREW_TIER_PROFILE_IDS[role];
      const next = profiles.map((profile) =>
        profile.id === id ? withTierModel(profile, choice) : profile,
      );
      setSaving(true);
      try {
        await saveProfiles(next);
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        setSaving(false);
      }
    },
    [profiles, saveProfiles, saving, toast],
  );

  return (
    <View style={styles.tiers} aria-busy={saving}>
      {CREW_ROLES.map((role) => {
        const profile = profiles?.find((entry) => entry.id === CREW_TIER_PROFILE_IDS[role]);
        return (
          <CrewTierRow
            key={role}
            role={role}
            serverId={serverId}
            snapshot={snapshot}
            profile={profile}
            disabled={profiles === null || saving}
            onSave={saveTier}
            label={t(`agentControls.crew.roles.${role}.label`)}
            hint={t(`agentControls.crew.roles.${role}.hint`)}
          />
        );
      })}
    </View>
  );
}

function CrewTierRow({
  role,
  serverId,
  snapshot,
  profile,
  disabled,
  onSave,
  label,
  hint,
}: {
  role: CrewRole;
  serverId: string;
  snapshot: ReturnType<typeof useProvidersSnapshot>;
  profile: AgentProfile | undefined;
  disabled: boolean;
  onSave: (role: CrewRole, choice: PimiModelChoice | null) => void;
  label: string;
  hint: string;
}) {
  const { t } = useTranslation();
  const value = useMemo<PimiModelChoice | null>(
    () =>
      profile?.provider
        ? {
            provider: profile.provider,
            ...(profile.model ? { model: profile.model } : {}),
            ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
          }
        : null,
    [profile?.model, profile?.provider, profile?.thinkingOptionId],
  );
  const entry = value ? snapshot.entries?.find((item) => item.provider === value.provider) : null;
  const unavailable =
    value && !snapshot.isLoading && (!entry || !entry.enabled || entry.status === "unavailable")
      ? t("agentControls.crew.unavailable", {
          provider: entry?.label ?? value.provider,
        })
      : null;
  const handleChange = useCallback(
    (choice: PimiModelChoice) => onSave(role, choice),
    [onSave, role],
  );
  const handleReset = useCallback(() => onSave(role, null), [onSave, role]);

  return (
    <View style={styles.tierRow} testID={`crew-tier-${role}`}>
      <View style={styles.tierLine}>
        <View style={styles.tierText}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.hint}>{hint}</Text>
        </View>
        <PimiModelControls
          label={label}
          serverId={serverId}
          snapshot={snapshot}
          value={value}
          placeholder={t("agentControls.crew.sameAsLead")}
          onChange={handleChange}
          onReset={handleReset}
          resetLabel={t("agentControls.crew.sameAsLead")}
          disabled={disabled || !profile}
          testID={`crew-tier-${role}`}
        />
      </View>
      {unavailable ? (
        <Text style={styles.warning} testID={`crew-tier-${role}-unavailable`}>
          {unavailable}
        </Text>
      ) : null}
    </View>
  );
}

/** Updates the tier's launch settings; a null choice follows the lead. */
function withTierModel(profile: AgentProfile, choice: PimiModelChoice | null): AgentProfile {
  const next: AgentProfile = { ...profile };
  const modelChanged = profile.provider !== choice?.provider || profile.model !== choice?.model;
  if (!choice || modelChanged) {
    // Mode, thinking and features belong to the old provider and model.
    for (const key of [
      "provider",
      "model",
      "modeId",
      "thinkingOptionId",
      "featureValues",
    ] as const) {
      delete next[key];
    }
  }
  if (choice) {
    next.provider = choice.provider;
    if (choice.model) next.model = choice.model;
    if (choice.thinkingOptionId) next.thinkingOptionId = choice.thinkingOptionId;
  }
  if (profile.builtin) next.builtin = { ...profile.builtin, edited: true };
  return next;
}

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowText: { flex: 1, minWidth: 0 },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  sectionTitle: {
    marginTop: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  tiers: { gap: theme.spacing[3], marginTop: theme.spacing[2] },
  tierRow: { gap: theme.spacing[1] },
  tierLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  tierText: { minWidth: 96 },
  warning: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
}));
