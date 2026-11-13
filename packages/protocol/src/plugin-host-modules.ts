/**
 * Modules the app supplies to plugin client bundles. The daemon compiler leaves them external
 * and the app's bundle loader resolves them, so both read this one list.
 *
 * Not listed on purpose: `react-native-unistyles` (needs its Babel plugin, which plugin bundles
 * bypass) and `@shopify/react-native-skia` (web needs a CanvasKit load step).
 */
export const PLUGIN_CLIENT_THIRD_PARTY_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
  "@tanstack/react-query",
  "react-native-svg",
  "react-native-reanimated",
  "react-native-gesture-handler",
  "react-native-safe-area-context",
] as const;

export const PLUGIN_CLIENT_SDK_MODULES = [
  "@pimi/plugin",
  "@pimi/plugin/client",
  "@pimi/plugin/client/ui",
] as const;

/** Everything a client bundle may import without bundling it. */
export const PLUGIN_CLIENT_HOST_MODULES = [
  ...PLUGIN_CLIENT_SDK_MODULES,
  ...PLUGIN_CLIENT_THIRD_PARTY_MODULES,
] as const;

export type PluginClientHostModule = (typeof PLUGIN_CLIENT_HOST_MODULES)[number];

/** True for a host-provided third-party module or a subpath of one (`react/jsx-runtime`). */
export function isPluginClientThirdPartyModule(specifier: string): boolean {
  return PLUGIN_CLIENT_THIRD_PARTY_MODULES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}
