import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageScanReport } from "@pimi/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { useTranslation } from "@/i18n/use-translation";

/**
 * What the transcript scan could not read, so a gap in the numbers has a visible cause. Problems
 * that lose usage (a failed scan, an unreadable folder or file) are alerts; counts of lines the
 * scan skipped by design are quiet text.
 */
export function UsageScanNotice({
  scan,
  rescanError,
}: {
  scan: UsageScanReport | null;
  rescanError: string | null;
}) {
  const { t } = useTranslation();
  const unreadableRoots = scan?.roots.filter((root) => root.status === "unreadable") ?? [];
  const failedCount = scan ? scan.failedFiles.length + scan.failedFilesDropped : 0;
  const firstFailure = scan?.failedFiles[0];
  const skippedLines = scan ? scan.malformedLines + scan.oversizeLines : 0;
  const forkCopies = scan?.forkCopiesSuppressed ?? 0;
  return (
    <View style={styles.stack} testID="usage-scan-notice">
      {rescanError ? (
        <Alert
          size="sm"
          variant="error"
          title={t("usageOverview.scan.rescanFailed")}
          description={rescanError}
        />
      ) : null}
      {scan?.error ? (
        <Alert
          size="sm"
          variant="error"
          title={t("usageOverview.scan.lastScanFailed")}
          description={scan.error}
        />
      ) : null}
      {unreadableRoots.map((root) => (
        <Alert
          key={root.path}
          size="sm"
          variant="error"
          description={t("usageOverview.scan.rootUnreadable", {
            path: root.path,
            reason: root.error ?? "",
          })}
        />
      ))}
      {failedCount > 0 ? (
        <Alert
          size="sm"
          variant="warning"
          title={t("usageOverview.scan.filesUnreadable", { count: failedCount })}
          description={
            firstFailure
              ? t("usageOverview.scan.firstFailure", {
                  path: firstFailure.path,
                  reason: firstFailure.error,
                })
              : undefined
          }
        />
      ) : null}
      {skippedLines > 0 ? (
        <Text style={styles.muted}>
          {t("usageOverview.scan.linesSkipped", { count: skippedLines })}
        </Text>
      ) : null}
      {forkCopies > 0 ? (
        <Text style={styles.muted}>
          {t("usageOverview.scan.forkCopies", { count: forkCopies })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing[2] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
