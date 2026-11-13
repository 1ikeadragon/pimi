import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Text, View } from "react-native";
import { BottomSheetScrollView, type BottomSheetScrollViewMethods } from "@gorhom/bottom-sheet";
import { Wrench, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import {
  type ContextBridge,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { ToolCallSheetModal, useToolCallSheetContextBridge } from "@/components/tool-call-sheet";
import { useToolCallExpansionContextBridge } from "@/tool-calls/expansion-context";
import type { Theme } from "@/styles/theme";

interface OverviewToolCallGroupSheetProps {
  visible: boolean;
  summary: string;
  /** Replaces the wrench in the header, e.g. with the mascot while the run is live. */
  icon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}

const SNAP_POINTS = ["60%", "95%"];
const ThemedWrench = withUnistyles(Wrench);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function OverviewToolCallGroupSheet({
  visible,
  summary,
  icon,
  children,
  onClose,
}: OverviewToolCallGroupSheetProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const sheetContextBridge = useToolCallSheetContextBridge();
  const expansionContextBridge = useToolCallExpansionContextBridge();
  const contextBridge = useCallback<ContextBridge>(
    (content) => sheetContextBridge(expansionContextBridge(content)),
    [expansionContextBridge, sheetContextBridge],
  );
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    onClose,
  });

  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  useEffect(() => {
    if (!visible) {
      return;
    }
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [children, scrollToLatest, visible]);

  return (
    <ToolCallSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={SNAP_POINTS}
      index={0}
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backdropOpacity={0.5}
      enablePanDownToClose
    >
      <View style={styles.container} testID="tool-call-group-sheet">
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {icon ?? <ThemedWrench size={16} uniProps={mutedMapping} />}
            <Text
              style={styles.headerTitle}
              numberOfLines={2}
              testID="tool-call-group-sheet-summary"
            >
              {summary}
            </Text>
          </View>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={X}
            onPress={onClose}
            accessibilityLabel={t("common.actions.close")}
            testID="tool-call-group-sheet-close"
          />
        </View>
        <BottomSheetScrollView ref={scrollRef} style={styles.content}>
          <View style={styles.contentContainer}>{children}</View>
        </BottomSheetScrollView>
      </View>
    </ToolCallSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
  },
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flex: 1,
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
}));
