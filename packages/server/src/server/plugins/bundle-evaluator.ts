import { createRequire } from "node:module";
import * as pluginSharedRuntime from "@pimi/plugin";
import * as pluginProviderRuntime from "@pimi/plugin/server/provider";
import * as pluginAcpRuntime from "@pimi/plugin/server/acp";
import * as pluginUsageRuntime from "@pimi/plugin/server/usage";
import * as pluginServerRuntime from "@pimi/plugin/server";
import type { PluginServerContribution } from "@pimi/plugin/server";
import * as zod from "zod";
import {
  canonicalPluginSdkSpecifier,
  isPluginClientOnlySdkSpecifier,
} from "./plugin-sdk-specifiers.js";

const nodeRequire = createRequire(import.meta.url);

function runtimeRequire(name: string): unknown {
  name = canonicalPluginSdkSpecifier(name);
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (name === "@pimi/plugin") return pluginSharedRuntime;
  if (name === "@pimi/plugin/server") return pluginServerRuntime;
  if (name === "@pimi/plugin/server/provider") return pluginProviderRuntime;
  if (name === "@pimi/plugin/server/acp") return pluginAcpRuntime;
  if (name === "@pimi/plugin/server/usage") return pluginUsageRuntime;
  if (name === "zod") return zod;
  if (name === "@pimi/plugin/client/host") throw new Error(`${name} is private to the app host`);
  return nodeRequire(name);
}

export function evaluateBundle(bundle: string): PluginServerContribution {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as PluginServerContribution;
}
