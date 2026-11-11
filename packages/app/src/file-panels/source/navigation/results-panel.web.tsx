import { memo, useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import type { CodeNavigationResult } from "@pimi/protocol/messages";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { Theme } from "@/styles/theme";

export type NavigationPanelState =
  | { status: "loading"; title: string }
  | { status: "error"; title: string; message: string }
  | { status: "results"; title: string; result: CodeNavigationResult; empty: string };

type Location = CodeNavigationResult["results"][number];

const ThemedX = withUnistyles(X);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function providerLabel(provider: CodeNavigationResult["provider"]): string {
  return provider === "typescript" ? "TypeScript" : "by name";
}

/** Results of a navigation query, docked at the bottom of the editor and grouped by file. */
export function NavigationResultsPanel({
  state,
  onSelect,
  onClose,
}: {
  state: NavigationPanelState;
  onSelect(location: Location): void;
  onClose(): void;
}) {
  const groups = useMemo(() => {
    if (state.status !== "results") return [];
    const byPath = new Map<string, Location[]>();
    for (const location of state.result.results) {
      const list = byPath.get(location.path);
      if (list) list.push(location);
      else byPath.set(location.path, [location]);
    }
    return [...byPath.entries()];
  }, [state]);

  let subtitle = "";
  if (state.status === "loading") subtitle = "Searching…";
  else if (state.status === "results") {
    const count = state.result.results.length;
    subtitle = `${providerLabel(state.result.provider)} · ${count}${state.result.truncated ? "+" : ""} ${
      count === 1 ? "result" : "results"
    }`;
  }

  return (
    <View style={styles.panel} testID="code-navigation-panel">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {state.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1} testID="code-navigation-provider">
          {subtitle}
        </Text>
        <ToolbarButton label="Close results" compact onPress={onClose}>
          <ThemedX size={14} uniProps={mutedIcon} />
        </ToolbarButton>
      </View>
      {state.status === "error" ? <Text style={styles.message}>{state.message}</Text> : null}
      {state.status === "results" && state.result.note ? (
        <Text style={styles.note}>{state.result.note}</Text>
      ) : null}
      {state.status === "results" && groups.length === 0 ? (
        <Text style={styles.message}>{state.empty}</Text>
      ) : null}
      {groups.length > 0 ? (
        <ScrollView style={styles.list}>
          {groups.map(([path, locations]) => (
            <View key={path}>
              <Text style={styles.path} numberOfLines={1}>
                {path}
              </Text>
              {locations.map((location) => (
                <ResultRow
                  key={`${location.line}:${location.column}`}
                  location={location}
                  onSelect={onSelect}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const ResultRow = memo(function ResultRow({
  location,
  onSelect,
}: {
  location: Location;
  onSelect(location: Location): void;
}) {
  const handlePress = useCallback(() => onSelect(location), [location, onSelect]);
  return (
    <PressHighlight onPress={handlePress} style={rowStyle} testID="code-navigation-result">
      <Text style={styles.line}>{location.line}</Text>
      <Text style={styles.preview} numberOfLines={1}>
        {location.preview}
      </Text>
      {location.role === "definition" ? <Text style={styles.badge}>definition</Text> : null}
    </PressHighlight>
  );
});

function rowStyle({ hovered }: { hovered?: boolean }) {
  return [styles.row, hovered && styles.rowHover];
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "45%",
    backgroundColor: theme.colors.surface1,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    zIndex: 5,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    height: 32,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
    flexShrink: 1,
  },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flex: 1 },
  list: { flexGrow: 0 },
  path: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    height: 24,
  },
  rowHover: { backgroundColor: theme.colors.surface2 },
  line: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    minWidth: 40,
    textAlign: "right",
  },
  preview: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    flex: 1,
  },
  badge: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
}));
