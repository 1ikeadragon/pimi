// The only production importer of the full Lucide set (see lucideFullSetImporter in
// metro.config.cjs). It sits alone in its directory because Metro caches a module's resolution per
// importing directory, and a sibling that imports "lucide-react-native" would hand this file the
// icons-used-by-the-app barrel instead of the full set.
export function loadLucideFullSet(): Promise<Record<string, unknown>> {
  return import("lucide-react-native") as Promise<Record<string, unknown>>;
}
