// Bundles the self-hosted relay (and `ws`) and the push service into deployable files:
// dist-node/node-relay.mjs and dist-node/push-service.mjs
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  external: ["bufferutil", "utf-8-validate"],
};

await build({ ...shared, entryPoints: ["src/node-relay.ts"], outfile: "dist-node/node-relay.mjs" });
await build({
  ...shared,
  entryPoints: ["src/push-service.ts"],
  outfile: "dist-node/push-service.mjs",
});
