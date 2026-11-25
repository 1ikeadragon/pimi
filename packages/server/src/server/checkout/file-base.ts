import { isAbsolute } from "node:path";
import type { CheckoutFileBaseStatus } from "@pimi/protocol/messages";
import { MAX_EDITABLE_FILE_BYTES } from "../file-explorer/service.js";
import { runGitCommand } from "../../utils/run-git-command.js";

export interface FileBase {
  status: CheckoutFileBaseStatus;
  /** Set only for `text`. */
  content: string | null;
}

// `git cat-file` exits 128 for an object it cannot resolve: a path absent from HEAD, or a
// repository with no commits. Both mean the file has no base.
const GIT_FATAL_EXIT_CODE = 128;

/**
 * A file's content at HEAD, for the editor to diff its buffer against. The size cap is the
 * editor's own: a file the editor refuses to open has no use for a base.
 */
export async function readFileBase(input: { cwd: string; path: string }): Promise<FileBase> {
  const { cwd, path } = input;
  if (path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid path: ${path}`);
  }
  // `./` makes Git resolve the path against cwd, which may be a subdirectory of the repository.
  const spec = `HEAD:./${path}`;
  const options = { cwd, envOverlay: { GIT_OPTIONAL_LOCKS: "0" } };
  const size = await runGitCommand(["cat-file", "-s", spec], {
    ...options,
    acceptExitCodes: [0, GIT_FATAL_EXIT_CODE],
  });
  if (size.exitCode === GIT_FATAL_EXIT_CODE) {
    // The same exit code covers a directory that is not a repository, which has no base to offer.
    if (/not a git repository/i.test(size.stderr)) throw new Error(size.stderr.trim());
    return { status: "missing", content: null };
  }
  if (Number(size.stdout.trim()) > MAX_EDITABLE_FILE_BYTES) {
    return { status: "too_large", content: null };
  }
  const blob = await runGitCommand(["cat-file", "blob", spec], {
    ...options,
    maxOutputBytes: MAX_EDITABLE_FILE_BYTES,
  });
  // A gitlink (submodule) is not a blob; `cat-file blob` fails and the error reaches the caller.
  if (blob.stdout.includes("\0")) return { status: "binary", content: null };
  return { status: "text", content: blob.stdout };
}
