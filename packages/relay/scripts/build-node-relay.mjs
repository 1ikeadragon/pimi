// Bundles the self-hosted relay (and `ws`) into one deployable file: dist-node/node-relay.mjs
import { build } from "esbuild";

await build({
  entryPoints: ["src/node-relay.ts"],
  outfile: "dist-node/node-relay.mjs",
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
});
