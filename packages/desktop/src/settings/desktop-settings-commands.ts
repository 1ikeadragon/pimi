import type { DesktopSettingsStore } from "./desktop-settings.js";

// `callerId` is the webContents id of the window that invoked the command.
export type DesktopCommandHandler = (
  args: Record<string, unknown> | undefined,
  callerId: number,
) => unknown;

export function createDesktopSettingsCommandHandlers({
  settingsStore,
}: {
  settingsStore: DesktopSettingsStore;
}): Record<string, DesktopCommandHandler> {
  return {
    get_desktop_settings: () => settingsStore.get(),
    patch_desktop_settings: (args) => settingsStore.patch(args),
  };
}
