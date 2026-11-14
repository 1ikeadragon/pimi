import type { ListUsageReportsOptions } from "../../plugins/usage-sources/index.js";
import type pino from "pino";
import type { UsageScope } from "@pimi/plugin/server/usage";
import type { UsageReportEntry } from "@pimi/protocol/messages";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { pricesAsOf, type UsageReader } from "../../usage/aggregate.js";
import type { UsageScanner } from "../../usage/scanner.js";

// A scan newer than this is not repeated when a screen asks for history; the stored rows answer.
const SCAN_STALE_MS = 15_000;

export interface UsageSessionOptions {
  emit(message: SessionOutboundMessage): void;
  runtime?: {
    listUsageReports(options: ListUsageReportsOptions): Promise<UsageReportEntry[]>;
    listProviderAccountLabels(scope: Extract<UsageScope, { kind: "session" }>): Promise<string[]>;
  };
  providerAccountScopes: () => Array<{
    provider: string;
    baseProvider: string;
    env: Record<string, string>;
  }>;
  isEnabled: () => boolean;
  // The usage ledger is always on; it is separate from vendor limit reports and their switch.
  ledger?: { reader: UsageReader; scanner: UsageScanner };
  logger: pino.Logger;
}

export class UsageSession {
  constructor(private readonly options: UsageSessionOptions) {}

  async handleListReports(
    msg: Extract<SessionInboundMessage, { type: "usage.list_reports.request" }>,
  ): Promise<void> {
    try {
      if (!this.options.isEnabled()) throw new Error("Usage is off on this host.");
      if (!this.options.runtime) throw new Error("Plugin runtime is unavailable");
      await this.options.runtime.listUsageReports({
        forceRefresh: msg.forceRefresh,
        reportIds: msg.reportIds,
        agentId: msg.agentId,
        onReport: (report) =>
          this.options.emit({
            type: "usage.list_reports.update",
            payload: { requestId: msg.requestId, report },
          }),
      });
      this.options.emit({
        type: "usage.list_reports.response",
        payload: { requestId: msg.requestId, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "usage.list_reports.response",
        payload: {
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async handleListProviderAccounts(
    msg: Extract<SessionInboundMessage, { type: "usage.provider_accounts.list.request" }>,
  ): Promise<void> {
    try {
      // Identifying an account reads the login store and may ask the vendor; usage off means no.
      const runtime = this.options.isEnabled() ? this.options.runtime : undefined;
      const accounts = runtime
        ? (
            await Promise.all(
              this.options.providerAccountScopes().map(async (scope) => {
                try {
                  const [label] = await runtime.listProviderAccountLabels({
                    kind: "session",
                    provider: scope.baseProvider,
                    env: scope.env,
                  });
                  return label ? [{ provider: scope.provider, label }] : [];
                } catch (error) {
                  this.options.logger.debug(
                    { provider: scope.provider, err: errorMessage(error) },
                    "Provider account lookup failed",
                  );
                  return [];
                }
              }),
            )
          ).flat()
        : [];
      this.options.emit({
        type: "usage.provider_accounts.list.response",
        payload: { requestId: msg.requestId, error: null, accounts },
      });
    } catch (error) {
      this.options.emit({
        type: "usage.provider_accounts.list.response",
        payload: { requestId: msg.requestId, error: errorMessage(error), accounts: [] },
      });
    }
  }

  private requireLedger(): { reader: UsageReader; scanner: UsageScanner } {
    if (!this.options.ledger) throw new Error("Usage history is unavailable");
    return this.options.ledger;
  }

  async handleGetSummary(
    msg: Extract<SessionInboundMessage, { type: "usage.get_summary.request" }>,
  ): Promise<void> {
    try {
      const { reader, scanner } = this.requireLedger();
      scanner.refreshIfStale(SCAN_STALE_MS);
      this.options.emit({
        type: "usage.get_summary.response",
        payload: {
          requestId: msg.requestId,
          error: null,
          summary: {
            firstEventAt: reader.firstEventAt(),
            today: reader.today(msg.timezoneOffsetMinutes),
            days: reader.lastDays(msg.timezoneOffsetMinutes, 7),
            scanning: scanner.scanning,
            prices: { asOf: pricesAsOf() },
          },
        },
      });
    } catch (error) {
      this.options.emit({
        type: "usage.get_summary.response",
        payload: { requestId: msg.requestId, error: errorMessage(error), summary: null },
      });
    }
  }

  async handleGetBreakdown(
    msg: Extract<SessionInboundMessage, { type: "usage.get_breakdown.request" }>,
  ): Promise<void> {
    try {
      const { reader, scanner } = this.requireLedger();
      scanner.refreshIfStale(SCAN_STALE_MS);
      const result = await reader.breakdown(
        {
          range: msg.range,
          provider: msg.provider,
          timezoneOffsetMinutes: msg.timezoneOffsetMinutes,
        },
        msg.groupBy,
      );
      this.options.emit({
        type: "usage.get_breakdown.response",
        payload: {
          requestId: msg.requestId,
          error: null,
          breakdown: {
            ...result,
            firstEventAt: reader.firstEventAt(),
            scanning: scanner.scanning,
            prices: { asOf: pricesAsOf() },
          },
        },
      });
    } catch (error) {
      this.options.emit({
        type: "usage.get_breakdown.response",
        payload: { requestId: msg.requestId, error: errorMessage(error), breakdown: null },
      });
    }
  }

  async handleGetAgentTree(
    msg: Extract<SessionInboundMessage, { type: "usage.get_agent_tree.request" }>,
  ): Promise<void> {
    try {
      const { reader, scanner } = this.requireLedger();
      scanner.refreshIfStale(SCAN_STALE_MS);
      this.options.emit({
        type: "usage.get_agent_tree.response",
        payload: {
          requestId: msg.requestId,
          error: null,
          chats: await reader.agentTree({
            range: msg.range,
            provider: msg.provider,
            timezoneOffsetMinutes: msg.timezoneOffsetMinutes,
          }),
        },
      });
    } catch (error) {
      this.options.emit({
        type: "usage.get_agent_tree.response",
        payload: { requestId: msg.requestId, error: errorMessage(error), chats: [] },
      });
    }
  }

  async handleRescan(
    msg: Extract<SessionInboundMessage, { type: "usage.rescan.request" }>,
  ): Promise<void> {
    try {
      const { scanner } = this.requireLedger();
      const summary = await scanner.scan();
      this.options.emit({
        type: "usage.rescan.response",
        payload: {
          requestId: msg.requestId,
          error: null,
          events: summary.events,
          filesRead: summary.filesRead,
        },
      });
    } catch (error) {
      this.options.emit({
        type: "usage.rescan.response",
        payload: { requestId: msg.requestId, error: errorMessage(error), events: 0, filesRead: 0 },
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
