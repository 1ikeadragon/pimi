# @pimi/client

TypeScript SDK for building integrations on top of a Pimi daemon.

```bash
npm ci
npm run setup
npm run build:client
```

```ts
import { createPimiClient } from "@pimi/client";

const client = createPimiClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

The public API is the package root. Imports under `@pimi/client/internal/*` are unsupported implementation details used by Pimi's own packages.

Read the [SDK documentation](https://github.com/1ikeadragon/pimi-releases/tree/main/docs/sdk) for agents, workspaces, terminals, provider discovery, events, recipes, and the API reference. Runnable TypeScript patterns also live in [`examples/`](./examples/README.md).

## Runtime

The client needs a WebSocket implementation. Modern browsers and Node.js 22 provide one globally.

Use a WebSocket URL ending in `/ws`, such as `ws://127.0.0.1:6767/ws`. Pass `password` when the daemon requires authentication.

The client advertises its supported protocol capabilities by default. Optional `capabilities`
overrides extend or override that declaration; browser hosting must be supplied by the caller.
Connecting alone does not subscribe to agent timelines or catalog events. See the
[event guide](https://github.com/1ikeadragon/pimi-releases/tree/main/docs/sdk/events) for subscription lifetimes and timeline replacements.

## Stability

The high-level API exported from `@pimi/client` is the supported SDK surface. The SDK and daemon remain protocol-compatible across versions, but newly added capabilities can require a newer daemon.
