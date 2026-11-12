import { ATTACK_PERF_LITE_LIMITS, type AttackRun, type Finding } from "@pimi/protocol/attack/types";
import { attackAllowedHosts } from "@pimi/protocol/attack/allowlist";
import { ATTACK_ROLE_PROFILES } from "./roster.js";

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function annotationsBlock(run: AttackRun): string | null {
  if (run.annotations.length === 0) return null;
  const items = run.annotations
    .map((item) => {
      const parts = [
        `${item.label}: ${item.note.trim() || "(no note)"}`,
        `  page: ${item.url}`,
        `  element: <${item.tag}> ${item.selector}`,
        item.hasImage ? "  screenshot: yes (get_annotation returns it)" : null,
        item.text.trim() ? `  text: ${JSON.stringify(item.text.trim())}` : null,
      ];
      return parts.filter((line): line is string => line !== null).join("\n");
    })
    .join("\n");
  const rule = run.onlyAnnotated
    ? "The owner wants ONLY these items tested: do not run a general pass over the rest of the app, and give every subagent the labels it must cover."
    : "These are in addition to the general pass: cover them first, then the rest of the app. Give every subagent the labels it must cover.";
  const labels = run.annotations.map((item) => item.label).join(", ");
  return `Owner annotations (elements the owner marked in the live target, with their notes). ${rule}
Annotation handling (${labels}):
- Each agent reads an annotation with get_annotation(label): the owner's note, the element and, when there is one, its screenshot. Tell every subagent which labels to read and test; they see only what you write.
- A finding about an annotation passes annotationLabels: ["A1"] to submit_finding, so the owner sees which note it answers.
- Before finish_attack_run, call report_annotation_result(label, result, note) once for every annotation that has no finding: clean when it was tested and held, not_testable when it could not be tested. Never mark an annotation clean that nobody tested.
${items}`;
}

function desktopBlock(run: AttackRun): string | null {
  const target = run.desktopTarget;
  if (!target) return null;
  const title = target.windowTitle ? ` titled ${JSON.stringify(target.windowTitle)}` : "";
  return [
    `Desktop window: ${target.appName}'s window${title}. This is the only window you may read or drive. Use desktop_snapshot (accessibility tree with element paths), desktop_screenshot, desktop_click, desktop_type and desktop_key; every action is recorded for the owner and the desktop app refuses any other window or app, system chords such as cmd+q or cmd+tab, and points outside the window.`,
    run.allowDesktopInput || run.disposableTarget
      ? "Desktop input: allowed. Only click, type and press keys to reach and exercise features; never delete the owner's data, save over files, quit the app or change settings outside the window."
      : "Desktop input: NOT allowed. desktop_click, desktop_type and desktop_key are refused; read the window with desktop_snapshot and desktop_screenshot only.",
  ].join("\n");
}

function writeRule(run: AttackRun): string {
  if (!run.disposableTarget) {
    return "Mode: read-only. The owner did not mark the target disposable: do not submit state-changing requests (POST, PUT, PATCH, DELETE, form submits), delete anything or send load bursts.";
  }
  const limits = ATTACK_PERF_LITE_LIMITS;
  return `Mode: writes allowed on this disposable target. The owner confirmed it can lose its data: agents may submit forms, create, change and delete records in the target, and the perf-lite agent may send one bounded burst (at most ${limits.maxRequests} requests in total, ${limits.maxConcurrent} at once, ${limits.maxSeconds} seconds). This applies to the target only: never write to other hosts, never touch the owner's repository or files outside it.`;
}

