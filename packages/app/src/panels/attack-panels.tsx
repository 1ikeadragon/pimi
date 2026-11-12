import { ShieldAlert, Swords } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { AttackControlPanel } from "@/attack/attack-control-panel";
import { AttackFindingsPanel } from "@/attack/attack-findings-panel";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const ThemedSwords = withUnistyles(Swords);
const ThemedShieldAlert = withUnistyles(ShieldAlert);

export const attackControlPanelRegistration = definePanel("attack_control", {
  component: AttackControlPanel,
  presentation: {
    label: (t) => t("attack.panels.control.label"),
    subtitle: (t) => t("attack.panels.control.subtitle"),
    tooltip: (t) => t("attack.panels.control.label"),
    icon: ThemedSwords,
  } satisfies PanelPresentation,
});

export const attackFindingsPanelRegistration = definePanel("attack_findings", {
  component: AttackFindingsPanel,
  presentation: {
    label: (t) => t("attack.panels.findings.label"),
    subtitle: (t) => t("attack.panels.findings.subtitle"),
    tooltip: (t) => t("attack.panels.findings.label"),
    icon: ThemedShieldAlert,
  } satisfies PanelPresentation,
});
