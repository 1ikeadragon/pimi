import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { FindingSeverity } from "@pimi/protocol/attack/types";
import type { AttackCoverageMatrix, MatrixCell } from "./attack-graph-model";

function cellGlyph(cell: MatrixCell): string {
  if (cell.severity) return "●";
  return cell.visited ? "○" : "·";
}

function severityStyle(severity: FindingSeverity | null) {
  if (severity === "blocker") return styles.cellBlocker;
  if (severity === "major") return styles.cellMajor;
  if (severity === "minor") return styles.cellMinor;
  return null;
}

/** Routes by agents. Browser visits only: a clean row means "no tab went there", not "tested". */
export function CoverageMatrix({ matrix }: { matrix: AttackCoverageMatrix }) {
  const { t } = useTranslation();
  const more = (count: number) => t("attack.subviews.visualize.more", { count });
  return (
    <View style={styles.root} testID="attack-coverage-matrix">
      <View style={styles.row}>
        <Text style={[styles.routeCell, styles.head]} numberOfLines={1}>
          {t("attack.subviews.visualize.matrixRoute")}
        </Text>
        {matrix.agents.map((agent) => (
          <Text key={agent.id} style={[styles.cell, styles.head]} numberOfLines={1}>
            {agent.role}
          </Text>
        ))}
      </View>
      {matrix.rows.length === 0 ? (
        <Text style={styles.more}>{t("attack.subviews.visualize.noCoverage")}</Text>
      ) : null}
      {matrix.rows.map((row) => (
        <View key={row.route} style={[styles.row, styles.rowBorder]}>
          <Text style={[styles.routeCell, styles.routeText]} numberOfLines={1} selectable>
            {row.route}
          </Text>
          {row.cells.map((cell, index) => (
            <Text
              key={matrix.agents[index]?.id ?? index}
              style={[styles.cell, styles.glyph, severityStyle(cell.severity)]}
            >
              {cellGlyph(cell)}
            </Text>
          ))}
        </View>
      ))}
      {matrix.hiddenRoutes > 0 ? (
        <Text style={styles.more}>{more(matrix.hiddenRoutes)}</Text>
      ) : null}
      {matrix.hiddenAgents > 0 ? (
        <Text style={styles.more}>{more(matrix.hiddenAgents)}</Text>
      ) : null}
      <View style={styles.legend}>
        <Text style={styles.legendText}>· {t("attack.subviews.visualize.untested")}</Text>
        <Text style={styles.legendText}>○ {t("attack.subviews.visualize.visited")}</Text>
        <Text style={styles.legendText}>● {t("attack.subviews.visualize.legendFinding")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", minHeight: 32 },
  rowBorder: { borderTopWidth: 1, borderColor: theme.colors.border },
  routeCell: { flex: 1, minWidth: 140, paddingRight: theme.spacing[2] },
  cell: { width: 72, textAlign: "center", paddingHorizontal: theme.spacing[1] },
  head: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, fontWeight: "500" },
  routeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  glyph: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  cellBlocker: { color: theme.colors.statusDanger },
  cellMajor: { color: theme.colors.statusWarning },
  cellMinor: { color: theme.colors.foreground },
  more: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingTop: theme.spacing[2],
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  legendText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
