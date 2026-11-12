import { Text, View } from "react-native";
import { RotateCw, Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { WORKSPACE_SEARCH_LIMITS } from "@pimi/protocol/workspace-search";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type { WorkspaceSearchState } from "./store";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const StopIcon = withUnistyles(Square, mutedIconColorMapping);
const RefreshIcon = withUnistyles(RotateCw, mutedIconColorMapping);

function summarize(t: TFunction, state: WorkspaceSearchState): string | null {
  const { status, files, stats } = state;
  if (status === "searching") return t("workspaceSearch.searching");
  if (files.length === 0) {
    return status === "done" && !stats?.cancelled ? t("workspaceSearch.noResults") : null;
  }
  return t("workspaceSearch.summary", {
    count: stats?.matches ?? files.reduce((total, file) => total + file.occurrences, 0),
    files: t("workspaceSearch.fileCount", { count: files.length }),
  });
}

function limitNotice(t: TFunction, limit: "matches" | "files" | "time" | null): string | null {
  if (limit === "matches") {
    return t("workspaceSearch.limitMatches", {
      count: WORKSPACE_SEARCH_LIMITS.maxMatches.toLocaleString(),
    });
  }
  if (limit === "files") {
    return t("workspaceSearch.limitFiles", {
      count: WORKSPACE_SEARCH_LIMITS.maxFiles.toLocaleString(),
    });
  }
  if (limit === "time") {
    return t("workspaceSearch.limitTime", { seconds: WORKSPACE_SEARCH_LIMITS.timeoutMs / 1000 });
  }
  return null;
}

/** Result count, the cap that ended the search, errors, and what the last replace did. */
export function SearchStatus({
  state,
  canSearch,
  onStop,
  onRefresh,
}: {
  state: WorkspaceSearchState;
  canSearch: boolean;
  onStop(): void;
  onRefresh(): void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const glyphSize = paneContentToolbarIconSize(isCompact);
  const { status, error, stats, replaceOpen, replaceReport } = state;
  const limit = stats?.limitHit ?? null;
  const notice = limitNotice(t, limit);
  return (
    <View style={styles.container}>
      <View style={styles.statusRow}>
        {status === "searching" ? (
          <ThemedSpinner size="small" uniProps={mutedColorMapping} />
        ) : null}
        <Text style={styles.status} role="status" numberOfLines={1}>
          {summarize(t, state)}
        </Text>
        <View style={styles.spacer} />
        {status === "searching" ? (
          <ToolbarButton label={t("workspaceSearch.stop")} compact={isCompact} onPress={onStop}>
            <StopIcon size={glyphSize} />
          </ToolbarButton>
        ) : (
          <ToolbarButton
            label={t("workspaceSearch.refresh")}
            compact={isCompact}
            disabled={!canSearch}
            onPress={onRefresh}
          >
            <RefreshIcon size={glyphSize} />
          </ToolbarButton>
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {stats?.cancelled ? <Text style={styles.notice}>{t("workspaceSearch.stopped")}</Text> : null}
      {replaceOpen && limit ? (
        <Text style={styles.notice}>{t("workspaceSearch.replaceNeedsFullResults")}</Text>
      ) : null}
      {replaceReport ? (
        <>
          <Text style={replaceReport.error ? styles.error : styles.notice}>
            {replaceReport.error ??
              t("workspaceSearch.replaced", {
                count: replaceReport.replacements,
                files: t("workspaceSearch.fileCount", { count: replaceReport.filesChanged }),
              })}
          </Text>
          {replaceReport.skipped.map((skipped) => (
            <Text key={skipped.path} style={styles.notice} numberOfLines={2}>
              {t("workspaceSearch.skipped", { path: skipped.path, reason: skipped.reason })}
            </Text>
          ))}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[1] },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
  },
  status: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  spacer: { flex: 1 },
  error: {
    paddingHorizontal: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  notice: {
    paddingHorizontal: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
