import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";
import type { LanguageServerOverride } from "./types.js";

/**
 * Language servers the editor can use when one is already installed. Nothing is downloaded: a
 * language whose servers are all missing keeps name matching and a disabled Rename that says what
 * to install. Candidates are tried in order.
 */
export interface LspServerSpec {
  /** Name shown to the user. */
  name: string;
  command: string;
  args: string[];
  /** Must print this prefix for `--version`; guards against a rustup shim with no component. */
  versionPrefix?: string;
}

export interface LspLanguage {
  id: string;
  /** The LSP `languageId` sent in didOpen. */
  languageId: string;
  extensions: string[];
  servers: LspServerSpec[];
  installHint: string;
}

export const LSP_LANGUAGES: LspLanguage[] = [
  {
    id: "rust",
    languageId: "rust",
    extensions: ["rs"],
    servers: [
      { name: "rust-analyzer", command: "rust-analyzer", args: [], versionPrefix: "rust-analyzer" },
    ],
    installHint: "rustup component add rust-analyzer",
  },
  {
    id: "python",
    languageId: "python",
    extensions: ["py", "pyi"],
    servers: [
      { name: "basedpyright", command: "basedpyright-langserver", args: ["--stdio"] },
      { name: "Pyright", command: "pyright-langserver", args: ["--stdio"] },
      { name: "python-lsp-server", command: "pylsp", args: [] },
    ],
    installHint: "npm install -g basedpyright (or pyright, or pip install python-lsp-server)",
  },
  {
    id: "php",
    languageId: "php",
    extensions: ["php"],
    servers: [
      { name: "Intelephense", command: "intelephense", args: ["--stdio"] },
      { name: "Phpactor", command: "phpactor", args: ["language-server"] },
    ],
    installHint: "npm install -g intelephense (or install phpactor)",
  },
  {
    id: "go",
    languageId: "go",
    extensions: ["go"],
    servers: [{ name: "gopls", command: "gopls", args: [] }],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
];

export function lspLanguageForPath(path: string): LspLanguage | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const extension = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return LSP_LANGUAGES.find((language) => language.extensions.includes(extension)) ?? null;
}

export function renameHint(language: LspLanguage): string {
  const names = language.servers.map((server) => server.name);
  const subject =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Rename needs ${subject}. Install it with: ${language.installHint}`;
}

// Servers installed by the usual toolchain installers land outside the PATH a GUI-launched
// daemon inherits, so those two directories are searched as well.
function searchPath(): string {
  const home = homedir();
  return [process.env.PATH ?? "", join(home, ".cargo", "bin"), join(home, "go", "bin")]
    .filter(Boolean)
    .join(delimiter);
}

export interface LspLaunchSpec {
  /** Name shown as the answering provider. */
  name: string;
  executable: string;
  args: string[];
  source: "auto" | "custom";
}

const CACHE_MS = 60_000;
const resolved = new Map<string, { at: number; value: LspLaunchSpec | null }>();

async function verified(spec: LspServerSpec, executable: string): Promise<boolean> {
  if (!spec.versionPrefix) return true;
  try {
    const { stdout } = await execCommand(executable, ["--version"], {
      envOverlay: { PATH: searchPath() },
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    return stdout.trim().startsWith(spec.versionPrefix);
  } catch {
    return false;
  }
}

/** The first installed server for the language, or null. A negative answer is cached briefly. */
export async function detectLspServer(language: LspLanguage): Promise<LspLaunchSpec | null> {
  const cached = resolved.get(language.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value: LspLaunchSpec | null = null;
  for (const spec of language.servers) {
    const executable = await findExecutable(spec.command, {
      env: { ...process.env, PATH: searchPath() },
    });
    if (executable && (await verified(spec, executable))) {
      value = { name: spec.name, executable, args: spec.args, source: "auto" };
      break;
    }
  }
  resolved.set(language.id, { at: Date.now(), value });
  return value;
}

/** The server to launch: the user's choice when there is one, else the first one detected. */
export async function resolveLspLaunch(
  language: LspLanguage,
  overrides: LanguageServerOverride[] | undefined,
): Promise<LspLaunchSpec | null> {
  const custom = overrides?.find((entry) => entry.language === language.id);
  if (custom) {
    return {
      name: basename(custom.command),
      executable: custom.command,
      args: custom.args,
      source: "custom",
    };
  }
  return detectLspServer(language);
}

/** Forgets detection results, after the user changes a server setting. */
export function clearLspDetectionCache(): void {
  resolved.clear();
}
