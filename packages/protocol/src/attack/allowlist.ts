// The hosts an Attack run's agents may navigate their browser tabs to: localhost on any port plus
// at most one remote host the user named. The desktop webview guard, the daemon browser tools and
// the run's own start validation all decide through these functions.

const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/** Lowercased hostname with IPv6 brackets and a trailing dot removed, or null when it is not one. */
export function normalizeAttackHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || /[\s/?#@]/.test(trimmed)) return null;
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const host = unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
  return host.length > 0 ? host : null;
}

export function isLocalAttackHost(host: string): boolean {
  const normalized = normalizeAttackHost(host);
  return normalized !== null && LOCAL_HOSTS.includes(normalized);
}

/** The hostname of an http(s) URL, or null for anything else. */
export function attackUrlHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return normalizeAttackHost(parsed.hostname);
  } catch {
    return null;
  }
}

/** Localhost plus the run's one remote host. */
export function attackAllowedHosts(remoteHost: string | null): string[] {
  return remoteHost ? [...LOCAL_HOSTS, remoteHost] : [...LOCAL_HOSTS];
}

export function isAttackHostAllowed(host: string | null, allowedHosts: readonly string[]): boolean {
  if (!host) return false;
  const normalized = normalizeAttackHost(host);
  return normalized !== null && allowedHosts.includes(normalized);
}

export function isAttackUrlAllowed(url: string, allowedHosts: readonly string[]): boolean {
  return isAttackHostAllowed(attackUrlHost(url), allowedHosts);
}
