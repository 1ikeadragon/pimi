/**
 * Which facts a sidebar workspace row is allowed to show about a workspace.
 *
 * Each item is independent — this is not a mode. Turning one off removes it from every row and
 * gives the space back to the title.
 *
 * CI is not here: it has three answers rather than two, so it is its own setting in
 * `checks-display.ts`.
 *
 * Pure on purpose: `hooks/use-settings/storage.ts` validates the persisted value through
 * `parseSidebarRowItems` rather than growing its own checks, so this module stays the one place
 * that knows what an item is.
 */

export const SIDEBAR_ROW_ITEMS = [
  "branch",
  "project",
  "host",
  "changeRequest",
  "services",
  "labels",
] as const;

export type SidebarRowItem = (typeof SIDEBAR_ROW_ITEMS)[number];

export type SidebarRowItems = Record<SidebarRowItem, boolean>;

/** The persisted record is merged over these explicit product defaults. */
export const DEFAULT_SIDEBAR_ROW_ITEMS: SidebarRowItems = {
  branch: true,
  project: false,
  host: true,
  changeRequest: true,
  services: true,
  labels: true,
};

function isSidebarRowItem(value: string): value is SidebarRowItem {
  return (SIDEBAR_ROW_ITEMS as readonly string[]).includes(value);
}

export function parseSidebarRowItems(value: unknown): SidebarRowItems {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_SIDEBAR_ROW_ITEMS;
  }

  const stored = value as Record<string, unknown>;
  const result = { ...DEFAULT_SIDEBAR_ROW_ITEMS };
  for (const [key, entry] of Object.entries(stored)) {
    if (isSidebarRowItem(key) && typeof entry === "boolean") {
      result[key] = entry;
    }
  }
  return result;
}
