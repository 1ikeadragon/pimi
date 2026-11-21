// Pimi. PolyForm-Noncommercial-1.0.0.
// Review home: the signed-in user's pull requests as one full-width list (filter, search, pasted
// URL), or the host's worktrees in Worktrees mode. Rows come from the live inbox query, else from
// the last inbox this host answered, so the page is never blank on a revisit.
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FlatList, Text, View } from "react-native";
import { GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { DiffStat } from "@/components/diff-stat";
import { useIsCompactFormFactor } from "@/constants/layout";
import { resolveWorkingDiffComparison } from "@/git/working-diff-comparison";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useWorkspace, useWorkspaceKeys } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";
import { INBOX_ROW_HEIGHT, INBOX_ROW_HEIGHT_COMPACT, InboxRow } from "./inbox-row";
import { prefetchChangeRequest } from "./queries";
import type { ChangeRequestSource, ReviewMode, ReviewSource } from "./types";
import {
  parsePastedChangeRequest,
  useReviewInbox,
  type ChangeRequestInbox,
  type InboxItem,
} from "./use-inbox";

type InboxFilter = "requested" | "mine" | "all";

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];
const EMPTY_SOURCES: ChangeRequestInbox["sources"] = [];

const ThemedBranch = withUnistyles(GitBranch);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ReviewInbox({
  serverId,
  mode,
  query,
  onOpen,
}: {
  serverId: string;
  mode: ReviewMode;
  /** The top bar's search text. */
  query: string;
  onOpen: (source: ReviewSource) => void;
}) {
  return mode === "pull_requests" ? (
    <PullRequestInbox serverId={serverId} query={query} onOpen={onOpen} />
  ) : (
    <WorktreeInbox serverId={serverId} query={query} onOpen={onOpen} />
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

function keyOfItem(item: InboxItem): string {
  return `${item.forgeHost}/${item.owner}/${item.name}#${item.number}`;
}

function PullRequestInbox({
  serverId,
  query,
  onOpen,
}: {
  serverId: string;
  query: string;
  onOpen: (source: ReviewSource) => void;
}) {
  const { t } = useTranslation();
  const inbox = useReviewInbox(serverId);
  const data = inbox.data;
  const [picked, setPicked] = useState<InboxFilter | null>(null);
  const needle = query.trim().toLowerCase();
  const pasted = useMemo(() => parsePastedChangeRequest(serverId, query), [serverId, query]);

  const counts = useMemo(() => {
    const items = data?.items ?? [];
    return {
      requested: items.filter((item) => item.reviewRequested).length,
      mine: items.filter((item) => item.authoredByMe).length,
      all: items.length,
    };
  }, [data]);
  // Needs my review while anything is waiting on the user, else everything.
  const filter: InboxFilter = picked ?? (counts.requested > 0 ? "requested" : "all");
  const options = useMemo<SegmentedControlOption<InboxFilter>[]>(
    () => [
      {
        value: "requested",
        label: t("reviewScreen.filterNeedsReview", { count: counts.requested }),
        testID: "review-filter-requested",
      },
      {
        value: "mine",
        label: t("reviewScreen.filterMine", { count: counts.mine }),
        testID: "review-filter-mine",
      },
      {
        value: "all",
        label: t("reviewScreen.filterAll", { count: counts.all }),
        testID: "review-filter-all",
      },
    ],
    [t, counts],
  );
  const items = useMemo(
    () =>
      (data?.items ?? []).filter((item) => {
        if (filter === "requested" && !item.reviewRequested) return false;
        if (filter === "mine" && !item.authoredByMe) return false;
        return matchesQuery(item, needle);
      }),
    [data, filter, needle],
  );
  const showAll = useCallback(() => setPicked("all"), []);

  const queryClient = useQueryClient();
  const openPasted = useCallback(() => {
    if (!pasted) return;
    prefetchChangeRequest(queryClient, getHostRuntimeStore().getClient(serverId), pasted);
    onOpen(pasted);
  }, [pasted, onOpen, queryClient, serverId]);
  const openRow = useCallback((source: ChangeRequestSource) => onOpen(source), [onOpen]);

  const renderItem = useCallback(
    ({ item, index }: { item: InboxItem; index: number }) => (
      <Column separated={index > 0}>
        <InboxRow item={item} serverId={serverId} onOpen={openRow} />
      </Column>
    ),
    [serverId, openRow],
  );

  const header = useMemo(
    () => (
      <Column>
        <View style={styles.filterRow}>
          <SegmentedControl
            options={options}
            value={filter}
            onValueChange={setPicked}
            size="sm"
            appearance="track"
            accessibilityLabel={t("reviewScreen.filterLabel")}
            testID="review-inbox-filter"
          />
        </View>
        <InboxNotices
          connected={inbox.connected}
          error={data?.error ?? null}
          sources={data?.sources ?? EMPTY_SOURCES}
        />
        {pasted ? (
          <PressHighlight
            onPress={openPasted}
            style={styles.pasted}
            accessibilityRole="button"
            testID="review-inbox-open-pasted"
          >
            <Text style={styles.pastedText} numberOfLines={1}>
              {t("reviewScreen.openPasted", {
                repo: `${pasted.owner}/${pasted.name}`,
                number: pasted.number,
              })}
            </Text>
          </PressHighlight>
        ) : null}
      </Column>
    ),
    [t, options, filter, inbox.connected, data, pasted, openPasted],
  );

  const loading = inbox.connected && data === undefined && inbox.query.isPending;
  let empty: React.ReactElement | null = null;
  if (loading) empty = <InboxSkeleton />;
  else if (!(pasted && items.length === 0)) {
    empty = (
      <InboxEmpty
        filtered={needle !== ""}
        filter={filter}
        hasAny={counts.all > 0}
        failed={data?.error != null || !inbox.connected || inbox.query.isError}
        onShowAll={showAll}
      />
    );
  }

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={items}
      renderItem={renderItem}
      keyExtractor={keyOfItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      testID="review-inbox-list"
    />
  );
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
      return error?.message?.trim() ? error.message : t("reviewScreen.errGeneric");
  }
}

/** Whole-inbox failure and a host that is not connected are alerts; one failed source is a banner. */
function InboxNotices({
  connected,
  error,
  sources,
}: {
  connected: boolean;
  error: ChangeRequestInbox["error"];
  sources: ChangeRequestInbox["sources"];
}) {
  const { t } = useTranslation();
  const failed = sources.filter((source) => source.status === "error");
  if (!connected) {
    return (
      <View style={styles.notice}>
        <Alert variant="warning" description={t("reviewScreen.connectHost")} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.notice}>
        <Alert variant="warning" description={errorCopy(error, t)} testID="review-inbox-error" />
      </View>
    );
  }
  if (failed.length === 0) return null;
  const reasons = [...new Set(failed.map((source) => errorCopy(source.error, t)))].join(" · ");
  return (
    <View style={styles.banner} testID="review-inbox-partial">
      <Text style={styles.bannerText}>
        {t("reviewScreen.partial")}: {reasons}
      </Text>
    </View>
  );
}

