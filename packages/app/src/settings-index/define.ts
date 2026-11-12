import type { SettingsLocation, SettingsPage } from "./types";

/**
 * Declare the searchable fields of one Settings page, beside the page's own components.
 * Adding a field is one entry here plus `settingId` on its row; removing one is deleting both.
 */
export function defineSettingsPage(
  location: SettingsLocation,
  declare: SettingsPage["declare"],
): SettingsPage {
  return { location, declare };
}
