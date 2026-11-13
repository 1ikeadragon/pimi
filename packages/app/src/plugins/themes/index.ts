import type { PluginMessage } from "@pimi/plugin/client";
import { isPluginMessage } from "@pimi/plugin/client/host";
import { useMemo } from "react";
import { z } from "zod";
import type { PluginThemeContribution } from "../types";
import {
  buildDarkSemanticColors,
  buildDarkTheme,
  buildLightSemanticColors,
  buildLightTheme,
  darkTheme,
  lightTheme,
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
});

export interface PluginThemeOption {
  id: string;
  serverId: string;
  name: string;
  swatch: string;
  theme: Theme;
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
  return contribution;
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

function buildDarkPluginTheme(contribution: PluginThemeContribution): Theme {
  const colors = contribution.colors;
  const accent = colors.accent ?? colors.foreground;
  return buildDarkTheme(
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
  );
}

function buildLightPluginTheme(contribution: PluginThemeContribution): Theme {
  const colors = contribution.colors;
  const accent = colors.accent ?? colors.foreground;
  return buildLightTheme(
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