function InboxEmpty({
  filtered,
  filter,
  hasAny,
  failed,
  onShowAll,
}: {
  filtered: boolean;
  filter: InboxFilter;
  hasAny: boolean;
  failed: boolean;
  onShowAll: () => void;
}) {
  const { t } = useTranslation();
  if (failed && !hasAny) return null;
  let text = t("reviewScreen.emptyPullRequests");
  if (filtered) text = t("reviewScreen.noMatches");
  else if (filter === "requested") text = t("reviewScreen.emptyNeedsReview");
  else if (filter === "mine") text = t("reviewScreen.emptyMine");
  return (
    <View style={styles.empty} testID="review-inbox-empty">
      <Text style={styles.emptyText}>{text}</Text>
      {!filtered && filter !== "all" && hasAny ? (
        <Button size="sm" variant="ghost" onPress={onShowAll}>
          {t("reviewScreen.showAll")}
        </Button>
      ) : null}
    </View>
  );
}

function InboxSkeleton() {
  const pulse = useSkeletonPulse();
  const isCompact = useIsCompactFormFactor();
  return (
    <Column testID="review-inbox-skeleton">
      {SKELETON_ROWS.map((row) => (
        <View key={row} style={isCompact ? styles.skeletonRowCompact : styles.skeletonRow}>
          <SkeletonPulse pulse={pulse} style={styles.skeletonGlyph} />
          <View style={styles.skeletonText}>
            <SkeletonPulse pulse={pulse} style={styles.skeletonTitle} />
            <SkeletonPulse pulse={pulse} style={styles.skeletonMeta} />
          </View>
        </View>
      ))}
    </Column>
  );
}

