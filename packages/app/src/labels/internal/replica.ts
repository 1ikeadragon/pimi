import { labelTargetKey, type Label, type LabelTarget } from "@pimi/protocol/labels";
import type { LabelListPayload } from "@pimi/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@pimi/protocol/messages";

type LabelUpdateMessage = Extract<SessionOutboundMessage, { type: "label.update" }>;

export interface LabelReplicaSnapshot {
  labels: Label[];
  /** `labelTargetKey` -> label ids, in assignment order. Absent means no labels. */
  assignments: Record<string, readonly string[]>;
}

/**
 * One host's catalog and assignment map. The daemon pushes whole facts (an upsert, a removal, a
 * target's full label set), so there is no cursor to gap-check: a reconnect re-subscribes and
 * `applyList` replaces everything.
 */
export class HostLabelReplica {
  private labels = new Map<string, Label>();
  private assignments = new Map<string, readonly string[]>();

  snapshot(): LabelReplicaSnapshot {
    return { labels: [...this.labels.values()], assignments: Object.fromEntries(this.assignments) };
  }

  applyList(payload: LabelListPayload): void {
    this.labels = new Map(payload.labels.map((label) => [label.id, label]));
    this.assignments = new Map();
    for (const assignment of payload.assignments) this.setAssignment(assignment);
  }

  applyUpdate(message: LabelUpdateMessage): void {
    const update = message.payload;
    switch (update.kind) {
      case "label_upsert":
        this.labels.set(update.label.id, update.label);
        return;
      case "label_remove":
        this.labels.delete(update.labelId);
        for (const [key, ids] of this.assignments) {
          if (ids.includes(update.labelId))
            this.assignments.set(
              key,
              ids.filter((id) => id !== update.labelId),
            );
        }
        return;
      case "assignment_set":
        this.setAssignment({ target: update.target, labelIds: update.labelIds });
        return;
    }
  }

  private setAssignment(input: { target: LabelTarget; labelIds: readonly string[] }): void {
    const key = labelTargetKey(input.target);
    if (input.labelIds.length === 0) this.assignments.delete(key);
    else this.assignments.set(key, input.labelIds);
  }
}
