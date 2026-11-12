import type { AttackRun, Finding } from "@pimi/protocol/attack/types";
import { attackAllowedHosts } from "@pimi/protocol/attack/allowlist";
import { ATTACK_ROLE_PROFILES } from "./roster.js";

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function runContext(run: AttackRun): string {
  const hosts = attackAllowedHosts(run.remoteHost);
  return [
    `Run id: ${run.id}`,
    `Target: ${run.target}`,
    run.repoScope
      ? `Repository (your working directory): ${run.cwd}`
      : `Repository: out of scope. Do not read ${run.cwd} or search its files; work from the running app only.`,
    `Hosts any agent may open or navigate to: ${hosts.join(", ")} (localhost on any port). Browser tabs refuse every other host, and each refusal is audited. Do not try to reach other hosts.`,
    `Disposable target: ${run.disposableTarget ? "yes" : "no"}. This run is read-only either way: do not submit state-changing requests, delete anything or send load bursts.`,
    `Budget: ${minutes(run.limits.maxRuntimeMs)} minutes and ${run.limits.maxTokens.toLocaleString("en-US")} tokens across all agents. The run pauses when either runs out.`,
    run.scopeNotes.trim() ? `Scope notes from the owner:\n${run.scopeNotes.trim()}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function leadPrompt(run: AttackRun): string {
  const roster = run.roster
    .map(
      (role) =>
        `- ${ATTACK_ROLE_PROFILES[role].label}: create_agent with profile "${ATTACK_ROLE_PROFILES[role].profileId}"`,
    )
    .join("\n");
  return `You are leading an Attack run: a QA and security hardening pass over an app the owner built and owns.

${runContext(run)}

Roster. Start each of these as a subagent with create_agent, passing the profile shown. Give every subagent a prompt that states the run id, the target, the allowed hosts, the repository path, the read-only rule and the scope notes, plus the one thing you want it to cover. Do not pass a provider; they inherit yours.
${roster}

How to run it
1. Map the target first: open it in a browser tab (browser_new_tab), snapshot it, and list the routes, forms and inputs you can see. Read the repository's entry points and routes to match them against what the browser shows.
2. Start the roster subagents with that map in their prompts. Work in parallel; do not wait idly. You are notified when a subagent finishes.
3. Subagents report findings with submit_finding. You may also submit findings you confirmed yourself. Submitting the same problem twice is safe: findings are deduplicated by route, category and title, and a repeat only raises its report count.
4. When subagents finish, read the findings you were told about, drop anything unverified, and make sure each remaining finding has a repro and evidence.
5. Call finish_attack_run with a short summary when the roster is done and the findings stand. "Nothing found" is a valid result if the roster attacked the target and it held.

Rules
- Report only. Never edit files, fix a finding or change the target.
- Every finding needs steps that reproduce it and evidence: a screenshot (pass the browserId to submit_finding), a terminal excerpt or the quoted file line.
- Do not log in as anyone, and do not use real credentials or real personal data.
- Stay inside the allowed hosts and the repository.`;
}

export function resumePrompt(run: AttackRun, findings: readonly Finding[]): string {
  const known = findings.length
    ? findings
        .map(
          (finding) =>
            `- [${finding.severity}] ${finding.title} (${finding.route}, ${finding.status}, reported ${finding.reportCount}x)`,
        )
        .join("\n")
    : "- none yet";
  return `The owner resumed this Attack run after a pause. Your subagents were stopped and restarted where they left off.

${runContext(run)}
Spent so far: ${minutes(run.spent.runtimeMs)} of ${minutes(run.limits.maxRuntimeMs)} minutes, ${run.spent.tokens.toLocaleString("en-US")} of ${run.limits.maxTokens.toLocaleString("en-US")} tokens.

Findings already recorded (submit_finding will merge a repeat into these):
${known}

Continue the run: check what each subagent still owes, cover what is not covered yet, and call finish_attack_run when the roster is done.`;
}
