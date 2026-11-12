// Daemon configuration inputs. General provider credentials and executable/runtime
// controls remain available to managed launches and their agent processes.
export const DAEMON_SETTING_ENV_KEYS = [
  "MCP_DEBUG",
  "OPENAI_STT_BASE_URL",
  "OPENAI_TTS_BASE_URL",
  "PIMI_ALLOWED_HOSTS",
  "PIMI_APP_BASE_URL",
  "PIMI_CORS_ORIGINS",
  "PIMI_DICTATION_ENABLED",
  "PIMI_DICTATION_LANGUAGE",
  "PIMI_DICTATION_LOCAL_STT_MODEL",
  "PIMI_DICTATION_STT_PROVIDER",
  "PIMI_GIT_MAX_PROCESSES_PER_SECOND",
  "PIMI_GIT_MAX_PROCESS_CONCURRENCY",
  "PIMI_HOSTNAMES",
  "PIMI_LISTEN",
  "PIMI_LOCAL_MODELS_DIR",
  "PIMI_LOG",
  "PIMI_LOG_CONSOLE_FORMAT",
  "PIMI_LOG_CONSOLE_LEVEL",
  "PIMI_LOG_FILE_LEVEL",
  "PIMI_LOG_FILE_PATH",
  "PIMI_LOG_FILE_ROTATE_COUNT",
  "PIMI_LOG_FILE_ROTATE_SIZE",
  "PIMI_LOG_FORMAT",
  "PIMI_LOG_LEVEL",
  "PIMI_LOG_ROTATE_COUNT",
  "PIMI_LOG_ROTATE_SIZE",
  "PIMI_PASSWORD",
  "PIMI_PLUGIN_REGISTRY",
  "PIMI_RELAY_ENABLED",
  "PIMI_RELAY_ENDPOINT",
  "PIMI_RELAY_PUBLIC_ENDPOINT",
  "PIMI_RELAY_PUBLIC_USE_TLS",
  "PIMI_RELAY_USE_TLS",
  "PIMI_SERVICE_PROXY_ENABLED",
  "PIMI_SERVICE_PROXY_LISTEN",
  "PIMI_SERVICE_PROXY_PUBLIC_BASE_URL",
  "PIMI_TRUSTED_PROXIES",
  "PIMI_VOICE_LANGUAGE",
  "PIMI_VOICE_LLM_PROVIDER",
  "PIMI_VOICE_LOCAL_STT_MODEL",
  "PIMI_VOICE_LOCAL_TTS_MODEL",
  "PIMI_VOICE_LOCAL_TTS_SPEAKER_ID",
  "PIMI_VOICE_LOCAL_TTS_SPEED",
  "PIMI_VOICE_MODE_ENABLED",
  "PIMI_VOICE_STT_PROVIDER",
  "PIMI_VOICE_TTS_PROVIDER",
  "PIMI_VOICE_TURN_DETECTION_PROVIDER",
  "PORT",
  "STT_CONFIDENCE_THRESHOLD",
  "STT_MODEL",
  "TTS_MODEL",
  "TTS_VOICE",
] as const;

const CONFIG_CONTEXT_ENV_KEYS = [
  "PIMI_NODE_ENV",
  "PIMI_DESKTOP_MANAGED",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_STT_API_KEY",
  "OPENAI_TTS_API_KEY",
] as const;

export function configurationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const config = Object.fromEntries(
    [...DAEMON_SETTING_ENV_KEYS, ...CONFIG_CONTEXT_ENV_KEYS].map((key) => [key, env[key]]),
  );
  return config;
}

export function daemonLaunchEnvironment(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  mode: "managed" | "deployment";
  desktopManaged?: boolean;
}): NodeJS.ProcessEnv {
  const env = { ...input.env };
  if (input.mode === "managed") {
    for (const key of DAEMON_SETTING_ENV_KEYS) delete env[key];
  }
  delete env.PIMI_HOST;
  delete env.PIMI_DESKTOP_MANAGED;
  env.PIMI_HOME = input.home;
  if (input.desktopManaged) env.PIMI_DESKTOP_MANAGED = "1";
  return env;
}
