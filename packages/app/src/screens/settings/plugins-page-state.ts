export type PluginPageState = "offline" | "loading" | "error" | "empty" | "ready";

export function resolvePluginPageState(input: {
  connected: boolean;
  loading: boolean;
  error: boolean;
  pluginCount: number;
}): PluginPageState {
  if (!input.connected) return "offline";
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.pluginCount === 0 ? "empty" : "ready";
}
