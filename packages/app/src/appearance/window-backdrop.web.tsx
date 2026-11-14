import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { getActiveBackdrop, subscribeActiveBackdrop } from "./active-backdrop";
import type { BackdropSpec } from "./backdrop-spec";
import { attachLiveBackdrop, detachLiveBackdrop } from "./live/engine.web";
import type { LiveBackdrop } from "./live/backdrops";

const FILL: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
};

const VIDEO_STYLE: CSSProperties = { ...FILL, objectFit: "cover", objectPosition: "right top" };

// `prefers-contrast: more` and forced colours show the still layer only, like every texture.
const CONTRAST_QUERY = "(prefers-contrast: more), (forced-colors: active)";
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const unsubscribe = subscribeActiveBackdrop(onChange);
  const contrast = window.matchMedia(CONTRAST_QUERY);
  contrast.addEventListener("change", onChange);
  return () => {
    unsubscribe();
    contrast.removeEventListener("change", onChange);
  };
}

function getSnapshot(): BackdropSpec | null {
  if (window.matchMedia(CONTRAST_QUERY).matches) return null;
  return getActiveBackdrop();
}

function getServerSnapshot(): BackdropSpec | null {
  return null;
}

/**
 * The moving layer of the window backdrop, for a video or shader theme. Rendered once, as the first
 * child of the window shell; images need no element because appearance.css paints them.
 */
export function WindowBackdrop() {
  const spec = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (spec?.kind === "shader") return <ShaderCanvas backdrop={spec.live} />;
  if (spec?.kind === "video")
    return <VideoBackdrop video={spec.video} poster={spec.poster} veil={spec.veil} />;
  return null;
}

function ShaderCanvas({ backdrop }: { backdrop: LiveBackdrop }) {
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
  return <canvas ref={ref} aria-hidden style={FILL} />;
}

interface VideoBackdropProps {
  video: string;
  poster: string;
  veil: string | null;
}

// One <video> serves every video theme: a theme switch changes `src`, never the element. Plays only
// while the window is visible and focused. Under reduced motion, or if the clip cannot play, the
// element is hidden and the still layer (the poster, painted by appearance.css) shows instead.
function VideoBackdrop({ video, poster, veil }: VideoBackdropProps) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const motion = window.matchMedia(MOTION_QUERY);
    let failed = false;
    const sync = () => {
      const running = !motion.matches && !failed;
      element.style.visibility = running ? "" : "hidden";
      if (running && document.visibilityState === "visible" && document.hasFocus()) {
        void element.play().catch(() => undefined);
      } else {
        element.pause();
      }
    };
    const onError = () => {
      failed = true;
      sync();
    };
    const onSource = () => {
      failed = false;
      sync();
    };
    element.addEventListener("error", onError);
    element.addEventListener("loadstart", onSource);
    element.addEventListener("loadeddata", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    sync();
    return () => {
      element.removeEventListener("error", onError);
      element.removeEventListener("loadstart", onSource);
      element.removeEventListener("loadeddata", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
    };
  }, []);
  const veilStyle = useMemo<CSSProperties>(
    () => ({
      ...FILL,
      backgroundImage: veil ? `url("${veil}")` : "none",
      backgroundSize: "cover",
      backgroundPosition: "right top",
      backgroundRepeat: "no-repeat",
    }),
    [veil],
  );
  return (
    <>
      <video
        ref={ref}
        src={video}
        poster={poster}
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden
        style={VIDEO_STYLE}
      />
      {veil ? <div aria-hidden style={veilStyle} /> : null}
    </>
  );
}
