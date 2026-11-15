import type { DesktopSettings, DesktopSettingsStore } from "./desktop-settings.js";

// `callerId` is the webContents id of the window that invoked the command.
export type DesktopCommandHandler = (
  args: Record<string, unknown> | undefined,
  callerId: number,
) => unknown;

export function createDesktopSettingsCommandHandlers({
  settingsStore,
  onSettingsChanged,
}: {
  settingsStore: DesktopSettingsStore;
  onSettingsChanged: (settings: DesktopSettings) => void;
}): Record<string, DesktopCommandHandler> {
  return {
    get_desktop_settings: () => settingsStore.get(),
    patch_desktop_settings: async (args) => {
      const settings = await settingsStore.patch(args);
      onSettingsChanged(settings);
      return settings;
    },
  };
}
