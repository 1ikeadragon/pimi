import type { PluginRequirements } from "./messages.js";
import parse from "semver/functions/parse.js";
import validRange from "semver/ranges/valid.js";
import satisfies from "semver/functions/satisfies.js";

export function validatePluginRequirements(requirements: PluginRequirements | undefined): void {
  const range = requirements?.pimi;
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
  const range = input.requirements?.pimi;
  if (range === undefined) {
    throw new Error(
      `Plugin "${input.id}" does not declare a Pimi version range. Ask the plugin author to add a requirements.pimi version range to its manifest.`,
    );
  }
  const version = input.version ? parse(input.version) : null;
  if (!version) {
    throw new Error(
      `Cannot check plugin "${input.id}" requirements: Pimi ${input.runtime} version is unknown. Update the ${input.runtime}.`,
    );
  }
  const stableCore = `${version.major}.${version.minor}.${version.patch}`;
  if (satisfies(version, range) || satisfies(stableCore, range)) return;
  throw new Error(
    `Plugin "${input.id}" requires Pimi ${range}. Your ${input.runtime} is ${input.version}. Use a compatible plugin version or update the ${input.runtime}.`,
  );
}
