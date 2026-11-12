import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ArrowRight,
  Bot,
  Check,
  FolderGit2,
  GitPullRequest,
  MessageCircle,
} from "lucide-react-native";
import { useRouter } from "expo-router";
import {
  AdaptiveModalSheet,
  FULL_SHEET_SNAP_POINTS,
  SheetFooter,
} from "@/components/adaptive-modal-sheet";
import { PimiLogo } from "@/components/icons/pimi-logo";
import { PimiMark } from "@/components/icons/pimi-mark";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getDesktopHost } from "@/desktop/host";
import { useProjectRootPaths } from "@/stores/session-store-hooks";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { useProjectSuggestions, type ProjectSuggestionsController } from "@/project-suggestions";
import type { Theme } from "@/styles/theme";
import type { OnboardingModel, OnboardingState, OnboardingStepId } from "./model";
import { useOrchestrationSetup, type OrchestrationSetupController } from "./orchestration-setup";
import { OnboardingStepContent } from "./steps";

type OpenState = Extract<OnboardingState, { status: "open" }>;

const ThemedCheck = withUnistyles(Check);
const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

const pimiSteps = {
  welcome: {
    label: "Welcome",
    title: "Your swarm’s best friend",
    description: "Chat with your agents, give them work, and review changes together.",
  },
  gitProviders: {
    label: "Git providers",
    title: "Connect a Git provider",
    description: "Use your existing credentials to work with pull requests and merge requests.",
  },
  firstChat: {
    label: "First workspace",
    title: "Open your first workspace",
    description: "Choose a project or add a folder, then start a chat with an agent.",
  },
} satisfies Partial<
  Record<OnboardingStepId, { label: string; title: string; description: string }>
>;

function getPimiStepCopy(step: OnboardingStepId) {
  return step in pimiSteps ? pimiSteps[step as keyof typeof pimiSteps] : undefined;
}

function SetupMark({ pimi }: { pimi: boolean }) {
  if (!pimi) return <PimiLogo size={LOGO_SIZE} />;
  return (
    <View style={styles.pimiMark}>
      <PimiSetupMark size={LOGO_SIZE - 1} />
    </View>
  );
}

const PimiSetupMark = withUnistyles(PimiMark, accentForegroundMapping);

