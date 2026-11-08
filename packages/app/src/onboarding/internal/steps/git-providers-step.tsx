import { getForgeDefinitionOrNeutral } from "@pimi/protocol/forge-manifest";
import * as Clipboard from "expo-clipboard";
import { Check, Copy, RotateCw } from "lucide-react-native";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink } from "@/components/ui/external-link";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost, type PimiGitAuthStatus, type PimiGitProvider } from "@/desktop/host";
import { buildForgeSignInCommand } from "@/git/forge";
import { ForgeBrandIcon, getForgeBrandColorMapping } from "@/git/forge-icon";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const GIT_PROVIDER_DOCS = {
  github: "https://cli.github.com/",
  gitlab: "https://docs.gitlab.com/cli/",
} satisfies Record<PimiGitProvider, string>;

const GIT_STATUS_LABELS = {
  connected: "Connected",
  "cli-missing": "CLI needed",
  unverified: "Sign-in unverified",
} satisfies Record<PimiGitAuthStatus, string>;

const ThemedCheck = withUnistyles(Check);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMuted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const connectedIcon = <ThemedCheck size={12} uniProps={foregroundMuted} />;

export function GitProvidersStep() {
  const getStatus = getDesktopHost()?.getPimiGitAuthStatus;
  const { data, isFetching, refetch } = useFetchQuery({
    queryKey: ["pimi", "git-provider-status"],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      const [github, gitlab] = await Promise.all([
        getStatus?.("github").catch(() => "unverified" as const),
        getStatus?.("gitlab").catch(() => "unverified" as const),
      ]);
      return { github, gitlab };
    },
    refetchOnWindowFocus: true,
  });
  const recheck = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text style={styles.note}>
          Run the sign-in command in Terminal. Pimi uses that session.
        </Text>
        <ToolbarButton
          label="Recheck Git provider connections"
          disabled={isFetching || !getStatus}
          onPress={recheck}
        >
          <ThemedRotateCw size={14} uniProps={foregroundMuted} />
        </ToolbarButton>
      </View>
      <View style={settingsStyles.card}>
        <GitProviderRow provider="github" status={data?.github} checking={isFetching} />
        <GitProviderRow provider="gitlab" status={data?.gitlab} checking={isFetching} divider />
      </View>
      <Text style={styles.note}>You can continue setup and connect a provider later.</Text>
    </View>
  );
}

function GitProviderRow({
  provider,
  status,
  checking,
  divider,
}: {
  provider: PimiGitProvider;
  status?: PimiGitAuthStatus;
  checking: boolean;
  divider?: boolean;
}) {
  const toast = useToast();
  const forge = getForgeDefinitionOrNeutral(provider);
  const hostname = forge.cloudHosts?.[0] ?? null;
  const command = buildForgeSignInCommand(provider, hostname);
  const handleCopy = useCallback(async () => {
    if (!command) return;
    try {
      if (await Clipboard.setStringAsync(command)) {
        toast.show("Sign-in command copied", { variant: "success" });
        return;
      }
    } catch {
      // Preserve the selectable command when the system clipboard is unavailable.
    }
    toast.error("Couldn’t copy the sign-in command");
  }, [command, toast]);

  const connected = status === "connected";
  const missing = status === "cli-missing";
  const label = checking ? "Checking…" : GIT_STATUS_LABELS[status ?? "unverified"];

  return (
    <View style={[styles.provider, divider && settingsStyles.rowBorder]}>
      <View style={styles.providerHeader}>
        <ForgeBrandIcon
          iconKind={forge.iconKind}
          size={20}
          uniProps={getForgeBrandColorMapping(forge.iconKind) ?? foreground}
        />
        <Text style={styles.providerName}>{forge.displayName}</Text>
        <View accessibilityLiveRegion="polite">
          <StatusBadge label={label} leading={connected && !checking ? connectedIcon : undefined} />
        </View>
      </View>
      {missing ? (
        <ExternalLink href={GIT_PROVIDER_DOCS[provider]} label={`Install ${forge.signIn?.cli}`} />
      ) : null}
      {command && !connected && (!checking || status) ? (
        <View style={styles.command}>
          <Text style={styles.commandText} selectable>
            {command}
          </Text>
          <ToolbarButton label={`Copy ${forge.displayName} sign-in command`} onPress={handleCopy}>
            <ThemedCopy size={14} uniProps={foregroundMuted} />
          </ToolbarButton>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  note: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  provider: { gap: theme.spacing[2], padding: theme.spacing[3] },
  providerHeader: { alignItems: "center", flexDirection: "row", gap: theme.spacing[3] },
  providerName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  command: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
  },
  commandText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
}));
