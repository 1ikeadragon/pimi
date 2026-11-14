import {
  findBackdropShaderSourceProblem,
  PLUGIN_BACKDROP_IMAGE_DATA_URL,
  PLUGIN_BACKDROP_IMAGE_MAX_BYTES,
  PLUGIN_BACKDROP_VIDEO_DATA_URL,
  PLUGIN_BACKDROP_VIDEO_MAX_BYTES,
} from "@pimi/plugin";
import type { PluginMessage } from "@pimi/plugin/client";
import { isPluginMessage } from "@pimi/plugin/client/host";
import { useMemo } from "react";
import { z } from "zod";
import type { PluginThemeContribution } from "../types";
import type { BackdropSpec } from "@/appearance/backdrop-spec";
import { findShaderProblem } from "@/appearance/live/shader-check";
import {
  buildDarkSemanticColors,
  buildDarkTheme,
  buildLightSemanticColors,
  buildLightTheme,
  darkTheme,
  lightTheme,
  overWindowBackdrop,
  type Theme,
} from "@/styles/theme";
import {
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
} from "../contribution-host";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";

const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Must be a hex color");

const RESERVED_UNIFORMS = new Set(["u_resolution", "u_time", "u_limit", "u_light"]);
const MAX_UNIFORMS = 16;
const MAX_IMAGE_DATA_URL_LENGTH = Math.ceil((PLUGIN_BACKDROP_IMAGE_MAX_BYTES * 4) / 3) + 32;

const MAX_VIDEO_DATA_URL_LENGTH = Math.ceil((PLUGIN_BACKDROP_VIDEO_MAX_BYTES * 4) / 3) + 32;

const videoSchema = z
  .string()
  .max(MAX_VIDEO_DATA_URL_LENGTH, "Backdrop video exceeds 8 MiB")
  .regex(
    PLUGIN_BACKDROP_VIDEO_DATA_URL,
    "Backdrop video must be an mp4 or webm file imported by the plugin",
  );

const imageSchema = z
  .string()
  .max(MAX_IMAGE_DATA_URL_LENGTH, "Backdrop image exceeds 512 KiB")
  .regex(
    PLUGIN_BACKDROP_IMAGE_DATA_URL,
    "Backdrop image must be a webp, png, or jpg file imported by the plugin",
  );

const uniformsSchema = z
  .record(
    z.string().regex(/^u_[A-Za-z0-9_]+$/, "Uniform names start with u_"),
    z.union([z.number().finite(), hexColorSchema, z.array(z.number().finite()).min(2).max(4)]),
  )
  .refine(
    (uniforms) => Object.keys(uniforms).length <= MAX_UNIFORMS,
    `At most ${MAX_UNIFORMS} uniforms`,
  )
  .refine(
    (uniforms) => Object.keys(uniforms).every((name) => !RESERVED_UNIFORMS.has(name)),
    "u_resolution, u_time, u_limit and u_light are set by Pimi",
  );

const backdropSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("image"), image: imageSchema, veil: imageSchema.optional() }),
  z.strictObject({
    kind: z.literal("video"),
    video: videoSchema,
    poster: imageSchema,
    veil: imageSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("shader"),
    fragment: z.string(),
    scheme: z.enum(["light", "dark"]),
    limit: z.number().min(0).max(1).optional(),
    uniforms: uniformsSchema.optional(),
  }),
]);

const contributionSchema: z.ZodType<PluginThemeContribution> = z.strictObject({
  id: z.string(),
  name: z.union([z.string().trim().min(1).max(60), z.custom<PluginMessage>(isPluginMessage)]),
  appearance: z.enum(["light", "dark"]),
  colors: z.strictObject({
    background: hexColorSchema,
    foreground: hexColorSchema,
    raised: hexColorSchema,
    control: hexColorSchema,
    border: hexColorSchema,
    accent: hexColorSchema.optional(),
    mutedForeground: hexColorSchema,
    ring: hexColorSchema,
  }),
  tokens: z
    .strictObject({
      colors: z.record(z.string(), hexColorSchema).optional(),
      spacing: z.record(z.string(), z.number().finite()).optional(),
      borderRadius: z.record(z.string(), z.number().finite()).optional(),
    })
    .optional(),
  backdrop: backdropSchema.optional(),
});

