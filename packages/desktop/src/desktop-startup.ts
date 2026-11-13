export interface DesktopStartupDependencies {
  hasPendingGuiLaunchRequest: boolean;
  runCliPassthroughIfRequested: () => Promise<boolean>;
  /** Starts resolving the login-shell environment. The promise never rejects. */
  inheritLoginShellEnv: () => Promise<void>;
  /** Receives the environment promise; it must await it before anything that spawns a child. */
  bootstrapGui: (loginShellEnvReady: Promise<void>) => Promise<void>;
}

export async function runDesktopStartup(deps: DesktopStartupDependencies): Promise<void> {
  if (!deps.hasPendingGuiLaunchRequest && (await deps.runCliPassthroughIfRequested())) {
    return;
  }

  await deps.bootstrapGui(deps.inheritLoginShellEnv());
}
