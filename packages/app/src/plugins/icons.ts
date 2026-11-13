import { createElement, useSyncExternalStore, type ComponentType, type ReactElement } from "react";
import type { LucideIcon } from "lucide-react-native";
import {
  findSvgIconProblem,
  type PluginIconProps,
  type PluginSerializableIcon,
  type PluginSvgIcon,
} from "@pimi/plugin";
import type { PluginIcon } from "@pimi/plugin/client";
import type { IconProps } from "@pimi/plugin/client/ui";
import { SvgIcon } from "@/components/provider-icons";

/** Host surfaces may thin a Lucide stroke; SVG and plugin components ignore it. */
type HostIconProps = PluginIconProps & { strokeWidth?: number };
/** A host-drawn icon. A plain function, so it stands in for any plugin icon component type. */
type HostIcon = (props: HostIconProps) => ReactElement | null;

const lucideIconComponents = new Map<string, HostIcon>();
const svgIconComponents = new Map<string, HostIcon>();

/**
 * The full Lucide set is an async chunk: plugins name icons as strings, so any of the ~1,900 can be
 * asked for, but the first screen needs none of them. Until it loads, a named icon draws nothing and
 * a registration cannot be checked against the set.
 */
type LucideSet = Record<string, unknown>;
const LUCIDE_NON_ICON_EXPORTS = new Set([
  "Icon",
  "createLucideIcon",
  "LucideProvider",
  "useLucideContext",
]);
let lucideSet: LucideSet | null = null;
let lucideSetLoad: Promise<void> | null = null;
const lucideSetListeners = new Set<() => void>();
const warnedMissingLucideIcons = new Set<string>();

async function importLucideSet(): Promise<void> {
  try {
    lucideSet = (await import("lucide-react-native")) as LucideSet;
  } catch (error) {
    lucideSetLoad = null;
    console.error("[plugin-icons] failed to load the Lucide icon set", error);
    return;
  }
  for (const listener of lucideSetListeners) listener();
}

function loadLucideSet(): void {
  lucideSetLoad ??= importLucideSet();
}

function subscribeToLucideSet(listener: () => void): () => void {
  lucideSetListeners.add(listener);
  return () => lucideSetListeners.delete(listener);
}

function getLucideSet(): LucideSet | null {
  return lucideSet;
}

function findLucideIcon(name: string): LucideIcon | null {
  if (!lucideSet || LUCIDE_NON_ICON_EXPORTS.has(name)) return null;
  const candidate = Reflect.get(lucideSet, name);
  return isComponent(candidate) ? (candidate as LucideIcon) : null;
}

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function isSvgIcon(icon: unknown): icon is PluginSvgIcon {
  return (
    typeof icon === "object" &&
    icon !== null &&
    !("$$typeof" in icon) &&
    typeof Reflect.get(icon, "svg") === "string"
  );
}

function isComponentIcon<Props extends PluginIconProps>(
  icon: PluginIcon<Props>,
): icon is ComponentType<Props> {
  return isComponent(icon);
}

function invalidIcon(owner: string, reason: string): Error {
  return new Error(`${owner} has an invalid icon: ${reason}`);
}

/** Validates an icon that is stored with the data it labels. Returns the normalized icon. */
export function parseSerializablePluginIcon(
  owner: string,
  icon: PluginSerializableIcon,
): PluginSerializableIcon {
  if (typeof icon === "string") {
    const name = icon.trim();
    if (!name) throw new Error(`${owner} has no icon`);
    loadLucideSet();
    // Before the set loads the name cannot be checked; the icon then draws nothing and warns.
    if (lucideSet && !findLucideIcon(name)) {
      throw invalidIcon(owner, `unknown Lucide icon "${name}"`);
    }
    return name;
  }
  if (!isSvgIcon(icon)) throw invalidIcon(owner, "expected a Lucide icon name or { svg }");
  const svg = icon.svg.trim();
  const problem = findSvgIconProblem(svg);
  if (problem) throw invalidIcon(owner, problem);
  return { svg };
}

/** Validates a contribution's icon once, at registration. Rendering trusts the result. */
export function parsePluginIcon<Props extends PluginIconProps>(
  owner: string,
  icon: PluginIcon<Props>,
): PluginIcon<Props> {
  if (isComponentIcon(icon)) return icon;
  if (typeof icon !== "string" && !isSvgIcon(icon)) {
    throw invalidIcon(owner, "expected a Lucide icon name, { svg }, or a component");
  }
  return parseSerializablePluginIcon(owner, icon);
}

function createLucideIcon(name: string): HostIcon {
  function PluginLucideIcon({ size, color, strokeWidth }: HostIconProps) {
    const loaded = useSyncExternalStore(subscribeToLucideSet, getLucideSet);
    if (!loaded) return null;
    const Lucide = findLucideIcon(name);
    if (!Lucide) {
      if (!warnedMissingLucideIcons.has(name)) {
        warnedMissingLucideIcons.add(name);
        console.warn(`[plugin-icons] unknown Lucide icon "${name}"`);
      }
      return null;
    }
    return createElement(Lucide, { size, color, strokeWidth });
  }
  PluginLucideIcon.displayName = `PluginLucideIcon(${name})`;
  return PluginLucideIcon;
}

function lucideIconComponent(name: string): HostIcon {
  const cached = lucideIconComponents.get(name);
  if (cached) return cached;
  loadLucideSet();
  const icon = createLucideIcon(name);
  lucideIconComponents.set(name, icon);
  return icon;
}

function svgIconComponent(svg: string): HostIcon {
  const cached = svgIconComponents.get(svg);
  if (cached) return cached;
  function PluginSvgIcon({ size, color }: PluginIconProps) {
    return createElement(SvgIcon, { svg, size, color });
  }
  svgIconComponents.set(svg, PluginSvgIcon);
  return PluginSvgIcon;
}

/**
 * A stable component for a registered icon, for surfaces that take an icon component. Lucide and
 * SVG icons draw from `size` and `color` only; a plugin component receives every prop.
 */
export function pluginIconComponent<Props extends PluginIconProps>(
  icon: PluginIcon<Props>,
): ComponentType<Props> {
  if (typeof icon === "string") return lucideIconComponent(icon);
  if (isSvgIcon(icon)) return svgIconComponent(icon.svg);
  return icon;
}

export interface PluginIconViewProps extends PluginIconProps {
  icon: PluginIcon;
}

/** Draws a registered plugin icon. `color` tints Lucide icons and `currentColor` in SVG. */
export function PluginIconView({ icon, size, color }: PluginIconViewProps): ReactElement {
  return createElement(pluginIconComponent(icon), { size, color });
}

function isRenderable(icon: PluginIcon): boolean {
  if (typeof icon === "string") {
    loadLucideSet();
    return lucideSet ? findLucideIcon(icon) !== null : true;
  }
  if (isSvgIcon(icon)) return findSvgIconProblem(icon.svg) === null;
  return isComponent(icon);
}

/** The kit `Icon`. Plugin code passes it anything, so an unusable icon renders nothing. */
export function Icon(props: IconProps): ReactElement | null {
  const icon = props.icon === undefined ? props.name : props.icon;
  if (!isRenderable(icon)) return null;
  const size = props.size ?? 24;
  const color = props.color ?? "currentColor";
  return createElement(PluginIconView, { icon, size, color });
}
