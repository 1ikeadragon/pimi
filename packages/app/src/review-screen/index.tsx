// Pimi. PolyForm-Noncommercial-1.0.0.
// Review screen shell: the title bar, then either the home (inbox of pull requests, or worktrees)
// or the page of one pull request or worktree, both at full width. The shell owns the back / forward
// history and the search text; each page owns its data (see `inbox.tsx`, `detail.tsx`).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { MenuHeader } from "@/components/headers/menu-header";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { ReviewDetail } from "./detail";
import { ReviewHomeBar } from "./header";
import { ReviewInbox } from "./inbox";
import { Notice } from "./notice";
import {
  defaultReviewTab,
  type ReviewDeskFocus,
  type ReviewMode,
  type ReviewSource,
} from "./types";
import { useReviewHistory } from "./use-review-history";

const PIMI_BACKGROUND = { "pimi-background": "" };

/** A worktree page survives a change of compare; a pull request page is its identity. */
function pageKey(source: ReviewSource): string {
  return source.kind === "checkout"
    ? `checkout|${source.serverId}|${source.cwd}`
    : JSON.stringify(source);
}

function modeOf(source: ReviewSource): ReviewMode {
  return source.kind === "checkout" ? "worktrees" : "pull_requests";
}

export function ReviewScreen({
  source: routeSource,
  focus = null,
  serverId,
}: {
  /** The change request or worktree named by the route, or null for the home. */
  source: ReviewSource | null;
  /** A file and line the route asks a worktree review to scroll to. */
  focus?: ReviewDeskFocus | null;
  /** Daemon the home reads through; null while no host is connected. */
  serverId: string | null;
}) {
  const { current, navigation } = useReviewHistory({
    mode: routeSource ? modeOf(routeSource) : "pull_requests",
    source: routeSource,
    tab: routeSource ? defaultReviewTab(routeSource) : "conversation",
    path: null,
  });
  const { push } = navigation;
  // A route change (sidebar link, chat card) opens that review as a new history entry.
  const routeKey = routeSource ? JSON.stringify(routeSource) : null;
  useEffect(() => {
    if (routeSource) {
      push({
        mode: modeOf(routeSource),
        source: routeSource,
        tab: defaultReviewTab(routeSource),
        path: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized source
  }, [routeKey, push]);

  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const onModeChange = useCallback(
    (mode: ReviewMode) => {
      setQuery("");
      push({ mode, source: null });
    },
    [push],
  );
  const onOpen = useCallback(
    (next: ReviewSource) => push({ source: next, tab: defaultReviewTab(next), path: null }),
    [push],
  );
  const onHome = useCallback(() => push({ source: null }), [push]);
  const { source } = current;

  let body: React.ReactNode;
  if (source) {
    body = (
      <ReviewDetail
        key={pageKey(source)}
        source={source}
        tab={current.tab}
        navigation={navigation}
        onHome={onHome}
        focus={focus}
      />
    );
  } else if (serverId) {
    body = <ReviewInbox serverId={serverId} mode={current.mode} query={query} onOpen={onOpen} />;
  } else {
    body = <Notice text={t("reviewScreen.connectHost")} />;
  }

  return (
    <View style={styles.screen} dataSet={PIMI_BACKGROUND} testID="pimi-review">
      <MenuHeader title={t("reviewScreen.title")} />
      {source ? null : (
        <ReviewHomeBar
          serverId={serverId}
          connected={connected}
          mode={current.mode}
          navigation={navigation}
          onModeChange={onModeChange}
          query={query}
          onQueryChange={setQuery}
        />
      )}
      <View style={styles.body}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surfaceWindow },
  body: { flex: 1, minHeight: 0 },
}));
