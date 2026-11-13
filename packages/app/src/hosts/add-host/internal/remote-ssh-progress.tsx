import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Circle } from "lucide-react-native";
import { ActivityIndicator } from "react-native";
import { REMOTE_SSH_STEPS, type RemoteSshSetupState } from "./remote-ssh-setup";
import type { RemoteSshStep } from "@/desktop/daemon/desktop-daemon";

const AccentCheck = withUnistyles(Check, (theme) => ({ color: theme.colors.accent }));
const MutedDot = withUnistyles(Circle, (theme) => ({ color: theme.colors.foregroundMuted }));
const AccentSpinner = withUnistyles(ActivityIndicator, (theme) => ({ color: theme.colors.accent }));

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  icon: { width: 18, alignItems: "center", justifyContent: "center" },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  labelPending: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  bar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
    marginTop: theme.spacing[1],
  },
  barFill: { height: 4, backgroundColor: theme.colors.accent },
}));

function stepLabel(
  step: RemoteSshStep,
  state: RemoteSshSetupState,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (step === "installing" && state.version) {
    return t("remoteDev.steps.installingVersion", { version: state.version });
  }
  return t(`remoteDev.steps.${step}`);
}

/** The five setup steps with a check, spinner or dot each, and the live detail of the current one. */
export function RemoteSshProgressList({ state }: { state: RemoteSshSetupState }) {
  const { t } = useTranslation();
  const visited = state.visited ?? [];
  const currentIndex = state.current ? REMOTE_SSH_STEPS.indexOf(state.current) : -1;
  return (
    <View style={styles.list} testID="remote-ssh-progress" accessibilityLiveRegion="polite">
      {REMOTE_SSH_STEPS.map((step, index) => {
        const isDone =
          index < currentIndex || (step === "connected" && state.current === "connected");
        const isCurrent = index === currentIndex && !isDone;
        // The install step is skipped when the right daemon is already on the machine.
        const skipped = isDone && step === "installing" && !visited.includes("installing");
        return (
          <View key={step}>
            <View style={styles.row} testID={`remote-ssh-step-${step}`}>
              <View style={styles.icon}>
                {isDone ? <AccentCheck size={16} strokeWidth={3} /> : null}
                {isCurrent ? <AccentSpinner size="small" /> : null}
                {!isDone && !isCurrent ? <MutedDot size={10} /> : null}
              </View>
              <Text style={isDone || isCurrent ? styles.label : styles.labelPending}>
                {stepLabel(step, state, t)}
                {skipped ? ` ${t("remoteDev.steps.alreadyInstalled")}` : ""}
              </Text>
            </View>
            {isCurrent ? (
              <View>
                <Text style={styles.detail}>{state.message}</Text>
                {state.fraction !== null ? (
                  <View style={styles.bar}>
                    <View
                      style={[styles.barFill, { width: `${Math.round(state.fraction * 100)}%` }]}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
