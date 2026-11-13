import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { AttackFindingsView } from "./attack-findings-panel";
import { AttackRunBar } from "./attack-run-bar";
import { useAttackSync, useLatestAttackRun } from "./attack-store";

/**
 * Attack on a phone: the newest run's status, meters, Pause and Stop, and its findings with their
 * screenshots. There is no board, no launch form, no history and no batch Fix it: those need the
 * desktop's room, and a run is started where its target app is.
 */
export function AttackPhoneScreen({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  useAttackSync(serverId, workspaceId);
  const run = useLatestAttackRun(serverId, workspaceId);
  return (
    <View style={styles.screen} testID="attack-phone-screen">
      <BackHeader title={t("attack.phone.title")} />
      {run ? (
        <>
          <AttackRunBar run={run} serverId={serverId} />
          <View style={styles.findings}>
            <AttackFindingsView serverId={serverId} workspaceId={workspaceId} batch={false} />
          </View>
        </>
      ) : (
        <Text style={styles.empty} testID="attack-phone-empty">
          {t("attack.phone.noRun")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  findings: { flex: 1 },
  empty: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
