import {
  ProviderOverrideSchema,
  ProviderOverridesSchema,
  type ProviderOverride,
} from "@pimi/protocol/provider-config";

const advancedSchema = ProviderOverrideSchema.omit({
  extends: true,
  label: true,
  command: true,
  env: true,
}).strict();
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PROVIDER_CONFIG_DIRECTORIES: Readonly<Record<string, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
};

export function defaultProviderId(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "");
}

export function customProviderFields(provider?: ProviderOverride) {
  const options = { ...provider?.options };
  const flags = provider?.extends === "claude" ? options.extraArgs : undefined;
  let args = provider?.command?.slice(1).join("\n") ?? "";
  if (flags && typeof flags === "object" && !Array.isArray(flags)) {
    args = Object.entries(flags)
      .flatMap(([key, value]) => {
        if (value === null) return [`--${key}`];
        return typeof value === "string" ? [`--${key}=${value}`] : [];
      })
      .join("\n");
    delete options.extraArgs;
  }
  const advanced = advancedSchema.safeParse(
    Object.fromEntries(
      Object.entries({ ...provider, options: provider?.options && options }).filter(([key]) =>
        Object.hasOwn(advancedSchema.shape, key),
      ),
    ),
  );
  return {
    binary: provider?.command?.[0] ?? "",
    args,
    advanced: advanced.success ? JSON.stringify(advanced.data, null, 2) : "{}",
  };
}

function claudeExtraArgs(args: string[]) {
  const flags: [string, string | null][] = [];
  for (let index = 0; index < args.length; index += 1) {
    const match = /^--([a-z][\w-]*)(?:=(.*))?$/i.exec(args[index]);
    if (!match) throw new Error("Use --flag or --flag=value for Claude launch arguments.");
    const following = args[index + 1];
    let value = match[2] ?? null;
    if (value === null && following && !following.startsWith("--")) {
      value = following;
      index += 1;
    }
    flags.push([match[1], value]);
  }
  return Object.fromEntries(flags);
}

function providerEnvironment(
  environment: readonly { name: string; value: string }[],
  configKey: string | undefined,
  directory: string,
) {
  const entries = environment.map(({ name, value }) => [name.trim(), value] as const);
  if (entries.some(([name]) => !envName.test(name))) {
    throw new Error("Enter a valid name for each environment variable.");
  }
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new Error("Each environment variable needs a unique name.");
  }
  const env = Object.fromEntries(entries);
  if (configKey && directory.trim()) {
    if (Object.hasOwn(env, configKey))
      throw new Error(`Set ${configKey} in Config directory or Environment.`);
    env[configKey] = directory.trim();
  }
  return env;
}

export function buildCustomProvider(input: {
  id: string;
  label: string;
  harness: string;
  binary: string;
  args: string;
  advanced: string;
  configDirectory: string;
  environment: readonly { name: string; value: string }[];
}) {
  let raw: unknown;
  try {
    raw = JSON.parse(input.advanced.trim() || "{}");
  } catch {
    throw new Error("Enter valid JSON in Advanced settings.");
  }
  const advanced = advancedSchema.safeParse(raw);
  if (!advanced.success) throw new Error("Check the fields in Advanced settings.");
  const env = providerEnvironment(
    input.environment,
    PROVIDER_CONFIG_DIRECTORIES[input.harness],
    input.configDirectory,
  );
  const args = input.args.split(/\r?\n/).filter((arg) => arg.trim());
  const binary = input.binary.trim();
  if (!binary && input.harness === "acp") {
    throw new Error("Enter the binary name or path.");
  }
  let options = advanced.data.options;
  if (input.harness === "claude" && args.length) {
    options = { ...options, extraArgs: claudeExtraArgs(args) };
  }
  const launchArgs = input.harness === "claude" ? [] : args;
  const command =
    binary || launchArgs.length ? [binary || input.harness, ...launchArgs] : undefined;
  const parsed = ProviderOverridesSchema.safeParse({
    [input.id]: {
      ...advanced.data,
      label: input.label,
      extends: input.harness,
      command,
      env,
      ...(options && { options }),
    },
  });
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "Check the provider settings.");
  return parsed.data[input.id];
}
