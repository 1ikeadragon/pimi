import type { BackdropSpec } from "./backdrop-spec";

const TEXTURES = "/pimi-textures";

function sky(name: string): BackdropSpec {
  return {
    kind: "image",
    image: `${TEXTURES}/${name}.webp`,
    veil: `${TEXTURES}/${name}-veil.webp`,
  };
}

// Keyed by `data-appearance` mode. To swap a theme's art, replace the files in
// packages/app/public/pimi-textures or point the spec at new ones: nothing else reads them.
export const BUILTIN_BACKDROPS: Record<string, BackdropSpec> = {
  "sky-day": sky("sky-day"),
  "sky-dusk": sky("sky-dusk"),
  "sky-night": sky("sky-night"),
  "sky-dawn": sky("sky-dawn"),
  tide: {
    kind: "video",
    video: `${TEXTURES}/tide.mp4`,
    poster: `${TEXTURES}/tide-poster.webp`,
    veil: `${TEXTURES}/tide-veil.webp`,
  },
};
