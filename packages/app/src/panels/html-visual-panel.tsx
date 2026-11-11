import { Text, View } from "react-native";
import { invariant } from "@/utils/invariant";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AppWindow } from "lucide-react-native";
import { FileHtmlPreview } from "@/file-panels/html-preview";
import { htmlPreviewTheme } from "@/file-panels/html-preview-theme";
import { readHtmlVisual } from "@/html-visuals/store";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const ThemedHtmlPreview = withUnistyles(FileHtmlPreview);
const ThemedAppWindow = withUnistyles(AppWindow);

/** An inline chat visual at full size, in the same sandbox and theme as in the chat. */
function HtmlVisualPanel() {
  const { target } = usePaneContext();
  invariant(target.kind === "html_visual", "HtmlVisualPanel requires html_visual target");
  const visual = readHtmlVisual(target.visualId);
  if (!visual) {
    return (
      <View style={styles.missing} testID="html-visual-missing">
        <Text style={styles.message}>Open this visual again from its chat.</Text>
      </View>
    );
  }
  return (
    <View style={styles.container} testID="html-visual-panel">
      <ThemedHtmlPreview
        html={visual.html}
        title={target.title}
        testID="html-visual-preview"
        uniProps={htmlPreviewTheme}
      />
    </View>
  );
}

function useHtmlVisualPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "html_visual" }>,
): PanelDescriptor {
  return {
    label: target.title,
    subtitle: "Visual",
    tooltip: target.title,
    titleState: "ready",
    icon: ThemedAppWindow,
    statusBucket: null,
  };
}

export const htmlVisualPanelRegistration = definePanel("html_visual", {
  component: HtmlVisualPanel,
  useDescriptor: useHtmlVisualPanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
