import {
  useActiveContext,
  useLayout,
  useNavigation,
  useRpc,
  useSubscription,
  useTheme,
  useWorkspaces,
  type PluginScreenProps,
} from "@pimi/plugin/client";
import { Icon, Loading } from "@pimi/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { MAX_FILES, scan, watch } from "../shared/contracts";
import { buildTree, layoutTree } from "../shared/treemap";
import { TreemapView } from "./treemap-view";

const MIN_SCALE = 1;
const MAX_SCALE = 12;
const NO_CHOICES: readonly { id: string; name: string }[] = [];

interface View2D {
  x: number;
  y: number;
  scale: number;
}

const HOME: View2D = { x: 0, y: 0, scale: 1 };

function clampScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

/** Themed styles for the screen, rebuilt only when the theme changes. */
function useThemedStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        center: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundColor: theme.colors.surface0,
        },
        muted: { color: theme.colors.foregroundMuted },
        title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600", flexShrink: 1 },
        button: { padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 },
        banner: { color: theme.colors.statusWarning, paddingHorizontal: 16, paddingBottom: 8 },
        choice: {
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        },
        choiceActive: { backgroundColor: theme.colors.accent },
        choiceText: { color: theme.colors.foreground },
        choiceTextActive: { color: theme.colors.accentForeground },
      }),
    [theme],
  );
}

export function MapScreen({ params }: PluginScreenProps) {
  const active = useActiveContext();
  const workspaces = useWorkspaces();
  const styles = useThemedStyles();
  const requested = params.workspaceId ?? active.workspaceId;
  const workspace = workspaces.find((candidate) => candidate.id === requested) ?? workspaces[0];
  const choices = useMemo(
    () =>
      workspaces.length > 1
        ? workspaces.map((candidate) => ({
            id: candidate.id,
            name: candidate.title ?? candidate.name,
          }))
        : NO_CHOICES,
    [workspaces],
  );
  if (!workspace) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Open a workspace to map its repository.</Text>
      </View>
    );
  }
  return (
    <WorkspaceMap
      key={workspace.id}
      workspaceId={workspace.id}
      workspaceName={workspace.title ?? workspace.name}
      focus={params.focus ?? null}
      choices={choices}
    />
  );
}

