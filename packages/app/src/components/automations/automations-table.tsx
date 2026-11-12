import { useCallback, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AutomationRow, type AutomationRowPending } from "@/components/automations/automation-row";
import { useAutomationMutations } from "@/hooks/use-automation-mutations";
import type { AggregatedAutomation } from "@/hooks/use-automations";
import type { AutomationDerivedState } from "@/automations/automation-derivation";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveAutomationTitle } from "@/utils/automation-format";

/** An automation plus the client-derived fields the row renders. */
export interface AutomationRowView {
  automation: AggregatedAutomation;
  projectLabel: string;
  provider: string | null;
  originLabel: string | null;
  state: AutomationDerivedState;
  serverName: string;
  /** True when only one host exists, so the host name is redundant in rows. */
  singleHost: boolean;
}

interface AutomationsTableProps {
  rows: AutomationRowView[];
  /**
   * The form sheet is owned by the screen (it serves both create and edit and
   * shares the screen's "New automation" button), so the table delegates edit
   * upward rather than mounting a second sheet here.
   */
  onEditAutomation: (automation: AggregatedAutomation) => void;
}

/**
 * The automations list: a single settings-style card of rows across every
 * connected host, in a full-width list matching the History screen. Rows own
 * their host-scoped mutations (pause/resume/run/delete via the mutations hook +
 * a destructive confirm) and delegate editing upward.
 */
export function AutomationsTable({ rows, onEditAutomation }: AutomationsTableProps): ReactElement {
  return (
    <View style={styles.listContent} testID="automations-table">
      <View style={settingsStyles.card}>
        {rows.map((row, index) => (
          <AutomationsTableRow
            key={`${row.automation.serverId}:${row.automation.id}`}
            row={row}
            isFirst={index === 0}
            onEditAutomation={onEditAutomation}
          />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Per-row wrapper owns local in-flight state and binds mutations to this
// automation's host. Local state keeps pending precise to the acting row even
// when several rows are acted on at once (the mutations hook exposes only a
// single global pending flag per action).
// ---------------------------------------------------------------------------

const NO_PENDING: AutomationRowPending = {};

function AutomationsTableRow({
  row,
  isFirst,
  onEditAutomation,
}: {
  row: AutomationRowView;
  isFirst: boolean;
  onEditAutomation: (automation: AggregatedAutomation) => void;
}): ReactElement {
  const { automation } = row;
  const { id, serverId } = automation;
  const mutations = useAutomationMutations({ serverId });
  const [pending, setPending] = useState<AutomationRowPending>(NO_PENDING);

  const runAction = useCallback(
    async (key: keyof AutomationRowPending, action: () => Promise<void>): Promise<void> => {
      setPending((current) => ({ ...current, [key]: true }));
      try {
        await action();
      } catch {
        // Mutations roll back their own optimistic cache writes on error and
        // re-fetch on settle; surfacing per-row toasts here is out of scope.
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  const handleEdit = useCallback(() => {
    onEditAutomation(automation);
  }, [onEditAutomation, automation]);

  const handlePause = useCallback(() => {
    void runAction("pause", () => mutations.pauseAutomation(id));
  }, [runAction, mutations, id]);

  const handleResume = useCallback(() => {
    void runAction("resume", () => mutations.resumeAutomation(id));
  }, [runAction, mutations, id]);

  const handleApprove = useCallback(() => {
    void runAction("approve", () => mutations.approveAutomation(id));
  }, [runAction, mutations, id]);

  const handleRunNow = useCallback(() => {
    void runAction("runNow", async () => {
      await mutations.runAutomationNow(id);
    });
  }, [runAction, mutations, id]);

  const handleDelete = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: "Delete automation",
        message: `Delete "${resolveAutomationTitle(automation)}"? This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await runAction("delete", () => mutations.deleteAutomation(id));
    })();
  }, [runAction, mutations, id, automation]);

  return (
    <AutomationRow
      serverId={row.automation.serverId}
      automation={automation}
      projectLabel={row.projectLabel}
      provider={row.provider}
      originLabel={row.originLabel}
      state={row.state}
      serverName={row.serverName}
      singleHost={row.singleHost}
      isFirst={isFirst}
      pending={pending}
      onEdit={handleEdit}
      onPause={handlePause}
      onResume={handleResume}
      onApprove={handleApprove}
      onRunNow={handleRunNow}
      onDelete={handleDelete}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Full-width list padding matching the History screen.
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
}));
