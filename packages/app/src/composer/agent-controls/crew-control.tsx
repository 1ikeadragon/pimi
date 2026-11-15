import { useCallback, useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Users } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { CrewSheet } from "@/composer/agent-controls/crew-sheet";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { useTranslation } from "@/i18n/use-translation";

export interface CrewControlValue {
  /** The host whose Crew tier profiles the popover edits. */
  serverId: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}

/**
 * Crew mode for one chat: a control beside the mode that opens the Crew popover, where Crew turns
 * on or off and each crew member's model is chosen. On, the chat's own model leads and can hand
 * work to the Crew thinker, worker and chore.
 */
export function CrewControl({
  serverId,
  enabled,
  onChange,
  disabled = false,
  surface = "toolbar",
}: CrewControlValue & { surface?: "toolbar" | "sheet" }) {
  const { t } = useTranslation();
  const { presentation } = useComposerControlLayout();
  const [open, setOpen] = useState(false);
  const handlePress = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const state = enabled ? t("agentControls.features.on") : t("agentControls.features.off");
  const trigger = (
    <AgentControlTrigger
      icon={Users}
      iconColor={enabled ? styles.on.color : undefined}
      surface={surface}
      label={t("agentControls.crew.label")}
      value={surface === "sheet" ? state : undefined}
      showToolbarLabel={presentation.showModeLabel}
      open={surface === "toolbar" && (open || enabled)}
      disabled={disabled}
      onPress={handlePress}
      accessibilityLabel={`${t("agentControls.crew.label")}: ${state}`}
      testID="crew-control"
    />
  );
  const sheet = (
    <CrewSheet
      visible={open}
      onClose={handleClose}
      serverId={serverId}
      enabled={enabled}
      onChange={onChange}
      disabled={disabled}
      presentation={surface === "sheet" ? "push" : undefined}
    />
  );
  if (surface === "sheet") {
    return (
      <>
        {trigger}
        {sheet}
      </>
    );
  }
  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          {trigger}
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>
            {enabled ? t("agentControls.crew.hintOn") : t("agentControls.crew.hintOff")}
          </Text>
        </TooltipContent>
      </Tooltip>
      {sheet}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  on: {
    color: theme.colors.accent,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
