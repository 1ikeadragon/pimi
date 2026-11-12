import type { PluginServerContext } from "@pimi/plugin/server";
import { runAcpProvider } from "@pimi/plugin/server/acp";
import { vendorEditTransformer } from "./server/vendor-edit.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "example-acp",
      label: "Example ACP",
      description: "An ACP command adapted to Pimi's provider boundary",
      icon: "icon.svg",
      command: ["example-acp", "--stdio"],
      transformers: [vendorEditTransformer],
    }),
  );
  return () => {};
}
