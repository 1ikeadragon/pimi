import { ATTACK_PERF_LITE_LIMITS, type AttackRun, type Finding } from "@pimi/protocol/attack/types";
import { attackAllowedHosts } from "@pimi/protocol/attack/allowlist";
import { renderTemplate } from "../prompts/render.js";
import { ATTACK_ROLE_PROFILES } from "./roster.js";

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function annotationsBlock(run: AttackRun): string | null {
  if (run.annotations.length === 0) return null;
  const items = run.annotations
    .map((item) => {
      const region = item.kind === "desktop" ? item.region : null;
      const parts = region
        ? [
            `${item.label}: ${item.note.trim() || "(no note)"}`,
            `  region x,y,w,h: ${region.x},${region.y},${region.width},${region.height} of the desktop window screenshot`,
            item.hasImage ? "  screenshot: yes (get_annotation returns it)" : null,
          ]
        : [
            `${item.label}: ${item.note.trim() || "(no note)"}`,
            `  page: ${item.url}`,
            `  element: <${item.tag}> ${item.selector}`,
            item.hasImage ? "  screenshot: yes (get_annotation returns it)" : null,
            item.text.trim() ? `  text: ${JSON.stringify(item.text.trim())}` : null,
          ];
      return parts.filter((line): line is string => line !== null).join("\n");
    })
    .join("\n");
  const rule = renderTemplate(
    run.onlyAnnotated ? "attack-annotations-only" : "attack-annotations-also",
    {},
  );
  const labels = run.annotations.map((item) => item.label).join(", ");
  return renderTemplate("attack-annotations", { rule, labels, items });
}

function desktopBlock(run: AttackRun): string | null {
  const target = run.desktopTarget;
  if (!target) return null;
  const title = target.windowTitle ? ` titled ${JSON.stringify(target.windowTitle)}` : "";
  const windows = target.platform === "win32";
  const refs = windows ? "refs such as @d12" : 'element paths such as "0/2/1"';
  const refused = windows
    ? "system chords (the Windows key, alt+tab, alt+f4, ctrl+alt chords), and points outside the window"
    : "system chords such as cmd+q or cmd+tab, and points outside the window";
  const platform = windows ? "windows" : "macos";
  const tools = renderTemplate(`attack-desktop-tools-${platform}`, {});
  return [
    renderTemplate("attack-desktop-window", { appName: target.appName, title, tools, refused }),
    renderTemplate(`attack-desktop-usage-${platform}`, { refs }),
    renderTemplate(
      run.allowDesktopInput || run.disposableTarget
        ? "attack-desktop-input-allowed"
        : "attack-desktop-input-denied",
      {},
    ),
    ...(windows
      ? [
          renderTemplate(
            target.allowDesktopInspect
              ? "attack-desktop-inspect-allowed"
              : "attack-desktop-inspect-denied",
            {},
          ),
        ]
      : []),
  ].join("\n");
}

function writeRule(run: AttackRun): string {
  if (!run.disposableTarget) {
    return renderTemplate("attack-mode-read-only", {});
  }
  const limits = ATTACK_PERF_LITE_LIMITS;
  return renderTemplate("attack-mode-writes", {
    maxRequests: String(limits.maxRequests),
    maxConcurrent: String(limits.maxConcurrent),
    maxSeconds: String(limits.maxSeconds),
  });
}

function credentialsBlock(run: AttackRun, credentials: string | undefined): string | null {
  if (!run.roster.includes("auth")) return null;
  if (!credentials?.trim()) {
    return renderTemplate("attack-credentials-missing", {});
  }
  return renderTemplate("attack-credentials", { credentials: credentials.trim() });
}

function runContext(run: AttackRun): string {
  const hosts = attackAllowedHosts(run.remoteHost);
  return [
    `Run id: ${run.id}`,
    run.target ? `Target: ${run.target}` : "Target: a desktop window (no URL), described below.",
    desktopBlock(run),
    run.repoScope
      ? `Repository (your working directory): ${run.cwd}`
      : `Repository: out of scope. Do not read ${run.cwd} or search its files; work from the running app only.`,
    renderTemplate("attack-hosts", { hosts: hosts.join(", ") }),
    writeRule(run),
    renderTemplate("attack-budget", {
      minutes: String(minutes(run.limits.maxRuntimeMs)),
      tokens: run.limits.maxTokens.toLocaleString("en-US"),
    }),
    run.scopeNotes.trim() ? `Scope notes from the owner:\n${run.scopeNotes.trim()}` : null,
    annotationsBlock(run),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** One finding as agents see it in a list: the id they pass back, then what it is. */
export function findingLine(finding: Finding): string {
  const count = finding.reportCount > 1 ? `, reported ${finding.reportCount}x` : "";
  return `- ${finding.id} [${finding.severity}, ${finding.category}] ${finding.route}: ${finding.title} (${finding.status}${count})`;
}

export function leadPrompt(run: AttackRun, credentials?: string): string {
  const roster = run.roster
    .map(
      (role) =>
        `- ${ATTACK_ROLE_PROFILES[role].label}: create_agent with profile "${ATTACK_ROLE_PROFILES[role].profileId}"`,
    )
    .join("\n");
  return renderTemplate("attack-lead", {
    runContext: runContext(run),
    credentials: credentialsBlock(run, credentials) ?? "",
    roster,
    mapBrowser: run.target
      ? "open it in a browser tab (browser_new_tab), snapshot it, and list the routes, forms and inputs you can see."
      : "",
    mapDesktop: run.desktopTarget
      ? " Take a desktop_snapshot of the desktop window and list the controls, fields and flows you can see."
      : "",
    startStep: run.roster.includes("recon")
      ? "Start the Recon and mapper subagent first and give its map to the others when it reports; start agents that do not need the map (the secrets and config auditor) at once."
      : "Start the roster subagents with that map in their prompts.",
    loginRule: run.roster.includes("auth")
      ? "Only the auth and access agent logs in, and only with the test credentials above."
      : "Do not log in as anyone.",
  });
}

export function resumePrompt(
  run: AttackRun,
  findings: readonly Finding[],
  credentials?: string,
): string {
  const known = findings.length ? findings.map(findingLine).join("\n") : "- none yet";
  return renderTemplate("attack-resume", {
    runContext: runContext(run),
    credentials: credentialsBlock(run, credentials) ?? "",
    spentMinutes: String(minutes(run.spent.runtimeMs)),
    limitMinutes: String(minutes(run.limits.maxRuntimeMs)),
    spentTokens: run.spent.tokens.toLocaleString("en-US"),
    limitTokens: run.limits.maxTokens.toLocaleString("en-US"),
    findings: known,
  });
}

export function stallPrompt(run: AttackRun, findings: readonly Finding[]): string {
  const known = findings.length ? findings.map(findingLine).join("\n") : "- none yet";
  return renderTemplate("attack-stall", { runId: run.id, findings: known });
}
