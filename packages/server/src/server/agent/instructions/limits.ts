/**
 * Limits for instruction discovery. Each constant says whether it mirrors a provider rule or is
 * a guard Pimi chose. A guard that trips sets `truncated` on the result, so nothing is dropped
 * silently.
 */

// ---
// Pimi-chosen limits

/**
 * The most bytes of one file the view returns. Chosen, not derived: twice Codex's 32 KiB default
 * project-doc budget, so a file at that budget previews whole while a runaway file cannot fill a
 * response. A cut preview sets `previewTruncated`.
 */
export const INSTRUCTION_PREVIEW_MAX_BYTES = 64 * 1024;

/**
 * The most parent directories one walk visits. Chosen: no real repository nests this deep, and a
 * symlink loop through `..` would otherwise never end.
 */
export const MAX_ANCESTOR_DIRECTORIES = 64;

/** The most layers one result lists. Chosen: bounds a `.claude/rules` tree with thousands of files. */
export const MAX_INSTRUCTION_LAYERS = 200;

/**
 * Wall-clock budget for one discovery. Chosen: a stalled network mount must not hold the
 * request, and a person waiting on a sheet gives up before this.
 */
export const INSTRUCTION_DISCOVERY_TIMEOUT_MS = 5_000;

// ---
// Provider limits

/** Claude Code skips a memory file larger than this (code.claude.com/docs/en/memory). */
export const CLAUDE_INSTRUCTION_FILE_MAX_BYTES = 4 * 1024 * 1024;

/** How many `@path` import hops Claude Code follows from a memory file (docs: memory, Imports). */
export const CLAUDE_IMPORT_MAX_HOPS = 4;

/** Auto memory: Claude loads the first 200 lines or 25 KB of MEMORY.md, whichever comes first. */
export const CLAUDE_AUTO_MEMORY_MAX_LINES = 200;
export const CLAUDE_AUTO_MEMORY_MAX_BYTES = 25 * 1024;

/** Codex `project_doc_max_bytes` when config.toml leaves it unset (codex-rs project_doc.rs). */
export const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;

/**
 * The largest file the resolvers read to learn a setting (settings.json, config.toml,
 * opencode.json). Chosen: real config files are a few KB.
 */
export const INSTRUCTION_CONFIG_FILE_MAX_BYTES = 1024 * 1024;
