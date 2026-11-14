// Pimi. PolyForm-Noncommercial-1.0.0.
// Stream S2 owns this file: the left rail. Title, search field, All / To review filter, and one row
// per change request (repo and number, title, state chips). Reads `forge.change_request.list_inbox`.
// In Worktrees mode the rail lists the host's workspaces instead.
import { useCallback, useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useWorkspace, useWorkspaceKeys } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";
import { ChecksChip, DecisionChip, StateChip } from "./chips";
import type { ChangeRequestSource, ReviewRailProps, ReviewSource } from "./types";
import {
  parsePastedChangeRequest,
  sameChangeRequest,
  useReviewInbox,
  type ChangeRequestInbox,
  type InboxItem,
} from "./use-inbox";

type RailFilter = "all" | "requested";

const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function ReviewRail({ serverId, mode, selected, onOpen }: ReviewRailProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RailFilter>("all");
  const isPullRequests = mode === "pull_requests";
  const filterOptions = useMemo<SegmentedControlOption<RailFilter>[]>(
    () => [
      {
        value: "all",
        label: t("reviewScreen.filterAll"),
        testID: "review-filter-all",
      },
      {
        value: "requested",
        label: t("reviewScreen.filterToReview"),
        testID: "review-filter-requested",
      },
    ],
    [t],
  );
  const inbox = useReviewInbox(serverId);

  return (
    <View style={styles.rail} testID="review-rail">
      <View style={styles.titleRow}>
        <Text style={styles.title}>
          {isPullRequests ? t("reviewScreen.pullRequests") : t("reviewScreen.worktrees")}
        </Text>
        {isPullRequests ? (
          <View style={styles.titleTrailing}>
            {inbox.query.isFetching ? <ThemedSpinner size={14} uniProps={mutedMapping} /> : null}
            <ToolbarButton
              label={t("reviewScreen.refresh")}
              onPress={inbox.refresh}
              disabled={!inbox.connected}
              testID="review-rail-refresh"
            >
              <ThemedRefresh size={14} uniProps={mutedMapping} />
            </ToolbarButton>
          </View>
        ) : null}
      </View>
      <View style={styles.controls}>
        <View style={styles.searchWrap}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={
              isPullRequests
                ? t("reviewScreen.searchPullRequests")
                : t("reviewScreen.searchWorktrees")
            }
            clearAccessibilityLabel={t("reviewScreen.clearSearch")}
            testID="review-rail-search"
          />
        </View>
        {isPullRequests ? (
          <SegmentedControl
            options={filterOptions}
            value={filter}
            onValueChange={setFilter}
            size="sm"
            appearance="track"
            accessibilityLabel={t("reviewScreen.filterLabel")}
            testID="review-rail-filter"
          />
        ) : null}
      </View>
      {isPullRequests ? (
        <PullRequestList
          serverId={serverId}
          inbox={inbox}
          query={query}
          filter={filter}
          selected={selected}
          onOpen={onOpen}
        />
      ) : (
        <WorktreeList serverId={serverId} query={query} selected={selected} onOpen={onOpen} />
      )}
    </View>
  );
}