function WorkspaceMap({
  workspaceId,
  workspaceName,
  focus,
  choices,
}: {
  workspaceId: string;
  workspaceName: string;
  focus: string | null;
  choices: readonly { id: string; name: string }[];
}) {
  const theme = useTheme();
  const layout = useLayout();
  const navigation = useNavigation();
  const scanRpc = useRpc(scan);
  const styles = useThemedStyles();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setViewState] = useState<View2D>(HOME);
  // Gestures read the live view from a ref: rebuilding them mid-gesture would drop the touch.
  const viewRef = useRef<View2D>(HOME);
  const setView = useCallback((next: View2D) => {
    viewRef.current = next;
    setViewState(next);
  }, []);
  const query = useQuery({
    queryKey: ["repo-map", workspaceId],
    queryFn: () => scanRpc({ workspaceId }),
  });
  const { refetch } = query;
  // A save, checkout, or commit moves the map; the daemon says so and the screen reads it again.
  const onChanged = useCallback(() => void refetch(), [refetch]);
  useSubscription(watch, { workspaceId }, onChanged);

  const boxes = useMemo(() => {
    if (!query.data || size.width === 0) return [];
    const area = { x: 0, y: 0, w: size.width, h: size.height };
    return layoutTree(buildTree(query.data.files), area, {
      padding: 3,
      header: 14,
      minSize: 3,
      maxBoxes: 6000,
    });
  }, [query.data, size]);
  const [oldest, newest] = useMemo(() => {
    const times = (query.data?.files ?? []).flatMap((file) =>
      file.lastCommitAt === null ? [] : [file.lastCommitAt],
    );
    return times.length === 0 ? [0, 1] : [Math.min(...times), Math.max(...times)];
  }, [query.data]);

  const openFile = useCallback(
    (path: string) => navigation.openFile({ workspaceId, path }),
    [navigation, workspaceId],
  );
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
  }, []);
  const gestures = useMemo(() => {
    let start = HOME;
    const pan = Gesture.Pan()
      .runOnJS(true)
      .onBegin(() => {
        start = viewRef.current;
      })
      .onUpdate((event) => {
        setView({ ...start, x: start.x + event.translationX, y: start.y + event.translationY });
      });
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onBegin(() => {
        start = viewRef.current;
      })
      .onUpdate((event) => {
        setView({ ...start, scale: clampScale(start.scale * event.scale) });
      });
    return Gesture.Simultaneous(pan, pinch);
  }, [setView]);
  const zoomIn = useCallback(
    () => setView({ ...viewRef.current, scale: clampScale(viewRef.current.scale * 1.5) }),
    [setView],
  );
  const zoomOut = useCallback(
    () => setView({ ...viewRef.current, scale: clampScale(viewRef.current.scale / 1.5) }),
    [setView],
  );
  const reset = useCallback(() => setView(HOME), [setView]);

  const canvasStyle = useMemo(
    () => [
      mapStyles.canvas,
      { transform: [{ translateX: view.x }, { translateY: view.y }, { scale: view.scale }] },
    ],
    [view],
  );
  const barStyle = layout.compact ? mapStyles.barCompact : mapStyles.bar;
  const data = query.data;
  return (
    <View style={styles.screen}>
      <View style={barStyle}>
        <Text style={styles.title} numberOfLines={1}>
          {workspaceName}
        </Text>
        <Text style={styles.muted} testID="repo-map-summary">
          {summary(data, query.isFetching)}
        </Text>
        <View style={mapStyles.actions}>
          <BarButton label="Zoom in" onPress={zoomIn} icon="ZoomIn" />
          <BarButton label="Zoom out" onPress={zoomOut} icon="ZoomOut" />
          <BarButton label="Reset view" onPress={reset} icon="Maximize" />
        </View>
      </View>
      {data?.truncated ? (
        <Text style={styles.banner} testID="repo-map-truncated">
          {`Showing the first ${MAX_FILES.toLocaleString()} of ${data.total.toLocaleString()} tracked files.`}
        </Text>
      ) : null}
      {choices.length > 0 ? <Choices current={workspaceId} choices={choices} /> : null}
      <View style={mapStyles.map} onLayout={onLayout}>
        {query.isError ? (
          <View style={styles.center}>
            <Text
              style={styles.muted}
            >{`Could not read the repository: ${String(query.error)}`}</Text>
          </View>
        ) : null}
        {query.isLoading ? <Loading /> : null}
        {data && size.width > 0 ? (
          <GestureDetector gesture={gestures}>
            <View style={canvasStyle}>
              <TreemapView
                boxes={boxes}
                width={size.width}
                height={size.height}
                theme={theme}
                oldest={oldest}
                newest={newest}
                focus={focus}
                onPressFile={openFile}
              />
            </View>
          </GestureDetector>
        ) : null}
      </View>
    </View>
  );
}

function summary(data: { total: number } | undefined, busy: boolean): string {
  if (!data) return busy ? "Reading files…" : "";
  const files = `${data.total.toLocaleString()} files`;
  return busy ? `${files}, updating…` : files;
}

function BarButton({ label, onPress, icon }: { label: string; onPress(): void; icon: string }) {
  const theme = useTheme();
  const styles = useThemedStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.button}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
    </Pressable>
  );
}

function Choices({
  current,
  choices,
}: {
  current: string;
  choices: readonly { id: string; name: string }[];
}) {
  return (
    <View style={mapStyles.choices}>
      {choices.map((choice) => (
        <Choice key={choice.id} id={choice.id} name={choice.name} active={choice.id === current} />
      ))}
    </View>
  );
}

function Choice({ id, name, active }: { id: string; name: string; active: boolean }) {
  const navigation = useNavigation();
  const styles = useThemedStyles();
  const open = useCallback(
    () => navigation.openScreen({ screenId: "map", params: { workspaceId: id } }),
    [navigation, id],
  );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={open}
      style={active ? choiceActiveStyle(styles) : styles.choice}
    >
      <Text style={active ? styles.choiceTextActive : styles.choiceText}>{name}</Text>
    </Pressable>
  );
}

const activeStyles = new WeakMap<object, object>();
/** The active choice's merged style, built once per theme styles object. */
function choiceActiveStyle(styles: ReturnType<typeof useThemedStyles>) {
  let merged = activeStyles.get(styles);
  if (!merged) {
    merged = StyleSheet.flatten([styles.choice, styles.choiceActive]);
    activeStyles.set(styles, merged);
  }
  return merged;
}

const mapStyles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  barCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    padding: 12,
  },
  actions: { flexDirection: "row", gap: 8, marginLeft: "auto" },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  map: { flex: 1, overflow: "hidden" },
  canvas: { flex: 1 },
});
