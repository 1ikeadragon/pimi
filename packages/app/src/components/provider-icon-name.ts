import {
  BUILTIN_PROVIDER_ICON_NAMES,
  KNOWN_PROVIDER_ICON_NAMES,
} from "@pimi/protocol/provider-icon-names";

export type ProviderIconName =
  | { kind: "builtin"; id: string }
  | { kind: "catalog"; id: string }
  | { kind: "svg"; svg: string }
  | { kind: "bot" };

const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDER_ICON_NAMES);
const KNOWN_PROVIDER_IDS = new Set(KNOWN_PROVIDER_ICON_NAMES);
export function resolveProviderIconName(
  provider: string,
  iconSvg?: string,
  baseProvider?: string,
): ProviderIconName {
  if (BUILTIN_PROVIDER_IDS.has(provider)) {
    return { kind: "builtin", id: provider };
  }
  if (iconSvg) {
    return { kind: "svg", svg: iconSvg };
  }
  // A custom provider such as a second Claude login wears the icon of the built-in it extends.
  if (baseProvider && BUILTIN_PROVIDER_IDS.has(baseProvider)) {
    return { kind: "builtin", id: baseProvider };
  }
  if (KNOWN_PROVIDER_IDS.has(provider)) {
    return { kind: "catalog", id: provider };
  }
  return { kind: "bot" };
}