function matchesQuery(item: InboxItem, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    item.title,
    `${item.owner}/${item.name}`,
    `#${item.number}`,
    item.author ?? "",
    item.headRefName ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

function PullRequestList({
  serverId,
  inbox,
  query,
  filter,
  selected,
  onOpen,
}: {
  serverId: string;
  inbox: ReturnType<typeof useReviewInbox>;
  query: string;
  filter: RailFilter;
  selected: ReviewSource | null;
  onOpen: (source: ReviewSource) => void;
}) {
  const data: ChangeRequestInbox | undefined = inbox.query.data;
  const needle = query.trim().toLowerCase();
  const items = useMemo(
    () =>
      (data?.items ?? []).filter(
        (item) => (filter === "all" || item.reviewRequested) && matchesQuery(item, needle),
      ),
    [data, filter, needle],
  );
  const pasted = useMemo(() => parsePastedChangeRequest(serverId, query), [serverId, query]);
  const selectedChangeRequest = selected?.kind === "change_request" ? selected : null;

  const renderItem = useCallback(
    ({ item }: { item: InboxItem }) => (
      <PullRequestRow
        item={item}
        serverId={serverId}
        active={selectedChangeRequest !== null && sameChangeRequest(item, selectedChangeRequest)}
        onOpen={onOpen}
      />
    ),
    [serverId, selectedChangeRequest, onOpen],
  );
  const keyExtractor = useCallback(
    (item: InboxItem) => `${item.forgeHost}/${item.owner}/${item.name}#${item.number}`,
    [],
  );
  const openPasted = useCallback(() => {
    if (pasted) onOpen(pasted);
  }, [pasted, onOpen]);

  const header = useMemo(
    () => (
      <PullRequestListHeader
        pasted={pasted}
        onOpenPasted={openPasted}
        error={data?.error ?? null}
        sources={data?.sources ?? EMPTY_SOURCES}
      />
    ),
    [pasted, openPasted, data],
  );
  const empty = useMemo(
    () => (
      <PullRequestListEmpty
        connected={inbox.connected}
        loading={inbox.query.isPending}
        failed={inbox.query.isError}
        hasError={data?.error != null}
        hasItems={data !== undefined && data.items.length > 0}
        hasPasted={pasted !== null}
      />
    ),
    [inbox.connected, inbox.query.isPending, inbox.query.isError, data, pasted],
  );

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      testID="review-rail-list"
    />
  );
}

const EMPTY_SOURCES: ChangeRequestInbox["sources"] = [];

