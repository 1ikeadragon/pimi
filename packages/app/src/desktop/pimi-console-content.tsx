// Pimi addition to the Paseo fork. Apache-2.0.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { View } from "react-native";
import { getDesktopHost } from "./host";

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
  const host = getDesktopHost();
  const publishBounds = host?.setPimiContentBounds;
  const covered = usePimiWorkspaceSection() !== null;
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
      publishBounds({ x, y, width, height, sidebar });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [publishBounds, sidebar]);

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

  return (
    <View style={fill} nativeID={publishBounds ? PIMI_CONSOLE_CONTENT_ID : undefined}>
      {children}
    </View>
  );
}
