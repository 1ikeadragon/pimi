import { memo, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  MAX_NESTED_CHANGED_FILES,
  type NestedChangedFile,
  type NestedChangesRepository,
} from "@pimi/protocol/messages";
import { getErrorMessage } from "@pimi/protocol/error-utils";
import { PressHighlight } from "@/components/ui/press-highlight";
import { treeRowPaddingLeft, WORKSPACE_TREE_ICON_LABEL_GAP } from "@/components/tree-primitives";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import {
  CleanRow,
  PanelBody,
  rowPressableStyle,
  SourceControlHeader,
} from "@/git/source-control/panel-parts";
import { FILE_STATE_PRESENTATION } from "@/git/source-control/file-state";
import { RepositoryRow } from "@/git/source-control/repository-row";
import {
  buildSourceControlModel,
  listChangedRepositories,
  resolveExpandedRoots,
  type ExpansionOverrides,
  type SourceControlRow,
} from "@/git/source-control/rows";
import { useNestedChanges } from "@/git/use-nested-changes";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useTranslation } from "@/i18n/use-translation";
import { checkoutReviewSource, openPimiReview } from "@/navigation/pimi-review";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

// ---
// Expansion

interface ExpansionState {
  overrides: ExpansionOverrides;
  sequence: number;
}

interface ToggleExpansion {
  root: string;
  expanded: boolean;
}

function reduceExpansion(state: ExpansionState, action: ToggleExpansion): ExpansionState {
  const sequence = state.sequence + 1;
  return {
    sequence,
    overrides: { ...state.overrides, [action.root]: { expanded: action.expanded, sequence } },
  };
}

const INITIAL_EXPANSION: ExpansionState = { overrides: {}, sequence: 0 };

// ---
// Time

/** One tick per second is the finest unit the "checked Ns ago" label shows. */
const CHECKED_AGO_TICK_MS = 1_000;

/** Wall-clock for relative labels; ticks only while `active` so a hidden panel runs no timer. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CHECKED_AGO_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// ---
// A changed file

interface FileRowProps {
  repository: NestedChangesRepository;
  file: NestedChangedFile;
  onOpen: (root: string, path: string) => void;
}

const FileRow = memo(function FileRow({ repository, file, onOpen }: FileRowProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onOpen(repository.root, file.path),
    [file.path, onOpen, repository.root],
  );
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash === -1 ? "" : file.path.slice(0, slash);
  const presentation = FILE_STATE_PRESENTATION[file.state];
  const stateLabel = t(`panels.sourceControl.state.${file.state}`);
  return (
    <PressHighlight
      onPress={handlePress}
      style={rowPressableStyle}
      accessibilityRole="button"
      accessibilityLabel={`${file.path}, ${stateLabel}`}
      testID={`source-control-file-${repository.name}-${file.path}`}
    >
      <View style={[styles.fileLeft, inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(1) })]}>
        <Text style={styles.fileName} numberOfLines={1}>
          {name}
        </Text>
        {dir ? (
          <Text style={styles.fileDir} numberOfLines={1} ellipsizeMode="middle">
            {dir}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.letter, styles[presentation.tone]]}>{presentation.letter}</Text>
    </PressHighlight>
  );
});

// ---
// Panel

interface SourceControlPanelProps {
  serverId: string;
  /** The plain folder whose repositories are listed. */
  cwd: string;
  /** False while the panel is hidden: the daemon is not asked to watch or poll. */
  enabled: boolean;
  /** Opens the diff of one changed file of the repository at `root`. */
  onOpenDiff: (root: string, path: string) => void;
}

