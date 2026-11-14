import { setActiveBackdrop } from "./active-backdrop";
import type { BackdropSpec } from "./backdrop-spec";

const blobUrls = new Map<string, string>();
const playable = new WeakMap<BackdropSpec, BackdropSpec>();

/** A data URL becomes a blob URL once, so a large video streams instead of re-parsing a string. */
function playableSource(source: string): string {
  if (!source.startsWith("data:")) return source;
  const cached = blobUrls.get(source);
  if (cached) return cached;
  const comma = source.indexOf(",");
  const mime = source.slice(5, source.indexOf(";"));
  const binary = atob(source.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  blobUrls.set(source, url);
  return url;
}

/**
 * Hands a theme's backdrop to the root: the still layer (`--pimi-backdrop`, `--pimi-veil`) that
 * appearance.css paints on the `data-pimi-backdrop` element, and the live layer (video or shader)
 * that WindowBackdrop draws over it. A video's still layer is its poster, and a shader's is its
 * flat colour, so both show whenever the live layer cannot run. Web only: native has no backdrop.
 */
export function applyBackdrop(spec: BackdropSpec | null): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  if (!spec) {
    style.removeProperty("--pimi-backdrop");
    style.removeProperty("--pimi-veil");
    setActiveBackdrop(null);
    return;
  }
  if (spec.kind === "image") {
    style.setProperty("--pimi-backdrop", `url("${spec.image}")`);
    if (spec.veil) style.setProperty("--pimi-veil", `url("${spec.veil}")`);
    else style.removeProperty("--pimi-veil");
    setActiveBackdrop(spec);
  } else if (spec.kind === "video") {
    style.setProperty("--pimi-backdrop", `url("${spec.poster}")`);
    style.removeProperty("--pimi-veil");
    let resolved = playable.get(spec);
    if (!resolved) {
      resolved = { ...spec, video: playableSource(spec.video) };
      playable.set(spec, resolved);
    }
    setActiveBackdrop(resolved);
  } else {
    style.setProperty("--pimi-backdrop", `linear-gradient(${spec.flat}, ${spec.flat})`);
    style.removeProperty("--pimi-veil");
    setActiveBackdrop(spec);
  }
}

const decoded = new Set<string>();
const DECODE_LIMIT_MS = 1500;

function stillImages(spec: BackdropSpec): string[] {
  if (spec.kind === "image") return spec.veil ? [spec.image, spec.veil] : [spec.image];
  if (spec.kind === "video") return spec.veil ? [spec.poster, spec.veil] : [spec.poster];
  return [];
}

/**
 * Decodes a backdrop's still images so the theme can switch in one frame instead of painting
 * its flat colour while the image decodes. Null when nothing needs decoding. A broken or slow
 * image never blocks the switch: it settles after DECODE_LIMIT_MS either way.
 */
export function prepareBackdrop(spec: BackdropSpec | null): Promise<void> | null {
  if (!spec || typeof Image === "undefined") return null;
  const pending = stillImages(spec).filter((url) => !decoded.has(url));
  if (pending.length === 0) return null;
  const decodeAll = Promise.all(
    pending.map((url) => {
      const image = new Image();
      image.src = url;
      return image.decode().then(
        () => void decoded.add(url),
        () => undefined,
      );
    }),
  ).then(() => undefined);
  const limit = new Promise<void>((resolve) => setTimeout(resolve, DECODE_LIMIT_MS));
  return Promise.race([decodeAll, limit]);
}
