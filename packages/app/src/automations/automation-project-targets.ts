import type { ProjectSummary } from "@/utils/projects";
import { shortenPath } from "@/utils/shorten-path";

export const PROJECT_OPTION_PREFIX = "project:";

export interface AutomationProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectViewKey: string;
  projectName: string;
  cwd: string;
  isGit: boolean;
}

export function buildProjectOptionId(serverId: string, projectViewKey: string): string {
  return `${PROJECT_OPTION_PREFIX}${serverId}:${projectViewKey}`;
}

/**
 * The project roots the automation form can target: one per online host of each
 * project, keyed by (serverId, cwd). The automations list reuses this set to name
 * an automation's stored cwd; the two surfaces must agree on what "a project" is.
 */
export function buildAutomationProjectTargets(
  projects: readonly ProjectSummary[],
): AutomationProjectTarget[] {
  const targets: AutomationProjectTarget[] = [];
  for (const project of projects) {
    for (const host of project.hosts) {
      const cwd = host.repoRoot.trim();
      if (!host.isOnline || !cwd) {
        continue;
      }
      targets.push({
        optionId: buildProjectOptionId(host.serverId, project.viewKey),
        serverId: host.serverId,
        serverName: host.serverName,
        projectViewKey: project.viewKey,
        projectName: host.projectName,
        cwd,
        isGit: Boolean(host.gitRuntime),
      });
    }
  }
  return targets;
}

function projectNameKey(serverId: string, cwd: string): string {
  return `${serverId}:${cwd.trim()}`;
}

/** Map (serverId, cwd) -> project name for naming an automation's stored cwd. */
export function buildProjectNameByCwd(
  targets: readonly AutomationProjectTarget[],
): Map<string, string> {
  const byCwd = new Map<string, string>();
  for (const target of targets) {
    byCwd.set(projectNameKey(target.serverId, target.cwd), target.projectName);
  }
  return byCwd;
}

/**
 * Name a stored cwd for display: the matching project name when the client
 * knows this root on this host, otherwise the shortened path itself. Never
 * blank, never a claim the client cannot back up.
 */
export function describeAutomationCwd(input: {
  serverId: string;
  cwd: string;
  projectNameByCwd: ReadonlyMap<string, string>;
}): string {
  return (
    input.projectNameByCwd.get(projectNameKey(input.serverId, input.cwd)) ?? shortenPath(input.cwd)
  );
}
