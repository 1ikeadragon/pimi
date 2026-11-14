export interface LiveBackdrop {
  shader: "waves";
  scheme: "light" | "dark";
  /** Luminance cap (dark) or floor (light) that the theme's text contrast was computed against. */
  limit: number;
  colors: {
    skyTop: string;
    skyLow: string;
    glow: string;
    far: string;
    near: string;
    crest: string;
  };
}

// Keyed by `data-appearance` mode. The shader's guard keeps every pixel inside `limit`. Under a
// luminance cap, "luminous" means saturated blue-cyan (low luminance weight), not pale: a pale
// highlight gets scaled down to grey by the guard.
export const LIVE_BACKDROPS: Record<string, LiveBackdrop> = {
  tide: {
    shader: "waves",
    scheme: "dark",
    limit: 0.033,
    colors: {
      skyTop: "#01040a",
      skyLow: "#042a3c",
      glow: "#10acd0",
      far: "#07475c",
      near: "#010a12",
      crest: "#2fd0f4",
    },
  },
};
