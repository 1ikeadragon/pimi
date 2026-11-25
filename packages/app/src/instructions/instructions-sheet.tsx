import { useMemo } from "react";
import type { InstructionsTarget } from "@pimi/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { useTranslation } from "@/i18n/use-translation";
import { InstructionsList } from "./instructions-list";
import { useInstructions } from "./use-instructions";

interface InstructionsSheetProps {
  serverId: string;
  /** The agent whose launch layers to list; `null` while no agent is in focus. */
  agentId: string | null;
  visible: boolean;
  /** A sheet over a route that is not focused would stack above the route that is. */
  isRouteFocused: boolean;
  onClose: () => void;
}

export function InstructionsSheet({
  serverId,
  agentId,
  visible,
  isRouteFocused,
  onClose,
}: InstructionsSheetProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("instructions.title") }), [t]);
  const isOpen = visible && isRouteFocused;
  const target = useMemo<InstructionsTarget | null>(
    () => (isOpen && agentId !== null ? { kind: "agent", agentId } : null),
    [agentId, isOpen],
  );
  const query = useInstructions(serverId, target);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={isOpen}
      onClose={onClose}
      testID="instructions-sheet"
      desktopMaxWidth={640}
    >
      <InstructionsList query={query} testID="instructions-sheet-list" />
    </AdaptiveModalSheet>
  );
}
