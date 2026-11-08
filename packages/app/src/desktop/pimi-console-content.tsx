// Pimi addition to the Paseo fork. Apache-2.0.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { DESKTOP_TRAFFIC_LIGHT_WIDTH, HEADER_INNER_HEIGHT } from "@/constants/layout";
import { useHasWindowChromeObstruction, WindowChromeRegion } from "@/utils/desktop-window";
import { getDesktopHost, usesPimiMacTitlebar } from "./host";
import { usePimiReportLinks } from "./use-pimi-report-links";

export const PIMI_CONSOLE_CONTENT_ID = "pimi-console-content";
const fill = { flex: 1 } as const;
const subscribe = (listener: () => void) =>
  getDesktopHost()?.pimiWorkspaceSection?.subscribe(listener) ?? (() => {});
const getSection = () => getDesktopHost()?.pimiWorkspaceSection?.get() ?? null;

export function usePimiWorkspaceSection() {
  return useSyncExternalStore(subscribe, getSection, () => null);
}

export function PimiConsoleContent({
  children,
  sidebar,
  pathname,
}: {
  children: ReactNode;
  sidebar: boolean;
  pathname: string;
}) {
  usePimiReportLinks();
  const host = getDesktopHost();
  const publishBounds = host?.setPimiContentBounds;
  const covered = usePimiWorkspaceSection() !== null;
  const macTitlebar = usesPimiMacTitlebar();
  const hasTopLeftControls = useHasWindowChromeObstruction("top-left");
  const topInset = macTitlebar && hasTopLeftControls ? HEADER_INNER_HEIGHT : 0;
  const [leftOffset, setLeftOffset] = useState(0);
  const previousPath = useRef(pathname);

  useEffect(() => {
    if (pathname === previousPath.current) return;
    previousPath.current = pathname;
    host?.dismissPimiWorkspace?.();
  }, [host, pathname]);

  useLayoutEffect(() => {
    if (!publishBounds) return;
    const element = document.getElementById(PIMI_CONSOLE_CONTENT_ID);
    if (!element) return;
    // Sidebar drag and dock transitions change the content rect without resizing the window.
    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      if (macTitlebar) setLeftOffset(Math.min(DESKTOP_TRAFFIC_LIGHT_WIDTH, Math.max(0, x)));
      publishBounds({ x, y: y + topInset, width, height: height - topInset, sidebar });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [macTitlebar, publishBounds, sidebar, topInset]);

  useLayoutEffect(() => {
    if (!publishBounds) return;
    const element = document.getElementById(PIMI_CONSOLE_CONTENT_ID);
    if (!element) return;
    const wasCovered = element.inert;
    element.inert = covered;
    if (wasCovered && !covered && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const animation = element.animate([{ opacity: 0.84 }, { opacity: 1 }], {
        duration: 145,
        easing: "ease-out",
      });
      return () => animation.cancel();
    }
  }, [covered, publishBounds]);

  const console = (
    <View style={fill} nativeID={publishBounds ? PIMI_CONSOLE_CONTENT_ID : undefined}>
      {children}
    </View>
  );
  if (!macTitlebar) return console;
  const ownsTopLeft = leftOffset < DESKTOP_TRAFFIC_LIGHT_WIDTH;
  return (
    <View style={fill}>
      <WindowChromeRegion
        corners={ownsTopLeft ? "both" : "top-right"}
        topLeftOffset={ownsTopLeft ? leftOffset : 0}
      >
        {console}
      </WindowChromeRegion>
      {covered && topInset > 0 ? (
        <View style={styles.titlebar} testID="pimi-workspace-titlebar">
          <TitlebarDragRegion />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  titlebar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: HEADER_INNER_HEIGHT,
    backgroundColor: theme.colors.surfaceSidebar,
    zIndex: 2,
  },
}));
