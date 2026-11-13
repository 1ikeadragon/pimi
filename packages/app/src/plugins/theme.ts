import type { PluginTheme } from "@pimi/plugin";
import type { Theme } from "@/styles/theme";

function numbers(source: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

const cache = new WeakMap<Theme, PluginTheme>();

/**
 * The theme as plugin code reads it: every flat color token plus the numeric ramps. Nested color
 * groups (syntax, palette) are left out; they have no stable meaning outside the app. Cached per
 * theme object, so `withUnistyles` mappings hand back the same value until the theme changes.
 */
export function toPluginTheme(theme: Theme): PluginTheme {
  const cached = cache.get(theme);
  if (cached) return cached;
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    if (typeof value === "string") colors[key] = value;
  }
  const result = Object.freeze({
    colorScheme: theme.colorScheme,
    colors: Object.freeze(colors) as unknown as PluginTheme["colors"],
    spacing: Object.freeze(numbers(theme.spacing)),
    borderRadius: Object.freeze(numbers(theme.borderRadius)),
    fontSize: Object.freeze(numbers(theme.fontSize)),
    fontFamily: Object.freeze({ ui: theme.fontFamily.ui, mono: theme.fontFamily.mono }),
  }) as PluginTheme;
  cache.set(theme, result);
  return result;
}
