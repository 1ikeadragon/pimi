const PLAIN_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * An argv as one line with each element's boundary visible: an element with spaces or shell
 * characters is single-quoted, so `["sh", "-c", "echo a; b"]` is not shown as three separate words.
 * Display only; nothing is ever run through a shell.
 */
export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((element) =>
      PLAIN_ARGUMENT.test(element) ? element : `'${element.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}
