import type { EditorTarget, EditorTargetLaunchInput, EditorTargetRuntime } from "../target.js";

const COMMANDS = ["zed", "zeditor"] as const;

function macApplication(runtime: EditorTargetRuntime) {
  for (const name of ["Zed", "Zed Preview"]) {
    const bundle = runtime.getMacApplicationBundle(name);
    if (bundle) return { name, bundle };
  }
  return null;
}

function location(input: EditorTargetLaunchInput): string {
  if (!input.line) return input.filePath!;
  return input.column
    ? `${input.filePath}:${input.line}:${input.column}`
    : `${input.filePath}:${input.line}`;
}

export const zedTarget: EditorTarget = {
  id: "zed",
  async describe(runtime) {
    return { id: this.id, label: "Zed", kind: "editor", icon: await runtime.loadIcon("zed.png") };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null || macApplication(runtime) !== null;
  },
  async launch(input, runtime) {
    const application = macApplication(runtime);
    const bundledCli = application && `${application.bundle}/Contents/MacOS/cli`;
    const command =
      runtime.resolveCommand(COMMANDS) ??
      (bundledCli && runtime.pathExists(bundledCli) ? bundledCli : null);
    if (command) {
      await runtime.spawnDetached({
        command,
        args: input.filePath ? [input.workspacePath, location(input)] : [input.workspacePath],
      });
      return;
    }
    if (application) {
      await runtime.openMacApplication({
        applicationName: application.name,
        applicationPath: application.bundle,
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }
    throw new Error("Zed is not installed");
  },
};
