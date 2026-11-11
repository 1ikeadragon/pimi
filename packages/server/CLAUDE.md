# AGENTS.md — Pimi Server Development Guide

For AI coding agents working in `packages/server`. Supplements [CLAUDE.md](../CLAUDE.md) at the repo root.

## Project Overview

Pimi is a desktop workspace for monitoring and controlling local AI coding agents (Claude Code, Codex, GitHub Copilot, OpenCode, Pi). The daemon runs on your machine, manages agent processes, and streams their output over WebSocket to clients.

---

## Build / Lint Commands

### Root (monorepo)

```bash
npm run dev                          # Start daemon + Expo in Tmux
npm run build:server                 # Build: highlight + relay + protocol + client + server + cli
npm run typecheck                    # Typecheck all packages
npm run format                       # Format with Biome (in-place)
```

### Server package (`packages/server`)

```bash
npm run dev                          # Start dev daemon (tsx watch)
npm run build                        # Build lib + scripts to dist/
npm run start                        # Run production daemon from dist/
npm run typecheck                    # Typecheck server source
```

### Other useful commands

```bash
npm run build:server                         # Rebuild server stack
npm run db:query -- "SELECT ..."             # Run arbitrary SQL
npm run cli -- ls -a -g                      # List agents
npm run cli -- daemon status                 # Check daemon status
```

---

## Code Style

### Biome (formatting only, no linting)

```json
{
  "indentStyle": "space",
  "indentWidth": 2,
  "lineWidth": 100,
  "quoteStyle": "double",
  "trailingCommas": "all",
  "semicolons": "always"
}
```

### TypeScript

- **Fully strict** — no `any`, no implicit `any`
- **`interface`** over `type`\*\* when possible
- **`function` declarations** over arrow function assignments
- **Named types** — no complex inline types in public signatures
- **Object parameters** — use single object param when >1 argument
- **Infer from Zod schemas** — `z.infer<typeof schema>` instead of hand-written types
- `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`

### Imports

- Use relative `.js` paths for imports within shipped server code, including type imports. TypeScript preserves `@server/*` aliases in JavaScript and declarations, and production Node has no alias resolver.
- No barrel `index.ts` re-exports — they create unnecessary indirection

### Naming

- Files: `kebab-case.ts` named after the main export (`create-tool-call.ts`)
- No prefixes like `RpcX`, `DbX`, `UiX` — keep one canonical type per concept

### Error Handling

- **Fail explicitly** — throw instead of silently returning defaults
- **Typed domain errors** — extend `Error` with structured metadata

```typescript
class TimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly waitedMs: number,
  ) {
    super(`${operation} timed out after ${waitedMs}ms`);
    this.name = "TimeoutError";
  }
}
```

### State Design

Discriminated unions over bags of booleans/optionals:

```typescript
// Bad
interface FetchState {
  isLoading: boolean;
  error?: Error;
  data?: Data;
}

// Good
type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "success"; data: Data };
```

---

## Verification

There is no automated test suite and you do not write unit tests. Verify in the real app: [../docs/testing.md](../docs/testing.md).

---

## Critical Rules

1. **NEVER restart the daemon on port 6767** — it kills your own process
2. **NEVER assume timeouts need a restart** — they can be transient
3. **Always run `npm run typecheck` after changes**
4. **No backward compatibility for WebSocket/message schemas.** The app, CLI, and daemon ship together; change every side in one commit. See [../docs/protocol-compatibility.md](../docs/protocol-compatibility.md).

---

## Architecture Quick Reference

```
packages/server/src/
├── server/
│   ├── index.ts              # Entry point
│   ├── bootstrap.ts           # Daemon initialization
│   ├── websocket-server.ts   # WS connection management
│   ├── session.ts             # Per-client session state
│   └── agent/
│       ├── agent-manager.ts  # Agent lifecycle state machine
│       └── agent-storage.ts  # File-backed JSON persistence
├── providers/                 # Claude, Codex, Copilot, OpenCode, Pi adapters
├── relay-transport.ts        # Outbound relay connection
```

Agent state persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`  
Daemon logs: `$PASEO_HOME/daemon.log`

---

## Debugging

```bash
tail -f $PASEO_HOME/daemon.log      # Daemon logs
npm run cli -- inspect <agent-id>   # Detailed agent info
npm run db:query -- "SELECT * FROM agent_timeline_rows..."
```

---

## Relevant Docs

| File                                                       | What it covers                                   |
| ---------------------------------------------------------- | ------------------------------------------------ |
| [../CLAUDE.md](../CLAUDE.md)                               | Repository overview, critical rules, quick start |
| [../docs/architecture.md](../docs/architecture.md)         | System design, WebSocket protocol, data flow     |
| [../docs/coding-standards.md](../docs/coding-standards.md) | Type hygiene, error handling, React patterns     |
| [../docs/testing.md](../docs/testing.md)                   | Verifying in the real app, no unit tests         |
| [../SECURITY.md](../SECURITY.md)                           | Relay threat model, E2E encryption               |
