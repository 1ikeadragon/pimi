// These entries are supplied by the host and remain external in author bundles.
export const PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS = [
  "@pimi/plugin/client",
  "@pimi/plugin/client/ui",
] as const;

const PLUGIN_SERVER_ONLY_SDK_SPECIFIERS = [
  "@pimi/plugin/server",
  "@pimi/plugin/server/provider",
  "@pimi/plugin/server/usage",
  "@pimi/plugin/server/acp",
] as const;

const PIMI_SDK_SPECIFIERS = [
  "@pimi/plugin",
  ...PLUGIN_SERVER_ONLY_SDK_SPECIFIERS,
  ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
] as const;

export const PLUGIN_SDK_SPECIFIERS = PIMI_SDK_SPECIFIERS;

export function isPluginClientOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}

export function isPluginServerOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_SERVER_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}
