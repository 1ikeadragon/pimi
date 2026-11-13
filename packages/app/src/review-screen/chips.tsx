// Pimi. Apache-2.0.
// Stream S2: the state, review and checks chips shared by the rail rows and the detail header.
import { useTranslation } from "@/i18n/use-translation";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";

type State = "open" | "closed" | "merged";
type Decision = "approved" | "changes_requested" | "pending";
type Checks = "none" | "pending" | "success" | "failure";

interface ChipProps {
  size?: "sm" | "xs";
}

export function StateChip({
  state,
  isDraft,
  size,
}: ChipProps & { state: State; isDraft: boolean }) {
  const { t } = useTranslation();
  if (state === "open" && isDraft) {
    return <StatusBadge size={size} variant="muted" label={t("reviewScreen.draft")} />;
  }
  const variant: StatusBadgeVariant = state === "open" ? "success" : "muted";
  const labels = {
    open: t("reviewScreen.stateOpen"),
    merged: t("reviewScreen.stateMerged"),
    closed: t("reviewScreen.stateClosed"),
  };
  const label = labels[state];
  return <StatusBadge size={size} variant={variant} label={label} />;
}

export function DecisionChip({ decision, size }: ChipProps & { decision: Decision | null }) {
  const { t } = useTranslation();
  if (decision === "approved") {
    return <StatusBadge size={size} variant="success" label={t("reviewScreen.decisionApproved")} />;
  }
  if (decision === "changes_requested") {
    return <StatusBadge size={size} variant="error" label={t("reviewScreen.decisionChanges")} />;
  }
  if (decision === "pending") {
    return <StatusBadge size={size} variant="muted" label={t("reviewScreen.decisionPending")} />;
  }
  return null;
}

export function ChecksChip({ status, size }: ChipProps & { status: Checks | null }) {
  const { t } = useTranslation();
  if (status === "success") {
    return <StatusBadge size={size} variant="success" label={t("reviewScreen.checksSuccess")} />;
  }
  if (status === "failure") {
    return <StatusBadge size={size} variant="error" label={t("reviewScreen.checksFailure")} />;
  }
  if (status === "pending") {
    return <StatusBadge size={size} variant="warning" label={t("reviewScreen.checksPending")} />;
  }
  return null;
}
