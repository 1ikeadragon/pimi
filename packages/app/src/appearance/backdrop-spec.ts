import type { LiveBackdrop } from "./live/backdrops";

/**
 * What the root paints behind the whole window. Built-in themes and plugin themes declare their
 * backdrop in this one shape. Sources are URLs for built-ins and data URLs for plugins; the
 * renderer treats them alike.
 *
 * - `image`: drawn to cover the window, anchored top right, with an optional veil over it.
 * - `video`: a muted loop over its `poster`, with an optional veil over the video.
 * - `shader`: a live WebGL canvas over a flat colour that shows if it cannot run.
 */
export type BackdropSpec =
  | { kind: "image"; image: string; veil: string | null }
  | { kind: "video"; video: string; poster: string; veil: string | null }
  | { kind: "shader"; live: LiveBackdrop; flat: string };
