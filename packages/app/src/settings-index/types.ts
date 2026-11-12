import type { TFunction } from "i18next";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";

/** The Settings page a field lives on. Host pages need a host to open; app pages do not. */
export type SettingsLocation =
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; section: HostSectionSlug };

/** What a page needs to decide which of its fields exist right now. */
export interface SettingsIndexContext {
  t: TFunction;
  isDesktopApp: boolean;
  hardwareKeyboardPresent: boolean;
}

/** One searchable field, declared by the page that renders it. */
export interface SettingDeclaration {
  /**
   * Unique and dotted, `<page>.<field>`. The row that renders the field passes the same string as
   * `settingId`, which is how a search result finds its row.
   */
  id: string;
  /** The row's visible label. Ranks above keywords. */
  title: string;
  /** Words people use for the field that its label does not contain. */
  keywords: readonly string[];
}

export interface SettingEntry extends SettingDeclaration {
  location: SettingsLocation;
  /** The Settings page title, shown before the field in the palette. */
  pageTitle: string;
  /** A whole page rather than one field: opening it scrolls nowhere and highlights nothing. */
  isPage: boolean;
}

/** A page's declarations. `null` marks a field that does not exist in this runtime. */
export interface SettingsPage {
  location: SettingsLocation;
  declare(ctx: SettingsIndexContext): readonly (SettingDeclaration | null)[];
}
