import { useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft, Play } from "lucide-react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@pimi/protocol/messages";
import {
  AgentProfileFormFields,
  buildDeleteProfilePatch,
  buildResetProfilePatch,
  upsertAgentProfile,
  useAgentProfileForm,
  useAgentProfiles,
  type AgentProfileFormSnapshot,
} from "@/agent-profiles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAutomationMutations } from "@/hooks/use-automation-mutations";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { buildNewWorkspaceRoute, buildProfilesRoute } from "@/utils/host-routes";
import { profileUsageKey, useProfileUsage } from "./use-profile-usage";

const NEW_PROFILE_ID = "new";

export function ProfileEditorScreen({
  serverId,
  profileId,
}: {
  serverId: string;
  profileId: string;
}): ReactElement {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { profiles } = useAgentProfiles(isConnected ? serverId : null);
  const isNew = profileId === NEW_PROFILE_ID;
  const profile = isNew ? undefined : profiles?.find((entry) => entry.id === profileId);

  let body: ReactElement;
  if (!isConnected) {
    body = <CenteredMessage text={t("profiles.unavailable")} />;
  } else if (profiles === null) {
    body = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (!isNew && !profile) {
    body = <CenteredMessage text={t("profiles.notFound")} />;
  } else {
    // Keyed so a reset (which reseeds the built-in) or another profile starts a fresh form.
    body = (
      <ProfileEditorForm
        key={profile ? `${profile.id}:${JSON.stringify(profile.builtin ?? null)}` : NEW_PROFILE_ID}
        serverId={serverId}
        profile={profile}
      />
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader
        title={profile?.name ?? t("profiles.newProfileTitle")}
        inPimiTitlebar
        rightContent={BACK_TO_PROFILES}
      />
      {body}
    </View>
  );
}

function BackToProfilesButton(): ReactElement {
  const { t } = useTranslation();
  const goBack = useBackToProfiles();
  return (
    <Button variant="ghost" leftIcon={ChevronLeft} onPress={goBack} testID="profile-back">
      {t("profiles.back")}
    </Button>
  );
}

const BACK_TO_PROFILES = <BackToProfilesButton />;

function useBackToProfiles(): () => void {
  const router = useRouter();
  return useCallback(() => {
    router.replace(buildProfilesRoute());
  }, [router]);
}

function CenteredMessage({ text }: { text: string }): ReactElement {
  return (
    <View style={styles.centered}>
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}

function ProfileEditorForm({
  serverId,
  profile,
}: {
  serverId: string;
  profile: AgentProfile | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const goBack = useBackToProfiles();
  const { profiles, removedBuiltins, saveProfiles, patchProfiles } = useAgentProfiles(serverId);
  const usage = useProfileUsage();
  const { pauseAutomation } = useAutomationMutations({ serverId });
  const snapshot = useMemo<AgentProfileFormSnapshot>(
    () => (profile ? { mode: "edit", profile } : { mode: "create" }),
    [profile],
  );
  const { model, state } = useAgentProfileForm({ serverId, snapshot });
  const initialText = useMemo(
    () => ({
      name: profile?.name ?? "",
      notes: profile?.notes ?? "",
      instructions: profile?.instructions ?? "",
    }),
    [profile],
  );
  const usedBy = useMemo(
    () => (profile ? (usage.byProfile.get(profileUsageKey(serverId, profile.id)) ?? []) : []),
    [profile, serverId, usage.byProfile],
  );

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      model.setSubmitError(null);
      model.setSubmitting(true);
      try {
        await action();
      } catch (error) {
        model.setSubmitError(toErrorMessage(error));
      } finally {
        model.setSubmitting(false);
      }
    },
    [model],
  );

  const handleSave = useCallback(() => {
    const value = model.getState().submitValue;
    if (!value || !profiles) {
      return;
    }
    void runAction(async () => {
      await saveProfiles(upsertAgentProfile(profiles, profile?.id ?? null, value));
      goBack();
    });
  }, [goBack, model, profile, profiles, runAction, saveProfiles]);

  const handleReset = useCallback(() => {
    if (!profile || !profiles) {
      return;
    }
    void runAction(async () => {
      const confirmed = await confirmDialog({
        title: t("profiles.resetConfirmTitle"),
        message: t("profiles.resetConfirmMessage", { name: profile.name }),
        confirmLabel: t("profiles.resetToDefault"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await patchProfiles(buildResetProfilePatch({ profiles, profileId: profile.id }));
    });
  }, [patchProfiles, profile, profiles, runAction, t]);

  const handleDelete = useCallback(() => {
    if (!profile || !profiles) {
      return;
    }
    void runAction(async () => {
      const message =
        usedBy.length > 0
          ? t("profiles.deleteUsedConfirmMessage", {
              name: profile.name,
              automations: usedBy.map((automation) => automation.name).join(", "),
            })
          : t("profiles.deleteConfirmMessage", { name: profile.name });
      const confirmed = await confirmDialog({
        title: t("profiles.deleteConfirmTitle"),
        message,
        confirmLabel: t("profiles.delete"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      // Their next run would fail on the missing profile, so they stop until someone edits them.
      for (const automation of usedBy) {
        if (automation.status === "active") {
          await pauseAutomation(automation.id);
        }
      }
      await patchProfiles(
        buildDeleteProfilePatch({ profiles, removedBuiltins, profileId: profile.id }),
      );
      goBack();
    });
  }, [
    goBack,
    patchProfiles,
    pauseAutomation,
    profile,
    profiles,
    removedBuiltins,
    runAction,
    t,
    usedBy,
  ]);

  const handleTryIt = useCallback(() => {
    if (!profile) {
      return;
    }
    router.push(buildNewWorkspaceRoute({ serverId, profileId: profile.id }));
  }, [profile, router, serverId]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      testID="profile-editor"
    >
      <AgentProfileFormFields
        model={model}
        state={state}
        initialText={initialText}
        layout="columns"
      />

      {state.submitError ? (
        <Text style={styles.error} testID="profile-editor-error">
          {state.submitError}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <View style={styles.actionGroup}>
          {profile ? (
            <Button
              variant="outline"
              leftIcon={Play}
              onPress={handleTryIt}
              disabled={state.isSubmitting}
              accessibilityHint={t("profiles.tryItHint")}
              testID="profile-try-it"
            >
              {t("profiles.tryIt")}
            </Button>
          ) : null}
          {profile?.builtin?.edited ? (
            <Button
              variant="ghost"
              onPress={handleReset}
              disabled={state.isSubmitting}
              testID="profile-reset"
            >
              {t("profiles.resetToDefault")}
            </Button>
          ) : null}
          {profile ? (
            <Button
              variant="ghost"
              onPress={handleDelete}
              disabled={state.isSubmitting}
              testID="profile-delete"
            >
              {t("profiles.delete")}
            </Button>
          ) : null}
        </View>
        <View style={styles.actionGroup}>
          <Button
            variant="secondary"
            onPress={goBack}
            disabled={state.isSubmitting}
            testID="profile-cancel"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={handleSave}
            disabled={!state.canSubmit}
            testID="profile-save"
          >
            {state.isSubmitting
              ? t("settings.host.agentProfiles.saving")
              : t("settings.host.agentProfiles.save")}
          </Button>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surfaceWindow,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[8],
    maxWidth: 1100,
    width: "100%",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  actionGroup: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