export function SourceControlPanel({
  serverId,
  cwd,
  enabled,
  onOpenDiff,
}: SourceControlPanelProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { state, refresh, setWatchedRoots } = useNestedChanges({ serverId, cwd, enabled });
  const [expansion, toggleExpansion] = useReducer(reduceExpansion, INITIAL_EXPANSION);
  const [cleanExpanded, setCleanExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(enabled);

  const repositories = useMemo(() => (state.status === "idle" ? [] : state.repositories), [state]);
  const changed = useMemo(() => listChangedRepositories(repositories), [repositories]);
  const expandedRoots = useMemo(
    () => resolveExpandedRoots(changed, expansion.overrides),
    [changed, expansion.overrides],
  );
  const model = useMemo(
    () => buildSourceControlModel({ repositories, expandedRoots, cleanExpanded }),
    [cleanExpanded, expandedRoots, repositories],
  );

  const expandedKey = expandedRoots.join("\0");
  useEffect(() => {
    setWatchedRoots(expandedKey ? expandedKey.split("\0") : []);
  }, [expandedKey, setWatchedRoots]);

  const handleToggle = useCallback(
    (root: string) => toggleExpansion({ root, expanded: !expandedRoots.includes(root) }),
    [expandedRoots],
  );
  const handleToggleClean = useCallback(() => setCleanExpanded((value) => !value), []);

  const runRefresh = useCallback(
    async (root: string | null) => {
      setRefreshing(true);
      try {
        await refresh(root);
      } catch (error) {
        toast.error(`${t("panels.sourceControl.refreshFailed")} ${getErrorMessage(error)}`);
      } finally {
        setRefreshing(false);
      }
    },
    [refresh, t, toast],
  );
  const handleRefreshAll = useCallback(() => void runRefresh(null), [runRefresh]);
  const handleRefreshRepository = useCallback(
    (root: string) => void runRefresh(root),
    [runRefresh],
  );

  const isLocal = useIsLocalDaemon(serverId);
  const canOpenReview = Boolean(getDesktopHost()?.showPimiWorkspace) && isLocal;
  const handleOpenInReview = useCallback(
    (root: string) => openPimiReview(checkoutReviewSource({ serverId, cwd: root })),
    [serverId],
  );
  const { targets } = useDesktopOpenTargets({ isLocalExecution: isLocal });
  const fileManagerTarget = targets.find((target) => target.kind === "file-manager");
  const handleReveal = useCallback(
    async (root: string) => {
      if (!fileManagerTarget) return;
      try {
        await openDesktopTarget({
          editorId: fileManagerTarget.id,
          workspacePath: root,
          filePath: root,
        });
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [fileManagerTarget, toast],
  );

  const renderItem = useCallback(
    ({ item }: { item: SourceControlRow }) => {
      switch (item.kind) {
        case "group":
          return (
            <RepositoryRow
              repository={item.repository}
              expanded={item.expanded}
              onToggle={handleToggle}
              onRefresh={handleRefreshRepository}
              onOpenInReview={canOpenReview ? handleOpenInReview : null}
              onReveal={fileManagerTarget ? handleReveal : null}
              revealTargetName={fileManagerTarget?.label}
            />
          );
        case "section":
          return (
            <Text style={styles.section}>
              {item.staged ? t("panels.sourceControl.staged") : t("panels.sourceControl.unstaged")}
            </Text>
          );
        case "file":
          return <FileRow repository={item.repository} file={item.file} onOpen={onOpenDiff} />;
        case "error":
          return (
            <Text style={styles.errorNotice} selectable>
              {item.message}
            </Text>
          );
        case "truncated":
          return (
            <Text style={styles.notice}>
              {t("panels.sourceControl.filesTruncated", { count: MAX_NESTED_CHANGED_FILES })}
            </Text>
          );
        case "clean":
          return (
            <CleanRow count={item.count} expanded={item.expanded} onToggle={handleToggleClean} />
          );
        case "clean_repository":
          return (
            <View style={styles.cleanRepository}>
              <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
                {item.repository.name}
              </Text>
              <Text style={styles.fileDir} numberOfLines={1} ellipsizeMode="middle">
                {item.repository.branch ?? t("panels.sourceControl.detached")}
              </Text>
            </View>
          );
      }
    },
    [
      canOpenReview,
      fileManagerTarget,
      handleOpenInReview,
      handleReveal,
      handleRefreshRepository,
      handleToggle,
      handleToggleClean,
      onOpenDiff,
      t,
    ],
  );
  const keyExtractor = useCallback((item: SourceControlRow) => item.key, []);

  return (
    <View style={styles.container} testID="source-control-panel">
      <SourceControlHeader
        showCounts={!(state.status === "error" && model.repositoryCount === 0)}
        repositoryCount={model.repositoryCount}
        changeCount={model.changeCount}
        checking={model.checkingCount > 0}
        oldestCheckedAt={model.oldestCheckedAt}
        now={now}
        refreshing={refreshing}
        onRefresh={handleRefreshAll}
      />
      {state.status === "ready" && state.truncated ? (
        <Text style={styles.notice}>{t("panels.sourceControl.listTruncated")}</Text>
      ) : null}
      {state.status === "ready" && state.watchError ? (
        <Text style={styles.errorNotice}>
          {t("panels.sourceControl.watchError", { error: state.watchError })}
        </Text>
      ) : null}
      {state.status === "error" && model.repositoryCount > 0 ? (
        <Text style={styles.errorNotice}>
          {t("panels.sourceControl.loadError", { error: state.error })}
        </Text>
      ) : null}
      <PanelBody state={state} model={model} renderItem={renderItem} keyExtractor={keyExtractor} />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  section: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingLeft: treeRowPaddingLeft(1),
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  notice: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  errorNotice: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    paddingLeft: treeRowPaddingLeft(1),
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  fileLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    flexShrink: 0,
    maxWidth: "70%",
    userSelect: "none",
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
    userSelect: "none",
  },
  letter: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    minWidth: 24,
    textAlign: "center",
  },
  modified: { color: theme.colors.statusWarning },
  added: { color: theme.colors.statusSuccess },
  deleted: { color: theme.colors.statusDanger },
  renamed: { color: theme.colors.statusMerged },
  cleanRepository: {
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    paddingLeft: treeRowPaddingLeft(1),
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[3],
  },
}));
