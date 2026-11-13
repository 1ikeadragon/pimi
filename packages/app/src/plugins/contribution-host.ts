const preferredHosts = new Map<string, string>();

export function getPreferredPluginContributionHost(contributionId: string): string | null {
  return preferredHosts.get(contributionId) ?? null;
}

export function rememberPluginContributionHost(contributionId: string, serverId: string): void {
  preferredHosts.set(contributionId, serverId);
}

/**
 * The host a plugin's screens and sidebar items share: the host last picked on one of its screens
 * or last opened from one of its items.
 */
export function pluginScreensHostKey(pluginId: string): string {
  return `${pluginId}/screens`;
}

/**
 * The host whose installation of a plugin supplies its app-wide UI: component overrides, wrappers,
 * and slot items apply once per plugin id, like themes, whatever number of hosts have it.
 */
export function pluginUiHostKey(pluginId: string): string {
  return `${pluginId}/ui`;
}