function WorktreeInbox({
  serverId,
  query,
  onOpen,
}: {
  serverId: string;
  query: string;
  onOpen: (source: ReviewSource) => void;
}) {
  const { t } = useTranslation();
  const keys = useWorkspaceKeys(serverId);
  const needle = query.trim().toLowerCase();
  const renderItem = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <Column separated={index > 0}>
        <WorktreeRow serverId={serverId} workspaceKey={item} needle={needle} onOpen={onOpen} />
      </Column>
    ),
    [serverId, needle, onOpen],
  );
  const keyExtractor = useCallback((key: string) => key, []);
  const empty = useMemo(
    () => (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>{t("reviewScreen.emptyWorktrees")}</Text>
      </View>
    ),
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
      testID="review-inbox-worktrees"
    />
  );
}

function worktreeRowStyle({ hovered }: { hovered?: boolean }) {
  return [styles.worktreeRow, Boolean(hovered) && styles.rowHovered];
}

function WorktreeRow({
  serverId,
  workspaceKey,
  needle,
  onOpen,
}: {
  serverId: string;
  workspaceKey: string;
  needle: string;
  onOpen: (source: ReviewSource) => void;
}) {
  const workspace = useWorkspace(serverId, workspaceKey);
  const cwd = workspace?.workspaceDirectory ?? null;
  const workspaceId = workspace?.id;
  const handlePress = useCallback(() => {
    if (!cwd) return;
    // Opens on the comparison the chat Changes pane shows for this worktree.
    const mode = resolveWorkingDiffComparison({ serverId, workspaceId, cwd });
    onOpen({ kind: "checkout", serverId, cwd, compare: { mode } });
  }, [onOpen, serverId, cwd, workspaceId]);
  if (!workspace || !cwd) return null;
  const label = workspace.title || workspace.name;
  if (
    needle &&
    !`${label}\n${workspace.projectDisplayName}\n${cwd}`.toLowerCase().includes(needle)
  ) {
    return null;
  }
  const branch = workspace.gitRuntime?.currentBranch ?? null;
  const meta = [workspace.projectDisplayName, branch].filter(Boolean).join(" · ");
  return (
    <PressHighlight
      onPress={handlePress}
      accessibilityRole="button"
      style={worktreeRowStyle}
      testID={`review-inbox-worktree-${workspace.id}`}
    >
      <View style={styles.worktreeGlyph}>
        <ThemedBranch size={16} uniProps={mutedMapping} />
      </View>
      <View style={styles.worktreeText}>
        <Text style={styles.worktreeTitle} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.worktreeMeta} numberOfLines={1} ellipsizeMode="middle">
          {meta}
        </Text>
      </View>
      {workspace.diffStat ? (
        <DiffStat
          additions={workspace.diffStat.additions}
          deletions={workspace.diffStat.deletions}
        />
      ) : null}
    </PressHighlight>
  );
}

/** The centered 1120 column every inbox row and header sits in. */
function Column({
  children,
  separated,
  testID,
}: {
  children: React.ReactNode;
  separated?: boolean;
  testID?: string;
}) {
  const isCompact = useIsCompactFormFactor();
  return (
    <View style={isCompact ? styles.columnCompact : styles.column} testID={testID}>
      {separated ? <View style={styles.hairline} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1, minHeight: 0 },
  listContent: { paddingBottom: theme.spacing[6] },
  column: {
    width: "100%",
    maxWidth: 1120,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[6],
  },
  columnCompact: {
    width: "100%",
    maxWidth: 1120,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[3],
  },
  hairline: {
    height: 1,
    marginHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.border,
  },
  filterRow: {
    flexDirection: "row",
    justifyContent: "center",
    paddingVertical: theme.spacing[4],
  },
  notice: { paddingBottom: theme.spacing[3] },
  banner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  bannerText: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  pasted: {
    height: INBOX_ROW_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  pastedText: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  empty: {
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[12],
  },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  rowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  skeletonRow: {
    height: INBOX_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  skeletonRowCompact: {
    height: INBOX_ROW_HEIGHT_COMPACT,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  skeletonGlyph: {
    width: 16,
    height: 16,
    marginHorizontal: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  skeletonText: { flex: 1, gap: theme.spacing[2] },
  skeletonTitle: {
    width: "55%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  skeletonMeta: {
    width: "35%",
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  worktreeRow: {
    height: INBOX_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  worktreeGlyph: { width: 20, alignItems: "center" },
  worktreeText: { flex: 1, minWidth: 0, gap: 2 },
  worktreeTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  worktreeMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
