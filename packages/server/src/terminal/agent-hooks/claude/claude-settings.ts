import { type AgentHookConfigFormat, buildAgentHookShellCommand } from "../agent-hook-installer.js";

interface ClaudeCommandHook {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

interface ClaudeHookMatcher {
  matcher?: unknown;
  hooks?: unknown;
}

export interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export const claudeSettingsFormat: AgentHookConfigFormat<ClaudeSettings> = {
  empty() {
    return {};
  },
  parse(raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("Hook configuration must be a JSON object");
    return parsed;
  },
  stringify(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
  },
  install(config, provider) {
    const install = provider.install;
    const hooks = normalizeHooks(config.hooks);
    for (const event of provider.events) {
      const userEntries = removePimiHooks(hooks[event.event], install.hookMarker);
      hooks[event.event] = [
        ...userEntries,
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildAgentHookShellCommand(provider, event),
              timeout: 10,
            },
          ],
        },
      ];
    }
    return { ...config, hooks };
  },
  uninstall(config, provider) {
    const install = provider.install;
    const hooks = normalizeHooks(config.hooks);
    for (const event of provider.events) {
      const entries = removePimiHooks(hooks[event.event], install.hookMarker);
      if (entries.length > 0) {
        hooks[event.event] = entries;
      } else {
        delete hooks[event.event];
      }
    }
    return { ...config, hooks };
  },
  installState(config, provider) {
    const hooks = normalizeHooks(config.hooks);
    const entries = provider.events.map((event) => ({
      event,
      commands: normalizeMatchers(hooks[event.event]).flatMap((entry) =>
        normalizeCommandHooks(entry.hooks),
      ),
    }));
    if (
      entries.every(({ event, commands }) =>
        commands.some(
          (hook) =>
            hook.type === "command" && hook.command === buildAgentHookShellCommand(provider, event),
        ),
      )
    ) {
      return "installed";
    }
    const marker = provider.install.hookMarker;
    return entries.some(({ commands }) =>
      commands.some((hook) => commandContainsMarker(hook, marker)),
    )
      ? "partial"
      : "not-installed";
  },
};

function normalizeHooks(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function normalizeMatchers(value: unknown): ClaudeHookMatcher[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function normalizeCommandHooks(value: unknown): ClaudeCommandHook[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function removePimiHooks(value: unknown, marker: string): ClaudeHookMatcher[] {
  const entries: ClaudeHookMatcher[] = [];
  for (const entry of normalizeMatchers(value)) {
    const hooks = normalizeCommandHooks(entry.hooks).filter(
      (hook) => !commandContainsMarker(hook, marker),
    );
    if (hooks.length > 0) {
      entries.push(Object.assign({}, entry, { hooks }));
    }
  }
  return entries;
}

function commandContainsMarker(hook: ClaudeCommandHook, marker: string): boolean {
  return typeof hook.command === "string" && hook.command.includes(marker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
