import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { LIVE_BACKDROPS, type LiveBackdrop as LiveBackdropConfig } from "./backdrops";
import { attachLiveBackdrop, detachLiveBackdrop } from "./engine.web";

const CANVAS_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
};

// `prefers-contrast: more` and forced colours show the flat surface colour, like every texture.
const CONTRAST_QUERY = "(prefers-contrast: more), (forced-colors: active)";

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-appearance"],
  });
  const contrast = window.matchMedia(CONTRAST_QUERY);
  contrast.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    contrast.removeEventListener("change", onChange);
  };
}

function getSnapshot(): LiveBackdropConfig | null {
  if (window.matchMedia(CONTRAST_QUERY).matches) return null;
  const mode = document.documentElement.dataset.appearance;
  return mode ? (LIVE_BACKDROPS[mode] ?? null) : null;
}

function getServerSnapshot(): LiveBackdropConfig | null {
  return null;
}

/** Animated backdrop for the active live theme. Rendered once, as the first child of the window shell. */
export function LiveBackdrop() {
  const backdrop = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!backdrop) return null;
  return <LiveBackdropCanvas backdrop={backdrop} />;
}

function LiveBackdropCanvas({ backdrop }: { backdrop: LiveBackdropConfig }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (ref.current) attachLiveBackdrop(ref.current, backdrop);
  }, [backdrop]);
  useLayoutEffect(() => {
    const canvas = ref.current;
    return () => {
      if (canvas) detachLiveBackdrop(canvas);
    };
  }, []);
  return <canvas ref={ref} aria-hidden style={CANVAS_STYLE} />;
}
