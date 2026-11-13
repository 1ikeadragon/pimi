// Built-in agent profiles. The daemon seeds them into `daemon.agentProfiles` (seed.ts).
// Raise a profile's `version` when its copy changes: unedited copies on hosts are replaced.
import type { AgentProfile } from "@pimi/protocol/agent-profile";
import { renderTemplate } from "../../prompts/render.js";

export const BUILTIN_PROFILE_ID_PREFIX = "builtin-";

export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}adversarial-reviewer`,
    name: "Adversarial reviewer",
    icon: "shield",
    color: "red",
    notes:
      "Reviews a change by trying to break it. Use for code review, pre-merge audits, and second opinions on a diff. Reports findings; does not edit.",
    instructions: renderTemplate("profile-adversarial-reviewer", {}),
    builtin: { key: "adversarial-reviewer", version: 2 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}report-writer`,
    name: "Report writer",
    icon: "fileText",
    color: "blue",
    notes:
      "Merges the results of several agents into one report for a person. Use as the last step after parallel reviewers or investigators; put their results in its prompt.",
    instructions: renderTemplate("profile-report-writer", {}),
    builtin: { key: "report-writer", version: 2 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}investigator`,
    name: "Investigator",
    icon: "search",
    color: "amber",
    notes:
      'Finds the cause of a failure and proves it. Use for failing checks, flaky tests, regressions, and "why did this happen". Reports the cause and the smallest fix; does not make it.',
    instructions: renderTemplate("profile-investigator", {}),
    builtin: { key: "investigator", version: 2 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}implementer`,
    name: "Implementer",
    icon: "hammer",
    color: "emerald",
    notes:
      "Makes one scoped change and proves it works. Use for implementing a plan, a fix from an investigation, or a routine upgrade.",
    instructions: renderTemplate("profile-implementer", {}),
    builtin: { key: "implementer", version: 2 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-coordinator`,
    name: "Attack coordinator",
    icon: "shield",
    color: "red",
    notes:
      "Leads an Attack run: maps the target, starts the attack subagents and keeps the findings straight. Started by Attack mode; not for ordinary tasks.",
    instructions: renderTemplate("profile-attack-coordinator", {}),
    builtin: { key: "attack-coordinator", version: 2 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-ui-qa`,
    name: "Attack UI QA and chaos",
    icon: "bug",
    color: "amber",
    notes:
      "Drives a running app in the browser with odd inputs and real flows, watching the console and network for failures. Reports defects; does not fix. Started by the Attack coordinator.",
    instructions: renderTemplate("profile-attack-ui-qa", {}),
    builtin: { key: "attack-ui-qa", version: 2 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-secrets-auditor`,
    name: "Attack secrets and config auditor",
    icon: "search",
    color: "violet",
    notes:
      "Scans a repository read-only for committed secrets, unsafe configuration and exposed files. Reports with the file and line; does not fix. Started by the Attack coordinator.",
    instructions: renderTemplate("profile-attack-secrets-auditor", {}),
    builtin: { key: "attack-secrets-auditor", version: 2 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-recon`,
    name: "Attack recon and mapper",
    icon: "search",
    color: "blue",
    notes:
      "Maps a running app and its repository read-only: routes, forms, endpoints, auth walls. Feeds the lead and the other attack agents; reports only what it can reproduce. Started by the Attack coordinator.",
    instructions: renderTemplate("profile-attack-recon", {}),
    builtin: { key: "attack-recon", version: 1 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-api`,
    name: "Attack backend and API tester",
    icon: "bug",
    color: "teal",
    notes:
      "Exercises a running app's HTTP endpoints with curl on the allowed hosts: wrong methods, missing and malformed fields, error leaks, missing limits. Reports defects; does not fix. Started by the Attack coordinator.",
    instructions: renderTemplate("profile-attack-api", {}),
    builtin: { key: "attack-api", version: 1 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-auth`,
    name: "Attack auth and access tester",
    icon: "shield",
    color: "orange",
    notes:
      "Tests login, sessions and access control with test-account credentials from the owner. Never uses real accounts. Reports defects; does not fix. Started by the Attack coordinator only when test credentials were supplied.",
    instructions: renderTemplate("profile-attack-auth", {}),
    builtin: { key: "attack-auth", version: 1 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-input`,
    name: "Attack input robustness tester",
    icon: "bug",
    color: "pink",
    notes:
      "Feeds boundary values and injection strings into a running app's forms and parameters and watches how it copes. Reports defects; does not fix. Started by the Attack coordinator.",
    instructions: renderTemplate("profile-attack-input", {}),
    builtin: { key: "attack-input", version: 1 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-perf-lite`,
    name: "Attack perf-lite tester",
    icon: "bug",
    color: "yellow",
    notes:
      "Runs one small, bounded burst of requests against a disposable target to find slow or fragile endpoints. At most 200 requests, 10 at a time, 60 seconds. Started by the Attack coordinator only on a disposable target.",
    instructions: renderTemplate("profile-attack-perf-lite", {}),
    builtin: { key: "attack-perf-lite", version: 1 },
  },
  {
    id: `${BUILTIN_PROFILE_ID_PREFIX}attack-desktop-security`,
    name: "Attack desktop security tester",
    icon: "shield",
    color: "red",
    notes:
      "Inspects a desktop app's own process, binary, files, local IPC and network read-mostly: signature, exploit mitigations, DLL-hijack paths, Electron fuses, secrets at rest, weak pipes and localhost servers, plaintext traffic. Reports weaknesses; does not fix. Started by the Attack coordinator only when the run has a desktop target.",
    instructions: renderTemplate("profile-attack-desktop-security", {}),
    builtin: { key: "attack-desktop-security", version: 1 },
  },
];