export function OnboardingModal({ model, state }: { model: OnboardingModel; state: OpenState }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pimi = Boolean(getDesktopHost()?.showPimiWorkspace);
  const setupTitle = pimi ? "Pimi" : t("onboarding.setup.title");
  const projectRoots = useProjectRootPaths(state.serverId);
  const isCompact = useIsCompactFormFactor();
  const step = state.steps[state.stepIndex];
  const isWelcome = step === "welcome";
  const isFirst = state.stepIndex === 0;
  const isLast = state.stepIndex === state.steps.length - 1;
  // Held here so Continue can add the checked folders; reading history from the first step means
  // the Projects step rarely waits.
  const projectSuggestions = useProjectSuggestions(state.serverId, { preselect: !pimi });
  const { addChecked } = projectSuggestions;
  const orchestration = useOrchestrationSetup(state.serverId);
  const { apply: applyOrchestration } = orchestration;

  const handleComplete = useCallback(() => {
    void model.complete();
  }, [model]);
  const handleBack = useCallback(() => model.back(), [model]);
  const startChat = useCallback(() => {
    handleComplete();
    router.push(
      buildNewWorkspaceRoute({
        serverId: state.serverId,
        chooseProject: pimi,
        sourceDirectory: !pimi && projectRoots.length === 1 ? projectRoots[0] : undefined,
      }),
    );
  }, [handleComplete, pimi, projectRoots, router, state.serverId]);
  const { visit } = state;
  // A step's own work runs before it moves on; from the last step, moving on finishes setup.
  const handleAdvance = useCallback(() => model.next(visit), [model, visit]);
  const handleAddSuggestions = useCallback(() => {
    void (async () => {
      if (await addChecked()) handleAdvance();
    })();
  }, [addChecked, handleAdvance]);
  const handleApplyOrchestration = useCallback(() => {
    void (async () => {
      if (await applyOrchestration()) handleAdvance();
    })();
  }, [applyOrchestration, handleAdvance]);
  const primary = usePrimaryAction({
    step,
    isLast,
    pimi,
    projectSuggestions,
    orchestration,
    onAdvance: handleAdvance,
    onStartChat: startChat,
    onAddSuggestions: handleAddSuggestions,
    onApplyOrchestration: handleApplyOrchestration,
  });

  // The compact sheet stacks a title row, the step and the actions. The desktop card gives the
  // step rail the full height instead: the brand tops the rail, the actions close the step pane,
  // and the sheet floats its close button.
  const compactHeader = useMemo(
    () => ({
      title: setupTitle,
      leading: <SetupMark pimi={pimi} />,
      subtitle: (
        <Text style={styles.stepCounter}>
          {t("onboarding.setup.stepCounter", {
            current: state.stepIndex + 1,
            total: state.steps.length,
          })}
        </Text>
      ),
    }),
    [pimi, setupTitle, state.stepIndex, state.steps.length, t],
  );

  const actions = (
    <>
      <View>
        {isLast ? null : (
          <Button variant={isWelcome ? "ghost" : "outline"} onPress={handleComplete}>
            {t("onboarding.setup.skip")}
          </Button>
        )}
      </View>
      <View style={styles.footerActions}>
        {isFirst ? null : (
          <Button variant="secondary" onPress={handleBack}>
            {t("common.actions.back")}
          </Button>
        )}
        <Button
          variant="default"
          onPress={primary.onPress}
          loading={primary.busy}
          leftIcon={isWelcome ? ArrowRight : undefined}
        >
          {primary.label}
        </Button>
      </View>
    </>
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={handleComplete}
      header={isCompact && !isWelcome ? compactHeader : undefined}
      footer={isCompact ? actions : undefined}
      scrollable={false}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      desktopMaxWidth={pimi ? 760 : 880}
      desktopHeight={pimi ? 480 : 640}
      contentStyle={styles.content}
      testID="onboarding-modal"
    >
      <View style={styles.body}>
        {isCompact || isWelcome ? null : (
          <StepRail state={state} onSelect={model.goTo} pimi={pimi} />
        )}
        <View style={styles.pane}>
          <SetupStepPane
            step={step}
            serverId={state.serverId}
            projectSuggestions={projectSuggestions}
            orchestration={orchestration}
          />
          {isCompact ? null : <SheetFooter>{actions}</SheetFooter>}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function SetupStepPane({
  step,
  ...stepProps
}: {
  step: OnboardingStepId;
  serverId: string;
  projectSuggestions: ProjectSuggestionsController;
  orchestration: OrchestrationSetupController;
}) {
  const { t } = useTranslation();
  const stepCopy = getPimiStepCopy(step);
  if (step === "welcome") {
    return (
      <View style={styles.welcome}>
        <View style={styles.welcomeMark}>
          <PimiSetupMark size={48} />
        </View>
        <Text style={styles.welcomeBrand}>Pimi</Text>
        <Text style={styles.welcomeTitle} accessibilityRole="header">
          {pimiSteps.welcome.title}
        </Text>
        <Text style={styles.welcomeDescription}>{pimiSteps.welcome.description}</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.paneScroll}>
      {/* Padding lives on a wrapper: the ScrollView's contentContainerStyle skips Unistyles. */}
      <View style={styles.paneContent}>
        <View style={styles.stepHeader}>
          <Text style={styles.stepTitle} accessibilityRole="header">
            {stepCopy?.title ?? t(`onboarding.setup.steps.${step}.title`, { defaultValue: "" })}
          </Text>
          <Text style={styles.stepDescription}>
            {stepCopy?.description ??
              t(`onboarding.setup.steps.${step}.description`, { defaultValue: "" })}
          </Text>
        </View>
        <OnboardingStepContent step={step} {...stepProps} />
      </View>
    </ScrollView>
  );
}

/**
 * The footer's main button. On Projects, with folders checked, it adds them and moves on only once
 * every one was added. On Orchestration it applies the switches and moves on once they all took.
 * Otherwise it moves on. Moving on from the last step finishes setup, so that step's work still
 * runs first; Orchestration is last in the compact layout.
 */
function usePrimaryAction(input: {
  step: OnboardingStepId;
  isLast: boolean;
  pimi: boolean;
  projectSuggestions: ProjectSuggestionsController;
  orchestration: OrchestrationSetupController;
  onAdvance: () => void;
  onStartChat: () => void;
  onAddSuggestions: () => void;
  onApplyOrchestration: () => void;
}): { label: string; busy: boolean; onPress: () => void } {
  const { t } = useTranslation();
  const {
    step,
    isLast,
    pimi,
    projectSuggestions,
    orchestration,
    onAdvance,
    onStartChat,
    onAddSuggestions,
    onApplyOrchestration,
  } = input;
  const { checkedCount, isAdding } = projectSuggestions;
  if (step === "welcome") return { label: "Get started", busy: false, onPress: onAdvance };
  if (step === "firstChat") {
    return { label: pimi ? "New workspace" : "Start a chat", busy: false, onPress: onStartChat };
  }
  const advanceLabel = isLast ? t("onboarding.setup.finish") : t("onboarding.setup.continue");
  // Rows leave the list as they are added, so the count can reach zero while adding.
  if (step === "projects" && (isAdding || checkedCount > 0)) {
    return {
      label: isAdding
        ? t("onboarding.setup.steps.projects.suggestions.adding")
        : t("onboarding.setup.steps.projects.suggestions.addSelected", { count: checkedCount }),
      busy: isAdding,
      onPress: onAddSuggestions,
    };
  }
  if (step === "orchestration") {
    return { label: advanceLabel, busy: orchestration.isApplying, onPress: onApplyOrchestration };
  }
  return { label: advanceLabel, busy: false, onPress: onAdvance };
}

function StepRail({
  state,
  onSelect,
  pimi,
}: {
  state: OpenState;
  onSelect: (step: OnboardingStepId) => void;
  pimi: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.rail}>
      <View style={styles.railBrand}>
        <SetupMark pimi={pimi} />
        <Text style={styles.railTitle} numberOfLines={1}>
          {pimi ? "Pimi" : t("onboarding.setup.title")}
        </Text>
      </View>
      <View style={styles.railSteps}>
        {state.steps.map((step, index) => (
          <StepRailItem
            key={step}
            step={step}
            number={index + 1}
            current={index === state.stepIndex}
            done={index < state.stepIndex}
            onSelect={onSelect}
            pimi={pimi}
          />
        ))}
      </View>
    </View>
  );
}

const pimiStepIcons = {
  welcome: withUnistyles(PimiMark),
  providers: withUnistyles(Bot),
  gitProviders: withUnistyles(GitPullRequest),
  projects: withUnistyles(FolderGit2),
  firstChat: withUnistyles(MessageCircle),
};
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function StepRailItem({
  step,
  number,
  current,
  done,
  onSelect,
  pimi,
}: {
  step: OnboardingStepId;
  number: number;
  current: boolean;
  done: boolean;
  onSelect: (step: OnboardingStepId) => void;
  pimi: boolean;
}) {
  const { t } = useTranslation();
  const Icon =
    pimi && step in pimiStepIcons ? pimiStepIcons[step as keyof typeof pimiStepIcons] : null;
  const label =
    getPimiStepCopy(step)?.label ?? t(`onboarding.setup.steps.${step}.label`, { defaultValue: "" });
  const handlePress = useCallback(() => onSelect(step), [onSelect, step]);
  const accessibilityState = useMemo(() => ({ selected: current }), [current]);
  const itemStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.railItem,
      hovered && !current && styles.railItemHovered,
      current && styles.railItemCurrent,
    ],
    [current],
  );
  let badgeStyle = Icon ? styles.railIconSlot : styles.railBadge;
  if (done || current) badgeStyle = styles.railBadgeActive;
  let badge = (
    <Text style={current ? styles.railBadgeTextActive : styles.railBadgeText}>{number}</Text>
  );
  if (Icon)
    badge = <Icon size={13} uniProps={current ? accentForegroundMapping : mutedIconMapping} />;
  if (done) badge = <ThemedCheck size={12} strokeWidth={3} uniProps={accentForegroundMapping} />;
  return (
    <PressHighlight
      style={itemStyle}
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-selected={current}
    >
      <View style={badgeStyle}>{badge}</View>
      <Text style={current ? styles.railLabelCurrent : styles.railLabel} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const BADGE_SIZE = 20;
const LOGO_SIZE = 20;

const styles = StyleSheet.create((theme) => ({
  welcome: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  welcomeMark: {
    width: 82,
    height: 82,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: theme.colors.accent,
    marginBottom: theme.spacing[2],
  },
  welcomeBrand: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  welcomeTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["4xl"],
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  welcomeDescription: {
    maxWidth: 320,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.5,
    textAlign: "center",
  },
  pimiMark: {
    width: LOGO_SIZE + 6,
    height: LOGO_SIZE + 6,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: theme.colors.accent,
  },
  content: {
    padding: 0,
    gap: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  rail: {
    width: 200,
    padding: theme.spacing[3],
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
  },
  // Inset like a rail item, so the logo sits on the badges' column.
  railBrand: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  railTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  railSteps: {
    gap: theme.spacing[1],
  },
  railItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
  },
  railItemHovered: {
    backgroundColor: theme.colors.surface2,
  },
  railItemCurrent: {
    backgroundColor: theme.colors.surface2,
  },
  railBadge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  railIconSlot: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  railBadgeActive: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  railBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  railBadgeTextActive: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.base,
  },
  railLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  railLabelCurrent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  pane: {
    flex: 1,
    minHeight: 0,
  },
  paneScroll: {
    flex: 1,
    minHeight: 0,
  },
  paneContent: {
    padding: theme.spacing[6],
    gap: theme.spacing[6],
  },
  stepHeader: {
    gap: theme.spacing[2],
  },
  stepTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
  },
  stepDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  stepCounter: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footerActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
