import { router, useUnstableGlobalHref, type Href } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PimiDestination, PimiWorkspaceSection } from "@pimi/protocol/pimi-task";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { DensityIcon } from "@/components/ui/density-icon";
import {
  navigateToWorkspace,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { getDesktopHost, type DesktopHostBridge } from "./host";

type ReviewLocation = NonNullable<
  ReturnType<NonNullable<DesktopHostBridge["pimiReviewLocation"]>["get"]>
>;
const subscribeReviewLocation = (listener: () => void) =>
  getDesktopHost()?.pimiReviewLocation?.subscribe(listener) ?? (() => {});
const getReviewLocationKey = () => {
  // Electron clones objects across the preload bridge. React needs a stable snapshot.
  const location = getDesktopHost()?.pimiReviewLocation?.get();
  return location?.view === "review-pr" ? location.url : (location?.view ?? null);
};

type Visit =
  | { kind: "section"; section: PimiWorkspaceSection }
  | { kind: "review"; location: ReviewLocation }
  | { kind: "workspace"; workspace: ActiveWorkspaceSelection; agentId: string | null }
  | { kind: "route"; href: string };

const SECTION_DESTINATIONS: Record<PimiWorkspaceSection, PimiDestination> = {
  tasks: { view: "tasks" },
  board: { view: "worktrees" },
  review: { view: "review-home" },
  memory: { view: "memory" },
  spaces: { view: "spaces" },
};
const HISTORY_LIMIT = 100;
const RESTORE_TIMEOUT_MS = 2_000;
const NO_KEYS: [] = [];

function restoreVisit(visit: Visit) {
  const host = getDesktopHost();
  if (visit.kind === "section") {
    host?.showPimiWorkspace?.(SECTION_DESTINATIONS[visit.section]);
    return;
  }
  if (visit.kind === "review") {
    host?.showPimiWorkspace?.(visit.location);
    return;
  }
  host?.dismissPimiWorkspace?.();
  if (visit.kind === "route") {
    router.navigate(visit.href as Href);
  } else {
    navigateToWorkspace({
      ...visit.workspace,
      target: visit.agentId ? { kind: "agent", agentId: visit.agentId } : undefined,
    });
  }
}

function useVisit(pathname: string, section: PimiWorkspaceSection | null) {
  const reviewLocation = useSyncExternalStore(
    subscribeReviewLocation,
    getReviewLocationKey,
    () => null,
  );
  const href = useUnstableGlobalHref();
  const workspace = useMemo(() => parseHostWorkspaceRouteFromPathname(pathname), [pathname]);
  const workspaceKey = workspace && `${workspace.serverId}:${workspace.workspaceId}`;
  const agentId = useWorkspaceLayoutStore((state) => {
    const layout = workspaceKey ? state.layoutByWorkspace[workspaceKey] : null;
    if (!layout) return null;
    const pane = findPaneById(layout.root, layout.focusedPaneId);
    const target = pane?.focusedTabId
      ? collectAllTabs(layout.root).find((tab) => tab.tabId === pane.focusedTabId)?.target
      : null;
    return target?.kind === "agent" ? target.agentId : null;
  });
  return useMemo<Visit | null>(() => {
    if (section === "review") {
      if (!reviewLocation) return null;
      const location: ReviewLocation =
        reviewLocation === "review-prs" || reviewLocation === "review-home"
          ? { view: reviewLocation }
          : { view: "review-pr", url: reviewLocation };
      return { kind: "review", location };
    }
    if (section) return { kind: "section", section };
    if (workspace) return { kind: "workspace", workspace, agentId };
    if (pathname === "/" || /^\/h\/[^/]+\/?$/.test(pathname)) return null;
    return { kind: "route", href };
  }, [agentId, href, pathname, reviewLocation, section, workspace]);
}

export function PimiNavigationHistory({
  pathname,
  section,
}: {
  pathname: string;
  section: PimiWorkspaceSection | null;
}) {
  const visit = useVisit(pathname, section);
  const visitKey = JSON.stringify(visit);
  const history = useRef<{ visit: Visit; key: string }[]>([]);
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [index, setIndex] = useState(-1);
  const [restoring, setRestoring] = useState(false);
  const previousPath = useRef(pathname);

  useEffect(() => {
    const pathChanged = previousPath.current !== pathname;
    previousPath.current = pathname;
    if (!visit || (pathChanged && section)) return;
    if (pending.current) {
      if (pending.current.key !== visitKey) return;
      clearTimeout(pending.current.timer);
      pending.current = null;
      setRestoring(false);
    }
    if (history.current[index]?.key === visitKey) return;
    const entries = [...history.current.slice(0, index + 1), { visit, key: visitKey }];
    history.current = entries.slice(-HISTORY_LIMIT);
    setIndex(history.current.length - 1);
  }, [index, pathname, section, visit, visitKey, restoring]);

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current.timer);
    },
    [],
  );

  const move = useCallback(
    (step: -1 | 1) => {
      const next = index + step;
      const entry = history.current[next];
      if (pending.current || !entry) return;
      const timer = setTimeout(() => {
        pending.current = null;
        setRestoring(false);
      }, RESTORE_TIMEOUT_MS);
      pending.current = { key: entry.key, timer };
      setRestoring(true);
      setIndex(next);
      restoreVisit(entry.visit);
    },
    [index],
  );
  const back = useCallback(() => move(-1), [move]);
  const forward = useCallback(() => move(1), [move]);

  return (
    <View style={styles.buttons}>
      <HeaderToggleButton
        onPress={back}
        disabled={restoring || index <= 0}
        tooltipLabel="Go back"
        tooltipKeys={NO_KEYS}
        tooltipSide="bottom"
        accessibilityLabel="Go back"
        testID="pimi-history-back"
      >
        <DensityIcon icon={ChevronLeft} size="sm" color="foregroundMuted" />
      </HeaderToggleButton>
      <HeaderToggleButton
        onPress={forward}
        disabled={restoring || index >= history.current.length - 1}
        tooltipLabel="Go forward"
        tooltipKeys={NO_KEYS}
        tooltipSide="bottom"
        accessibilityLabel="Go forward"
        testID="pimi-history-forward"
      >
        <DensityIcon icon={ChevronRight} size="sm" color="foregroundMuted" />
      </HeaderToggleButton>
    </View>
  );
}

const styles = StyleSheet.create({ buttons: { flexDirection: "row", alignItems: "center" } });