export interface PluginThemeOption {
  id: string;
  serverId: string;
  name: string;
  swatch: string;
  theme: Theme;
  backdrop: BackdropSpec | null;
}

interface PluginThemeTarget {
  serverId: string;
  contribution: PluginThemeContribution;
  plugin: InstalledPlugin;
}

export function parsePluginThemeContribution(value: unknown): PluginThemeContribution {
  const contribution = contributionSchema.parse(value);
  // Build once so an unknown token name rejects the contribution when the plugin registers it.
  buildPluginTheme(contribution);
  if (contribution.backdrop) resolveBackdrop(contribution, true);
  return contribution;
}

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function expandHex(color: string): string {
  const digits = color.slice(1);
  if (digits.length === 3 || digits.length === 4) {
    return Array.from(digits.slice(0, 3), (digit) => digit + digit).join("");
  }
  return digits.slice(0, 6);
}

function luminance(color: string): number {
  const hex = expandHex(color);
  const [r, g, b] = [0, 2, 4].map((at) => channel(Number.parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The most luminous (dark) or least luminous (light) pixel that keeps muted text at 4.5:1. */
function defaultLimit(contribution: PluginThemeContribution): number {
  const text = luminance(contribution.colors.mutedForeground);
  const limit =
    contribution.appearance === "dark" ? (text + 0.05) / 4.5 - 0.05 : 4.5 * (text + 0.05) - 0.05;
  return Math.min(Math.max(limit, 0), 1);
}

function resolveBackdrop(contribution: PluginThemeContribution, verify: boolean): BackdropSpec {
  const { backdrop } = contribution;
  const flat = contribution.colors.background;
  if (!backdrop) throw new Error("Theme has no backdrop");
  if (backdrop.kind === "image") {
    return { kind: "image", image: backdrop.image, veil: backdrop.veil ?? null };
  }
  if (backdrop.kind === "video") {
    return {
      kind: "video",
      video: backdrop.video,
      poster: backdrop.poster,
      veil: backdrop.veil ?? null,
    };
  }
  if (backdrop.scheme !== contribution.appearance) {
    throw new Error(
      `Shader backdrop scheme must equal the theme appearance "${contribution.appearance}"`,
    );
  }
  // Compiling opens a WebGL context, so it runs once when the plugin registers, not per catalog build.
  if (verify) {
    const sourceProblem = findBackdropShaderSourceProblem(backdrop.fragment);
    if (sourceProblem) throw new Error(`Shader backdrop fragment ${sourceProblem}`);
    const compileProblem = findShaderProblem(backdrop.fragment);
    if (compileProblem) throw new Error(`Shader backdrop does not compile: ${compileProblem}`);
  }
  return {
    kind: "shader",
    flat,
    live: {
      fragment: backdrop.fragment,
      scheme: backdrop.scheme,
      limit: backdrop.limit ?? defaultLimit(contribution),
      uniforms: backdrop.uniforms ?? {},
    },
  };
}

function overlayTokens<Group extends Record<string, unknown>>(
  group: string,
  base: Group,
  overrides: Record<string, unknown> | undefined,
): Group {
  if (!overrides) return base;
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(base, key) || typeof base[key] !== typeof overrides[key]) {
      throw new Error(`Unknown ${group} token: ${key}`);
    }
  }
  return { ...base, ...overrides };
}

function applyTokens(theme: Theme, tokens: PluginThemeContribution["tokens"]): Theme {
  if (!tokens) return theme;
  return {
    ...theme,
    colors: overlayTokens("color", theme.colors, tokens.colors),
    spacing: overlayTokens("spacing", theme.spacing, tokens.spacing),
    borderRadius: overlayTokens("borderRadius", theme.borderRadius, tokens.borderRadius),
  } as Theme;
}

// A theme with a backdrop gets the built-in seamless treatment: clear window surfaces over the
// root backdrop and a hairline between regions.
function seamless<
  Colors extends { surfaceWindow: string; surfaceChrome: string; borderWindow: string },
>(contribution: PluginThemeContribution, colors: Colors): Colors {
  if (!contribution.backdrop) return colors;
  return overWindowBackdrop(colors, `#${expandHex(contribution.colors.foreground)}1a`);
}

function buildDarkPluginTheme(contribution: PluginThemeContribution): Theme {
  const colors = contribution.colors;
  const accent = colors.accent ?? colors.foreground;
  return buildDarkTheme(
    seamless(
      contribution,
      buildDarkSemanticColors({
        surface0: colors.background,
        surface1: colors.raised,
        surface2: colors.control,
        surface3: colors.border,
        surface4: colors.ring,
        surfaceDiffEmpty: colors.raised,
        surfaceSidebar: colors.background,
        foreground: colors.foreground,
        foregroundMuted: colors.mutedForeground,
        foregroundExtraMuted: colors.ring,
        border: colors.border,
        borderAccent: colors.border,
        accent,
        accentBright: accent,
        accentForeground: colors.background,
        destructive: darkTheme.colors.destructive,
        terminalBlack: colors.control,
        terminalBrightBlack: colors.ring,
        ring: colors.ring,
      }),
    ),
  );
}

function buildLightPluginTheme(contribution: PluginThemeContribution): Theme {
  const colors = contribution.colors;
  const accent = colors.accent ?? colors.foreground;
  return buildLightTheme(
    seamless(
      contribution,
      buildLightSemanticColors({
        surface0: colors.background,
        surface1: colors.raised,
        surface2: colors.control,
        surface3: colors.border,
        surface4: colors.ring,
        surfaceDiffEmpty: colors.raised,
        surfaceSidebar: colors.control,
        foreground: colors.foreground,
        foregroundMuted: colors.mutedForeground,
        foregroundExtraMuted: colors.ring,
        border: colors.border,
        borderAccent: colors.border,
        accent,
        accentBright: accent,
        accentForeground: colors.background,
        primary: colors.foreground,
        primaryForeground: colors.background,
        destructive: lightTheme.colors.destructive,
        terminalBlack: colors.foreground,
        terminalBrightBlack: colors.ring,
        ring: colors.ring,
      }),
    ),
  );
}

function buildPluginTheme(contribution: PluginThemeContribution): Theme {
  const base =
    contribution.appearance === "light"
      ? buildLightPluginTheme(contribution)
      : buildDarkPluginTheme(contribution);
  return applyTokens(base, contribution.tokens);
}

function selectTarget(id: string, targets: PluginThemeTarget[]): PluginThemeTarget {
  const preferredHost = getPreferredPluginContributionHost(id);
  return targets.find((target) => target.serverId === preferredHost) ?? targets[0];
}

export function collectPluginThemes(plugins: InstalledPlugin[]): PluginThemeOption[] {
  const targetsById = new Map<string, PluginThemeTarget[]>();
  for (const plugin of plugins) {
    for (const contribution of plugin.themes) {
      const id = `${plugin.id}/theme/${contribution.id}`;
      const target = { serverId: plugin.serverId, contribution, plugin };
      const targets = targetsById.get(id);
      if (targets) targets.push(target);
      else targetsById.set(id, [target]);
    }
  }

  return [...targetsById].map(([id, targets]) => {
    const target = selectTarget(id, targets);
    return {
      id,
      serverId: target.serverId,
      name: target.plugin.i18n.resolve(target.contribution.name, target.plugin.locale),
      swatch: target.contribution.colors.background,
      theme: buildPluginTheme(target.contribution),
      backdrop: target.contribution.backdrop ? resolveBackdrop(target.contribution, false) : null,
    };
  });
}

export function rememberPluginThemeHost(option: PluginThemeOption): void {
  rememberPluginContributionHost(option.id, option.serverId);
}

export function usePluginThemeCatalog(): PluginThemeOption[] {
  const plugins = useInstalledPlugins();
  return useMemo(() => collectPluginThemes(plugins), [plugins]);
}
