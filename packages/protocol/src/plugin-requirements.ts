import type { PluginRequirements } from "./messages.js";
import parse from "semver/functions/parse.js";
import validRange from "semver/ranges/valid.js";
import satisfies from "semver/functions/satisfies.js";

export function validatePluginRequirements(requirements: PluginRequirements | undefined): void {
  const range = requirements?.pimi ?? requirements?.paseo;
  if (range !== undefined && (!range.trim() || validRange(range) === null)) {
    throw new Error(
      `Invalid plugin version requirement: ${JSON.stringify(range)}. Use a semver range such as ">=0.8.0".`,
    );
  }
}

interface PluginCompatibilityInput {
  id: string;
  requirements?: PluginRequirements;
  version: string | null;
  runtime: "daemon" | "app";
}

export function assertPluginCompatibility(input: PluginCompatibilityInput): void {
  validatePluginRequirements(input.requirements);
  // COMPAT(plugin-requirements): added in v0.8.0-beta.1; remove after 2027-03-07 once pre-0.8 plugins and catalogs are unsupported. The legacy range excludes 0.8 prereleases and their stable core.
  const declaredRange = input.requirements?.pimi ?? input.requirements?.paseo;
  const range = declaredRange ?? "<0.8.0";
  const version = input.version ? parse(input.version) : null;
  if (!version) {
    throw new Error(
      `Cannot check plugin "${input.id}" requirements: Pimi ${input.runtime} version is unknown. Update the ${input.runtime}.`,
    );
  }
  const stableCore = `${version.major}.${version.minor}.${version.patch}`;
  if (satisfies(version, range) || satisfies(stableCore, range)) return;
  const action =
    declaredRange === undefined
      ? "Ask the plugin author to add a requirements.pimi version range to its manifest."
      : `Use a compatible plugin version or update the ${input.runtime}.`;
  throw new Error(
    `Plugin "${input.id}" requires Pimi ${range}. Your ${input.runtime} is ${input.version}. ${action}`,
  );
}
