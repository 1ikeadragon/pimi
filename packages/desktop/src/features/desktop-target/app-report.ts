// The text of a `desktop_app` answer, from what the helper found. Both helpers answer facts; the
// agent reads the sentence.
export function appReport(result: Record<string, unknown>): string {
  if (typeof result.launched === "boolean") {
    const lines = [
      result.launched
        ? "The app was started and its window came up."
        : "The app is already running; nothing was started.",
    ];
    if (result.terminated === true) lines.unshift("The app did not close in time and was ended.");
    return lines.join(" ");
  }
  const lines: string[] = [];
  if (result.running === true) {
    lines.push("Status: running.");
  } else {
    const exit = typeof result.exitCode === "number" ? ` (exit code ${result.exitCode})` : "";
    lines.push(`Status: the process has exited${exit}.`);
  }
  const facts: [string, string, string][] = [
    ["uptimeSeconds", "Uptime", " s"],
    ["workingSetMB", "Memory", " MB"],
    ["cpuSeconds", "CPU time", " s"],
    ["windows", "Windows", ""],
    ["gdiHandles", "GDI handles", ""],
    ["userHandles", "USER handles", ""],
  ];
  for (const [key, label, unit] of facts) {
    const value = result[key];
    if (typeof value === "number") lines.push(`${label}: ${value}${unit}`);
  }
  if (typeof result.responding === "boolean") {
    lines.push(`Responding: ${result.responding ? "yes" : "no (hung)"}`);
  }
  if (result.werFaultUp === true) lines.push("A crash dialog is up for this process.");
  const crashes = Array.isArray(result.crashReports) ? result.crashReports : [];
  if (crashes.length > 0) lines.push(`Crash reports since it started: ${crashes.join(", ")}`);
  return lines.join("\n");
}
