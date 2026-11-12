import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AttackRun, Finding } from "@pimi/protocol/attack/types";

type Coverage = "untested" | "clean" | "notTestable" | "findings";

export function annotationCoverage(
  run: AttackRun,
  findings: readonly Finding[],
  label: string,
): { state: Coverage; findingCount: number } {
  const findingCount = findings.filter(
    (finding) => finding.duplicateOf === null && finding.annotationLabels.includes(label),
  ).length;
  if (findingCount > 0) return { state: "findings", findingCount };
  const result = run.annotationResults[label];
  if (result) return { state: result.result === "clean" ? "clean" : "notTestable", findingCount };
  return { state: "untested", findingCount };
}

/** What became of each of the owner's pre-flight notes: findings, held, not testable, or untouched. */
export function AttackAnnotationResults({
  run,
  findings,
}: {
  run: AttackRun;
  findings: readonly Finding[];
}) {
  const { t } = useTranslation();
  if (run.annotations.length === 0) return null;
  return (
    <View style={styles.group} testID="attack-annotation-results">
      <Text style={styles.title}>
        {t("attack.annotations.title")} · {run.annotations.length}
      </Text>
      {run.annotations.map((item) => {
        const { state, findingCount } = annotationCoverage(run, findings, item.label);
        const note = run.annotationResults[item.label]?.note;
        return (
          <View
            key={item.label}
            style={styles.row}
            testID={`attack-annotation-result-${item.label}`}
          >
            <View style={[styles.dot, dotStyles[state]]} />
            <View style={styles.body}>
              <Text style={styles.label} numberOfLines={2}>
                {item.label} · {item.note.trim() || `<${item.tag}>`}
              </Text>
              <Text style={styles.status}>
                {state === "findings"
                  ? t("attack.annotations.findings", { count: findingCount })
                  : t(`attack.annotations.${state}`)}
                {note && state !== "findings" ? ` · ${note}` : ""}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  title: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, fontWeight: "500" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

const dotStyles = StyleSheet.create((theme) => ({
  untested: { backgroundColor: theme.colors.foregroundMuted },
  clean: { backgroundColor: theme.colors.palette.green[500] },
  notTestable: { backgroundColor: theme.colors.palette.amber[500] },
  findings: { backgroundColor: theme.colors.palette.red[500] },
}));
