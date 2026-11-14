import type { PluginText } from "./text.js";
import type { JsonValue } from "@pimi/protocol/agent-types";
import type { PluginSerializableIcon } from "./icons.js";
import type { PluginRpcContract } from "./rpc.js";

/** The active theme as plugin code sees it. `colors` carries every semantic color token. */
export interface PluginTheme {
  readonly colorScheme: "light" | "dark";
  readonly colors: {
    readonly surface0: string;
    readonly surface1: string;
    readonly surface2: string;
    readonly border: string;
    readonly foreground: string;
    readonly foregroundMuted: string;
    readonly accent: string;
    readonly accentForeground: string;
    readonly statusSuccess: string;
    readonly statusWarning: string;
    readonly statusDanger: string;
    /** Every other semantic color token, by name. */
    readonly [token: string]: string;
  };
  readonly spacing: Readonly<Record<string, number>>;
  readonly borderRadius: Readonly<Record<string, number>>;
  readonly fontSize: Readonly<Record<string, number>>;
  readonly fontFamily: { readonly ui: string; readonly mono: string };
}

export interface PluginWorkspaceSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly projectDisplayName: string;
  readonly projectRootPath: string;
  readonly directory: string;
  readonly projectKind: "git" | "non_git" | "directory";
  readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
  readonly name: string;
  readonly title: string | null;
  readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
  readonly statusEnteredAt: string | null;
  readonly archivingAt: string | null;
  readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
}

export interface PluginAgentSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly model: string | null;
  readonly currentModeId: string | null;
  readonly thinkingOptionId: string | null;
  readonly requiresAttention: boolean;
  readonly attentionReason: "finished" | "error" | "permission" | null;
  readonly parentAgentId: string | null;
  readonly labels: Readonly<Record<string, string>>;
}

export interface PluginThemeColors {
  background: string;
  foreground: string;
  raised: string;
  control: string;
  border: string;
  accent?: string;
  mutedForeground: string;
  ring: string;
}

/**
 * Token overrides merged over the theme built from `colors`. Names must exist in the base theme;
 * an unknown name rejects the contribution. Colors are hex strings. Font sizes and families are
 * not here: the user's Appearance settings own them and apply over every theme.
 */
export interface PluginThemeTokens {
  colors?: Readonly<Record<string, string>>;
  spacing?: Readonly<Record<string, number>>;
  borderRadius?: Readonly<Record<string, number>>;
}

/**
 * A shader uniform value: a float, a hex color (`vec3`), or two to four numbers (`vec2` to `vec4`).
 * Names start with `u_`; `u_resolution`, `u_time`, `u_limit` and `u_light` are set by Pimi.
 */
export type PluginThemeUniform = number | string | readonly number[];

/**
 * One backdrop painted behind the whole window. A theme with a backdrop makes the window surfaces
 * clear, so the picture shows through the titlebar, sidebar and content. Web and desktop only.
 *
 * `image`, `poster` and `veil` are the contents of a webp, png or jpg file imported by the plugin
 * (`import sky from "./sky.webp"`), at most 512 KiB each. `video` is an mp4 or webm file, at most
 * 8 MiB, played muted and looped; `poster` is the still shown under reduced motion and while it
 * loads. `fragment` is GLSL ES 1.00 fragment source (`import fragment from "./waves.frag"`), at
 * most 32 KiB. The veil sits over the picture. Text contrast is the author's job: see `limit` on a
 * shader backdrop and the veil on the others.
 */
export type PluginThemeBackdrop =
  | { kind: "image"; image: string; veil?: string }
  | { kind: "video"; video: string; poster: string; veil?: string }
  | {
      kind: "shader";
      fragment: string;
      /** Must equal the theme's `appearance`. */
      scheme: "light" | "dark";
      /**
       * Luminance cap (dark) or floor (light) the shader keeps every pixel inside, passed as
       * `u_limit`. Defaults to the most the theme's `mutedForeground` text can sit on at 4.5:1.
       */
      limit?: number;
      uniforms?: Readonly<Record<string, PluginThemeUniform>>;
    };

export interface PluginThemeContribution<Text extends PluginText = string> {
  id: string;
  name: Text;
  appearance: "light" | "dark";
  colors: PluginThemeColors;
  tokens?: PluginThemeTokens;
  backdrop?: PluginThemeBackdrop;
}

export interface PluginAttachmentSourceContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginSerializableIcon;
  pickerTitle: Text;
  searchPlaceholder: Text;
  search: PluginRpcContract;
}

export type PluginTimelineData = JsonValue;

export interface PluginTimelineItem {
  type: "plugin";
  id?: string;
  kind: string;
  version: number;
  data: PluginTimelineData;
}

export interface PluginTimelineTransformResult {
  items: PluginTimelineItem[];
}

export type PluginCleanup = () => void | Promise<void>;
