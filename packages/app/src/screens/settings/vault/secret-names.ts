/** `GitHub` and `pat` become `GITHUB_PAT`: upper-case words joined by `_`, never starting with a digit. */
export function envNameFromParts(...parts: string[]): string {
  const joined = parts
    .join(" ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}
