import type { PluginThemeUniform } from "@pimi/plugin";

/**
 * A live shader backdrop: a fragment shader and its uniforms. The engine always sets
 * `u_resolution`, `u_time`, `u_limit` and `u_light`; everything else comes from `uniforms`. Only
 * plugin themes use a shader; Pimi's own themes are images and video.
 */
export interface LiveBackdrop {
  fragment: string;
  scheme: "light" | "dark";
  /** Luminance cap (dark) or floor (light) that the theme's text contrast was computed against. */
  limit: number;
  uniforms: Readonly<Record<string, PluginThemeUniform>>;
}