function credentialsBlock(run: AttackRun, credentials: string | undefined): string | null {
  if (!run.roster.includes("auth")) return null;
  if (!credentials?.trim()) {
    return "Test credentials: NOT available (the daemon restarted since the run began and the owner has not entered them again). Do not start the auth and access agent; tell the owner in your final summary that it was skipped.";
  }
  return `Test credentials for the auth and access agent only (throwaway test accounts the owner made; give them to no other agent, never write them into a finding, a file or a screenshot caption, and never use them against another host):
${credentials.trim()}`;
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
    `Hosts any agent may open or navigate to: ${hosts.join(", ")} (localhost on any port). Browser tabs refuse every other host, and each refusal is audited. Do not try to reach other hosts.`,
    writeRule(run),
    `Budget: ${minutes(run.limits.maxRuntimeMs)} minutes and ${run.limits.maxTokens.toLocaleString("en-US")} tokens across all agents. The run pauses when either runs out.`,
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
  return `You are leading an Attack run: a QA and security hardening pass over an app the owner built and owns.

${runContext(run)}
${credentialsBlock(run, credentials) ?? ""}

Roster. Start each of these as a subagent with create_agent, passing the profile shown. Give every subagent a prompt that states the run id, the target, the allowed hosts, the repository path, the mode line (read-only or writes allowed), the scope notes and, for the auth and access agent only, the test credentials, plus the one thing you want it to cover. Do not pass a provider; they inherit yours.
${roster}

How to run it
1. Map the target first: ${run.target ? "open it in a browser tab (browser_new_tab), snapshot it, and list the routes, forms and inputs you can see." : ""}${run.desktopTarget ? " Take a desktop_snapshot of the desktop window and list the controls, fields and flows you can see." : ""} Read the repository's entry points and routes to match them against what you see.
2. ${run.roster.includes("recon") ? "Start the Recon and mapper subagent first and give its map to the others when it reports; start agents that do not need the map (the secrets and config auditor) at once." : "Start the roster subagents with that map in their prompts."} Work in parallel; do not wait idly. You are notified when a subagent finishes.
3. Subagents report findings with submit_finding. You may also submit findings you confirmed yourself. One defect is one finding, however many agents hit it and whatever words they use: when the run already has findings, submit_finding shows them and records nothing until you answer with duplicateOf (the same underlying defect; your evidence is added to it) or distinct.
4. When subagents finish, read the findings you were told about, drop anything unverified, and make sure each remaining finding has a repro and evidence.
5. Call finish_attack_run with a short summary when the roster is done and the findings stand. It first shows you every finding; call it again with the pairs that are one defect under two names in merges, or an empty merges list. "Nothing found" is a valid result if the roster attacked the target and it held.

Rules
- Never end a turn with nothing running. Each turn must start the missing roster subagents, wait on subagents that are working, or call finish_attack_run. If every subagent is idle or finished, finish the run now.
- Report only. Never edit files, fix a finding or change the target.
- Every finding needs steps that reproduce it and evidence: a screenshot (pass the browserId to submit_finding), a terminal excerpt or the quoted file line.
- ${run.roster.includes("auth") ? "Only the auth and access agent logs in, and only with the test credentials above." : "Do not log in as anyone."} Never use real credentials or real personal data.
- Stay inside the allowed hosts and the repository.`;
}

export function resumePrompt(
  run: AttackRun,
  findings: readonly Finding[],
  credentials?: string,
): string {
  const known = findings.length ? findings.map(findingLine).join("\n") : "- none yet";
  return `The owner resumed this Attack run after a pause. Your subagents were stopped and restarted where they left off.

${runContext(run)}
${credentialsBlock(run, credentials) ?? ""}
Spent so far: ${minutes(run.spent.runtimeMs)} of ${minutes(run.limits.maxRuntimeMs)} minutes, ${run.spent.tokens.toLocaleString("en-US")} of ${run.limits.maxTokens.toLocaleString("en-US")} tokens.

Findings already recorded (pass one of these ids as duplicateOf when a report repeats it):
${known}

Continue the run: check what each subagent still owes, cover what is not covered yet, and call finish_attack_run when the roster is done.`;
}

export function stallPrompt(run: AttackRun, findings: readonly Finding[]): string {
  const known = findings.length ? findings.map(findingLine).join("\n") : "- none yet";
  return `Attack run ${run.id}: no agent is working right now (you and every subagent are idle) and the run is not finished. Do not wait for anyone: nobody is going to wake you.

Findings recorded so far:
${known}

Do one of these now, in this turn:
- If you have not started every roster subagent yet, start the missing ones with create_agent (profile and run context as in your first instructions).
- If every subagent has finished, review the findings and call finish_attack_run.
Never end a turn without one of those two.`;
}