function PullRequestListHeader({
  pasted,
  onOpenPasted,
  error,
  sources,
}: {
  pasted: ChangeRequestSource | null;
  onOpenPasted: () => void;
  error: ChangeRequestInbox["error"];
  sources: ChangeRequestInbox["sources"];
}) {
  const { t } = useTranslation();
  const failed = sources.filter((source) => source.status === "error");
  return (
    <View style={styles.listHeader}>
      {pasted ? (
        <PressHighlight
          onPress={onOpenPasted}
          style={styles.pasted}
          accessibilityRole="button"
          testID="review-rail-open-pasted"
        >
          <Text style={styles.rowTitle} numberOfLines={1}>
            {t("reviewScreen.openPasted", {
              repo: `${pasted.owner}/${pasted.name}`,
              number: pasted.number,
            })}
          </Text>
        </PressHighlight>
      ) : null}
      {error ? <Text style={styles.error}>{errorCopy(error, t)}</Text> : null}
      {!error && failed.length > 0 ? (
        <Text style={styles.error}>
          {t("reviewScreen.partial")}:{" "}
          {[...new Set(failed.map((source) => errorCopy(source.error, t)))].join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

function PullRequestListEmpty({
  connected,
  loading,
  failed,
  hasError,
  hasItems,
  hasPasted,
}: {
  connected: boolean;
  loading: boolean;
  failed: boolean;
  hasError: boolean;
  hasItems: boolean;
  hasPasted: boolean;
}) {
  const { t } = useTranslation();
  if (connected && loading) {
    return (
      <View style={styles.centered}>
        <ThemedSpinner size={14} uniProps={mutedMapping} />
      </View>
    );
  }
  let text: string | null = null;
  if (!connected) text = t("reviewScreen.connectHost");
  else if (failed) text = t("reviewScreen.errGeneric");
  else if (!hasError)
    text = hasItems ? t("reviewScreen.noMatches") : t("reviewScreen.emptyPullRequests");
  if (hasPasted && hasItems === false) return null;
  return text ? <Text style={styles.empty}>{text}</Text> : null;
}

function errorCopy(
  error: { code: string; message: string } | null,
  t: (key: string) => string,
): string {
  switch (error?.code) {
    case "unauthenticated":
      return t("reviewScreen.errUnauthenticated");
    case "cli_missing":
      return t("reviewScreen.errCliMissing");
    case "unsupported":
      return t("reviewScreen.errUnsupported");
    case "forbidden":
      return t("reviewScreen.errForbidden");
    default:
      return t("reviewScreen.errGeneric");
  }
}

function useRowStyle(active: boolean) {
  return useCallback(
    ({ hovered }: { hovered?: boolean }) => [
      styles.row,
      (active || Boolean(hovered)) && styles.rowActive,
    ],
    [active],
  );
}

function PullRequestRow({
  item,
  serverId,
  active,
  onOpen,
}: {
  item: InboxItem;
  serverId: string;
  active: boolean;
  onOpen: (source: ReviewSource) => void;
}) {
  const handlePress = useCallback(
    () =>
      onOpen({
        kind: "change_request",
        serverId,
        forgeHost: item.forgeHost,
        owner: item.owner,
        name: item.name,
        number: item.number,
      }),
    [onOpen, serverId, item],
  );
  const rowState = useMemo(() => ({ selected: active }), [active]);
  const rowStyle = useRowStyle(active);
  return (
    <PressHighlight
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={rowState}
      style={rowStyle}
      testID={`review-rail-row-${item.owner}-${item.name}-${item.number}`}
    >
      <Text style={styles.rowMeta} numberOfLines={1}>
        {item.owner}/{item.name} #{item.number}
      </Text>
      <Text style={styles.rowTitle} numberOfLines={2}>
        {item.title}
      </Text>
      <View style={styles.chips}>
        <StateChip state={item.state} isDraft={item.isDraft} size="xs" />
        <ChecksChip status={item.checksStatus} size="xs" />
        <DecisionChip decision={item.reviewDecision} size="xs" />
      </View>
    </PressHighlight>
  );
}

function WorktreeList({
  serverId,
  query,
  selected,
  onOpen,
}: {
  serverId: string;
  query: string;
  selected: ReviewSource | null;
  onOpen: (source: ReviewSource) => void;
}) {
  const { t } = useTranslation();
  const keys = useWorkspaceKeys(serverId);
  const needle = query.trim().toLowerCase();
  const renderItem = useCallback(
    ({ item }: { item: string }) => (
      <WorktreeRow
        serverId={serverId}
        workspaceKey={item}
        needle={needle}
        selected={selected}
        onOpen={onOpen}
      />
    ),
    [serverId, needle, selected, onOpen],
  );
  const keyExtractor = useCallback((key: string) => key, []);
  const empty = useMemo(
    () => <Text style={styles.empty}>{t("reviewScreen.emptyWorktrees")}</Text>,
    [t],
  );
  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={keys}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListEmptyComponent={empty}
      testID="review-rail-worktrees"
    />
  );
}

function WorktreeRow({
  serverId,
  workspaceKey,
  needle,
  selected,
  onOpen,
}: {
  serverId: string;
  workspaceKey: string;
  needle: string;
  selected: ReviewSource | null;
  onOpen: (source: ReviewSource) => void;
}) {
  const workspace = useWorkspace(serverId, workspaceKey);
  const cwd = workspace?.workspaceDirectory ?? null;
  const handlePress = useCallback(() => {
    if (cwd) onOpen({ kind: "checkout", serverId, cwd, compare: { mode: "base" } });
  }, [onOpen, serverId, cwd]);
  const active = selected?.kind === "checkout" && selected.cwd === cwd;
  const rowStyle = useRowStyle(active);
  if (!workspace || !cwd) return null;
  const label = workspace.title || workspace.name;
  if (
    needle &&
    !`${label}\n${workspace.projectDisplayName}\n${cwd}`.toLowerCase().includes(needle)
  ) {
    return null;
  }
  return (
    <PressHighlight
      onPress={handlePress}
      accessibilityRole="button"
      style={rowStyle}
      testID={`review-rail-worktree-${workspace.id}`}
    >
      <Text style={styles.rowMeta} numberOfLines={1}>
        {workspace.projectDisplayName}
      </Text>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surfaceSidebar },
  titleRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  titleTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  controls: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    alignItems: "flex-start",
  },
  searchWrap: { alignSelf: "stretch" },
  list: { flex: 1, minHeight: 0 },
  listContent: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  listHeader: { gap: theme.spacing[2] },
  row: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  rowActive: { backgroundColor: theme.colors.surfaceSidebarHover },
  pasted: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  rowMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
  },
  centered: { alignItems: "center", paddingVertical: theme.spacing[4] },
}));
