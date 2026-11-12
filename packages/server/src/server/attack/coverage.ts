import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  AttackCoverageSchema,
  type AttackCoverage,
  type AttackCoverageRoute,
} from "@pimi/protocol/attack/types";
import type { SessionOutboundMessage } from "@pimi/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { normalizeFindingRoute } from "./signature.js";

const MAX_ROUTES = 500;
const MAX_AGENTS_PER_ROUTE = 16;
const PUSH_INTERVAL_MS = 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Routes an Attack run's agents reached in a browser tab, reported by the app from its browser
 * store. Browser only: shell commands and file reads are not coverage. Kept in memory per run,
 * written to attack-runs/<id>/coverage.json at most once a second, and pushed to clients at the
 * same rate. Past 500 routes a new route is counted nowhere (the reply says so by not storing it).
 */
export class AttackCoverageTracker {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly emit: (message: SessionOutboundMessage) => void;
  private readonly runs = new Map<string, AttackCoverage>();
  private readonly loading = new Map<string, Promise<AttackCoverage>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: {
    dir: string;
    logger: Logger;
    emit: (message: SessionOutboundMessage) => void;
  }) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.emit = options.emit;
  }

  async get(runId: string): Promise<AttackCoverage> {
    return this.load(runId);
  }

  /** Counts one visit. Returns the route's record; a route past the cap is returned unstored. */
  async record(runId: string, agentId: string, rawRoute: string): Promise<AttackCoverageRoute> {
    const coverage = await this.load(runId);
    const route = normalizeFindingRoute(rawRoute).slice(0, 500);
    const now = new Date().toISOString();
    const existing = coverage[route];
    if (!existing) {
      if (Object.keys(coverage).length >= MAX_ROUTES) {
        return { agentIds: [agentId], visits: 1, firstAt: now };
      }
      coverage[route] = { agentIds: [agentId], visits: 1, firstAt: now };
    } else {
      existing.visits += 1;
      if (!existing.agentIds.includes(agentId) && existing.agentIds.length < MAX_AGENTS_PER_ROUTE) {
        existing.agentIds.push(agentId);
      }
    }
    this.schedule(runId);
    return coverage[route]!;
  }

  /** Writes what a pending timer has not yet written. */
  async stop(): Promise<void> {
    const pending = [...this.timers.keys()];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(pending.map((runId) => this.write(runId)));
  }

  private write(runId: string): Promise<void> {
    const coverage = this.runs.get(runId);
    if (!coverage) return Promise.resolve();
    return writeJsonFileAtomic(join(this.dir, runId, "coverage.json"), coverage).catch(
      (error: unknown) => {
        this.logger.warn({ err: error, runId }, "Failed to write attack coverage");
      },
    );
  }

  private load(runId: string): Promise<AttackCoverage> {
    if (!ID_PATTERN.test(runId)) throw new Error(`Invalid attack run id: ${runId}`);
    const known = this.runs.get(runId);
    if (known) return Promise.resolve(known);
    let pending = this.loading.get(runId);
    if (!pending) {
      pending = this.readFile(runId).then((coverage) => {
        this.runs.set(runId, coverage);
        this.loading.delete(runId);
        return coverage;
      });
      this.loading.set(runId, pending);
    }
    return pending;
  }

  private async readFile(runId: string): Promise<AttackCoverage> {
    try {
      const text = await readFile(join(this.dir, runId, "coverage.json"), "utf-8");
      return AttackCoverageSchema.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error, runId }, "Ignoring unreadable attack coverage file");
      }
      return {};
    }
  }

  // Trailing throttle: the first visit after a quiet second starts a timer, later ones ride it.
  private schedule(runId: string): void {
    if (this.timers.has(runId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      const coverage = this.runs.get(runId);
      if (!coverage) return;
      this.emit({ type: "attack.coverage.changed", payload: { runId, coverage } });
      void this.write(runId);
    }, PUSH_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(runId, timer);
  }
}
