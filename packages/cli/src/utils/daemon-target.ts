import { parseHostTarget } from "@pimi/protocol/host-target";
import { resolvePaseoHome } from "@pimi/server/daemon-control";

export type DaemonTarget = { kind: "instance"; home: string } | { kind: "endpoint"; host: string };

export function selectDaemonTarget(
  options: { home?: string; host?: string },
  env: NodeJS.ProcessEnv = process.env,
  localOnly = false,
): DaemonTarget {
  for (const key of ["home", "host"] as const) {
    if (options[key] !== undefined && !options[key]!.trim())
      throw { code: "TARGET_INVALID", message: `--${key} requires a non-empty value.` };
  }
  if (options.home !== undefined && options.host !== undefined)
    throw { code: "TARGET_AMBIGUOUS", message: "Choose either --home or --host, not both." };
  const configuredHome = env.PIMI_HOME ?? env.PASEO_HOME;
  const configuredHost = env.PIMI_HOST ?? env.PASEO_HOST;
  if (localOnly) {
    if (options.host !== undefined)
      throw {
        code: "LOCAL_OPERATION",
        message: "This is a local operation; use --home. --host is not supported.",
      };
    return {
      kind: "instance",
      home: resolvePaseoHome({ PIMI_HOME: options.home ?? configuredHome }),
    };
  }
  if (options.home !== undefined)
    return { kind: "instance", home: resolvePaseoHome({ PIMI_HOME: options.home }) };
  if (options.host !== undefined) return { kind: "endpoint", host: options.host };
  if (configuredHome && configuredHost)
    throw {
      code: "TARGET_AMBIGUOUS",
      message: "Both a daemon home and host are set. Choose --home or --host explicitly.",
    };
  if (configuredHost) return { kind: "endpoint", host: configuredHost };
  return { kind: "instance", home: resolvePaseoHome({ PIMI_HOME: configuredHome }) };
}

export function describeDaemonTarget(target: DaemonTarget): string {
  if (target.kind === "instance") return `home ${target.home}`;
  try {
    const input = target.host.trim();
    const parsed = parseHostTarget(input);
    // Discovery descriptions are display text; command hints must preserve the address syntax.
    if (parsed.kind === "ssh" || (!parsed.offer && !parsed.socketPath && input.includes("://"))) {
      const url = new URL(input);
      if (decodeURIComponent(url.username).includes(":")) url.username = "REDACTED";
      for (const key of new Set(url.searchParams.keys())) {
        const routingOption =
          (parsed.kind === "ssh" && key === "daemonPort") ||
          (key === "ssl" &&
            url.searchParams.getAll(key).every((value) => value === "true" || value === "false"));
        if (!routingOption) url.searchParams.set(key, "REDACTED");
      }
      return url.toString();
    }
    // Pairing offers must always use safe display text, including prefix-free fragments.
    return parsed.kind === "socket" && !parsed.offer && !input.includes("://")
      ? input
      : parsed.description;
  } catch {
    return "<invalid endpoint>";
  }
}
