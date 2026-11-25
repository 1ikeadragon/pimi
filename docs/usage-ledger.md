# Usage ledger and limits

Usage has two halves that share a screen and nothing else.

- **Limits** (the cards): usage-source plugins ask a vendor how much quota is left. The daemon registry caches each report for five minutes. See [plugins.md](plugins.md#usage-sources).
- **Ledger** (the Overview tab): `packages/server/src/server/usage/scanner.ts` reads provider transcripts and stores one row per request in `pimi.db`. Claude, Codex and OpenCode are read; each file has a byte-offset cursor, so a rescan reads only what was appended.

## What the scanner reads

Each scan covers the daemon's own `~/.claude` and `~/.codex` plus the `CLAUDE_CONFIG_DIR` or `CODEX_HOME` of every provider the daemon launches with (`launchConfigDirs` in `provider-config-dirs.ts`), de-duplicated by real path. A daemon launched from Finder or a launcher does not see variables exported in your shell, so a login that exists only as a shell `export` is not scanned. Register it as a provider profile, or put it in a `~/.claude-*` or `~/.codex-*` directory, which the daemon detects.

Rows of a transcript that has since been deleted stay in the ledger. A migration that drops Codex rows (step 6 in `db/pimi-db.ts`) cannot bring those back.

## Codex forks copy history

A forked Codex rollout begins with a copy of the source's whole `token_count` history, written in one burst. `parsers/codex.ts` absorbs events within `FORK_COPY_MAX_GAP_MS` of the previous one without counting them. The value is a measured heuristic, not a Codex contract: if a Codex build writes the copy slower, or a child's first request lands inside the window, usage is misattributed. The scan report counts every skipped copy (`forkCopiesSuppressed`), so a wrong value shows up as a number. Copied tool calls are still read; they are keyed by call id and carry the fork's timestamp.

## The scan report

`usage.rescan.response`, `usage.get_summary.response` and `usage.get_breakdown.response` carry what the last scan could not read: roots it could not list, the first failed files (the rest are counted), malformed and oversize lines. The Overview prints them next to the numbers. A scan that reads nothing wrong has nothing to print; a missing root is a login you never made, not a problem.

## Limits fallbacks

When a live fetch cannot answer, a plugin may attach a `snapshot` to its failed report: numbers a local record took earlier. The Codex source uses the newest rollout's `rate_limits`. The registry turns it into `lastSuccessful` with an `origin`, and the card prints "Not live. As of <time>, from the <origin>" above the numbers. A snapshot never sets `successfulAt` and never appears on compact surfaces that only read available reports (the sidebar and popover summaries).

Codex's app-server exposes `account/rateLimits/read` and `account/rateLimits/updated`, and Claude Code sends `rate_limit_event` per turn. Neither is wired to the registry: agents have no channel to it, and a Claude event names one window at a time without a guaranteed utilization.

## Known gaps

- Day buckets use the client's UTC offset at request time, so the hours around a daylight-saving change land in the neighbouring day.
- Codex `token_usage_record` events and Claude advisor iterations are not read; no sample exists on the reference machine.
- A Codex login stored in the OS keyring has no `auth.json` and shows no limits card.
