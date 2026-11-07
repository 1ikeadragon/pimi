import { createContext, memo, useCallback, useContext, useMemo, useState } from "react";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Split } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export type AssistantForkTarget = "tab" | "workspace" | { provider: AgentProvider };

interface ForkProviderScope {
  serverId: string;
  cwd: string;
  sourceProvider: AgentProvider;
}

export const AssistantForkProviderScope = createContext<ForkProviderScope | null>(null);

interface AssistantForkMenuProps {
  onFork: (target: AssistantForkTarget) => Promise<void> | void;
  testID?: string;
}

const ThemedSplit = withUnistyles(Split);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const FORK_PROVIDERS_PAGE = "fork-providers";

function ForkProviderMenuPage({
  scope,
  pendingTarget,
  onSelect,
  testID,
}: {
  scope: ForkProviderScope;
  pendingTarget: AssistantForkTarget | null;
  onSelect: (target: AssistantForkTarget) => () => Promise<void>;
  testID: string;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(scope.serverId);
  const snapshot = useProvidersSnapshot(scope.serverId, { cwd: scope.cwd });
  const providers = buildSelectableProviderSelectorProviders(snapshot.entries).filter(
    (provider) => provider.id !== scope.sourceProvider && provider.modelSelection.kind === "models",
  );
  if (!isConnected) {
    return <DropdownMenuLabel>{t("workspace.terminal.hostDisconnected")}</DropdownMenuLabel>;
  }
  if (providers.length === 0) {
    return (
      <DropdownMenuLabel>
        {snapshot.isFetching
          ? t("providerSelection.loading")
          : t("message.actions.forkNoOtherProviders")}
      </DropdownMenuLabel>
    );
  }
  return providers.map((provider) => (
    <DropdownMenuItem
      key={provider.id}
      closeOnSelect={false}
      disabled={pendingTarget !== null}
      onSelect={onSelect({ provider: provider.id })}
      status={
        pendingTarget && typeof pendingTarget !== "string" && pendingTarget.provider === provider.id
          ? "pending"
          : undefined
      }
      testID={`${testID}-provider-${provider.id}`}
    >
      {provider.label}
    </DropdownMenuItem>
  ));
}

export const AssistantForkMenu = memo(function AssistantForkMenu({
  onFork,
  testID = "assistant-fork-menu",
}: AssistantForkMenuProps) {
  const { t } = useTranslation();
  const providerScope = useContext(AssistantForkProviderScope);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<AssistantForkTarget | null>(null);
  const isLocked = pendingTarget !== null;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && pendingTarget !== null) return;
      setIsOpen(next);
    },
    [pendingTarget],
  );

  const handleSelect = useCallback(
    (target: AssistantForkTarget) => async () => {
      if (isLocked) return;
      setPendingTarget(target);
      try {
        await onFork(target);
      } finally {
        setPendingTarget(null);
        setIsOpen(false);
      }
    },
    [isLocked, onFork],
  );

  const triggerStyle = useCallback(
    () => [styles.trigger, isLocked ? styles.triggerDisabled : null],
    [isLocked],
  );

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("message.actions.forkMenu")}</Text>
      </TooltipContent>
    ),
    [t],
  );

  const forkIcon = useMemo(
    () => <ThemedSplit size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );

  const providerPages = useMemo(
    () =>
      providerScope
        ? [
            {
              id: FORK_PROVIDERS_PAGE,
              title: t("message.actions.forkWithProvider"),
              content: (
                <ForkProviderMenuPage
                  scope={providerScope}
                  pendingTarget={pendingTarget}
                  onSelect={handleSelect}
                  testID={testID}
                />
              ),
            },
          ]
        : undefined,
    [handleSelect, pendingTarget, providerScope, t, testID],
  );

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View style={styles.triggerSlot} collapsable={false}>
            <DropdownMenuTrigger
              accessibilityLabel={t("message.actions.forkMenu")}
              accessibilityRole="button"
              disabled={isLocked}
              style={triggerStyle}
              testID={`${testID}-trigger`}
            >
              {({ hovered, open }) => (
                <ThemedSplit
                  size={ICON_SIZE.sm}
                  uniProps={hovered || open ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent
        align="start"
        minWidth={240}
        side="bottom"
        pages={providerPages}
        testID={`${testID}-content`}
      >
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked && pendingTarget !== "tab"}
          leading={forkIcon}
          onSelect={handleSelect("tab")}
          status={pendingTarget === "tab" ? "pending" : undefined}
          testID={`${testID}-new-tab`}
        >
          {t("message.actions.forkInNewTab")}
        </DropdownMenuItem>
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked && pendingTarget !== "workspace"}
          leading={forkIcon}
          onSelect={handleSelect("workspace")}
          status={pendingTarget === "workspace" ? "pending" : undefined}
          testID={`${testID}-new-workspace`}
        >
          {t("message.actions.forkInNewWorkspace")}
        </DropdownMenuItem>
        {providerScope ? (
          <DropdownMenuSubTrigger
            id={FORK_PROVIDERS_PAGE}
            disabled={isLocked}
            leading={forkIcon}
            testID={`${testID}-other-provider`}
          >
            {t("message.actions.forkWithProvider")}
          </DropdownMenuSubTrigger>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerSlot: {
    alignSelf: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
