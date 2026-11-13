import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { create } from "zustand";
import type { AttackRun, Finding } from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { toErrorMessage } from "@/utils/error-messages";
import { buildFixPrompt, parseRunProvider } from "./fix-prompt";

/** Fix agents working at once; the rest of a batch waits for a slot. */
export const BATCH_FIX_CONCURRENCY = 3;
// An agent never seen working is treated as finished after this long, so a slot cannot stay held.
const NEVER_BUSY_GRACE_MS = 60_000;

export type FixJobState = "queued" | "starting" | "working" | "finished" | "failed";

export interface FixJob {
  findingId: string;
  runId: string;
  serverId: string;
  /** The Attack workspace the batch was started from. */
  workspaceId: string;
  run: AttackRun;
  finding: Finding;
  state: FixJobState;
  agentId?: string;
  /** The worktree workspace the fix agent works in. */
  fixWorkspaceId?: string;
  sawBusy: boolean;
  startedAt?: number;
  error?: string;
}

interface BatchFixStore {
  jobs: Record<string, FixJob>;
  enqueue: (jobs: FixJob[]) => void;
  patch: (findingId: string, patch: Partial<FixJob>) => void;
}

// In memory: a queue does not survive a reload, but each started fix keeps its agent link on the
// finding itself (`fixAgentId`).
export const useAttackBatchFixStore = create<BatchFixStore>()((set) => ({
  jobs: {},
  enqueue: (jobs) =>
    set((state) => {
      const next = { ...state.jobs };
      for (const job of jobs) {
        const current = next[job.findingId];
        // A fix in flight is never restarted; a failed or finished one may be run again.
        if (
          current &&
          (current.state === "queued" ||
            current.state === "starting" ||
            current.state === "working")
        )
          continue;
        next[job.findingId] = job;
      }
      return { jobs: next };
    }),
  patch: (findingId, patch) =>
    set((state) => {
      const current = state.jobs[findingId];
      return current ? { jobs: { ...state.jobs, [findingId]: { ...current, ...patch } } } : state;
    }),
}));

export function queueBatchFix(input: {
  serverId: string;
  workspaceId: string;
  run: AttackRun;
  findings: readonly Finding[];
}): void {
  useAttackBatchFixStore.getState().enqueue(
    input.findings.map((finding) => ({
      findingId: finding.id,
      runId: input.run.id,
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      run: input.run,
      finding,
      state: "queued" as const,
      sawBusy: false,
    })),
  );
}

function isBusy(agent: Agent): boolean {
  return (
    agent.pendingPermissions.length > 0 ||
    agent.turn.phase === "open" ||
    agent.status === "running" ||
    agent.status === "initializing"
  );
}

/**
 * Runs the batch queue: at most BATCH_FIX_CONCURRENCY fix agents work at once, each in its own
 * worktree so parallel fixes to one file never collide. Mounted once by the board; a queue that
 * is waiting needs the board open to advance. A fix agent finishing marks the job finished, not
 * the finding fixed: the owner or a re-test does that.
 */
export function useAttackBatchFixPump(serverId: string): void {
  const client = useHostRuntimeClient(serverId);
  const jobs = useAttackBatchFixStore((state) => state.jobs);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const projects = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  useEffect(() => {
    if (!client) return;
    const { patch } = useAttackBatchFixStore.getState();
    const mine = Object.values(jobs).filter((job) => job.serverId === serverId);
    let running = 0;
    for (const job of mine) {
      if (job.state === "working" && job.agentId) {
        const agent = agents?.get(job.agentId);
        if (agent && isBusy(agent)) {
          if (!job.sawBusy) patch(job.findingId, { sawBusy: true });
          running += 1;
        } else if (agent && agent.status === "error") {
          patch(job.findingId, { state: "failed", error: agent.lastError ?? "Agent failed" });
        } else if (job.sawBusy || Date.now() - (job.startedAt ?? 0) > NEVER_BUSY_GRACE_MS) {
          patch(job.findingId, { state: "finished" });
        } else running += 1;
      } else if (job.state === "starting" || job.state === "working") running += 1;
    }
    const queued = mine
      .filter((job) => job.state === "queued")
      .sort((a, b) => a.finding.createdAt.localeCompare(b.finding.createdAt));
    for (const job of queued.slice(0, Math.max(0, BATCH_FIX_CONCURRENCY - running))) {
      patch(job.findingId, { state: "starting", startedAt: Date.now() });
      void (async () => {
        try {
          const projectId = projects?.get(job.workspaceId)?.projectId;
          if (!projectId) throw new Error("Project is not available on this host");
          const { provider, model } = parseRunProvider(job.run.provider);
          // The time suffix keeps a retry from colliding with the branch of an earlier attempt.
          const slug = `attack-fix-${job.finding.id.slice(0, 8)}-${Date.now().toString(36)}`;
          const payload = await client.createWorkspace({
            source: {
              kind: "worktree",
              cwd: job.run.cwd,
              projectId,
              action: "branch-off",
              branchName: slug,
              worktreeSlug: slug,
            },
            title: `Fix: ${job.finding.title}`.slice(0, 120),
            agent: {
              provider,
              ...(model ? { model } : {}),
              cwd: job.run.cwd,
              title: `Fix: ${job.finding.title}`.slice(0, 120),
              initialPrompt: buildFixPrompt(job.run, job.finding),
            },
          });
          if (payload.error || !payload.workspace || !payload.agent) {
            throw new Error(payload.error ?? "Could not create the fix worktree");
          }
          patch(job.findingId, {
            state: "working",
            agentId: payload.agent.id,
            fixWorkspaceId: payload.workspace.id,
            startedAt: Date.now(),
          });
          await client.attackFindingUpdate({
            runId: job.runId,
            findingId: job.findingId,
            fixAgentId: payload.agent.id,
            status: "triaged",
          });
        } catch (caught) {
          patch(job.findingId, { state: "failed", error: toErrorMessage(caught) });
        }
      })();
    }
  }, [agents, client, jobs, projects, serverId]);
}

/** The line under a finding that has a batch fix: its state, and a link to the fix agent. */
export function FixJobLine({ finding, serverId }: { finding: Finding; serverId: string }) {
  const { t } = useTranslation();
  const job = useAttackBatchFixStore((state) => state.jobs[finding.id]);
  const agentId = job?.agentId ?? finding.fixAgentId;
  const fixWorkspaceId = useSessionStore(
    (state) =>
      job?.fixWorkspaceId ??
      (agentId ? state.sessions[serverId]?.agents?.get(agentId)?.workspaceId : undefined),
  );
  const onOpen = useCallback(() => {
    if (agentId && fixWorkspaceId) {
      navigateToWorkspace({
        serverId,
        workspaceId: fixWorkspaceId,
        target: { kind: "agent", agentId },
      });
    }
  }, [agentId, fixWorkspaceId, serverId]);
  if (!job && !agentId) return null;
  const state = job?.state ?? "working";
  return (
    <View style={styles.line} testID={`attack-fix-job-${finding.id}`}>
      <Text style={styles.text} testID="attack-fix-job-state">
        {job ? t(`attack.batchFix.state.${state}`) : t("attack.batchFix.linked")}
        {job?.error ? `: ${job.error}` : ""}
      </Text>
      {agentId && fixWorkspaceId ? (
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Wrench}
          onPress={onOpen}
          testID="attack-fix-job-open"
        >
          {t("attack.batchFix.openAgent")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
