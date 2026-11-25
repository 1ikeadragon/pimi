import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { InstructionLayer, InstructionsResult } from "@pimi/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { formatSize, isQuietLayer, layerTitle, statusVariant } from "./model";

interface InstructionsListProps {
  query: {
    data: InstructionsResult | undefined;
    error: Error | null;
    isPending: boolean;
  };
  testID: string;
}

export function InstructionsList({ query, testID }: InstructionsListProps) {
  const { t } = useTranslation();
  const [showMissing, setShowMissing] = useState(false);
  const toggleMissing = useCallback(() => setShowMissing((value) => !value), []);

  if (query.error) {
    return (
      <Alert
        size="sm"
        variant="error"
        testID={`${testID}-error`}
        title={t("instructions.loadFailed")}
        description={query.error.message}
      />
    );
  }
  if (query.isPending || !query.data) {
    return <LoadingSpinner color={styles.spinnerColor.color} />;
  }

  const result = query.data;
  const missingCount = result.layers.filter(isQuietLayer).length;
  const visibleLayers = showMissing ? result.layers : result.layers.filter((l) => !isQuietLayer(l));

  return (
    <View testID={testID} style={styles.stack}>
      <Text style={settingsStyles.rowHint}>
        {t("instructions.summary", {
          ruleset: t(`instructions.ruleset.${result.ruleset}`),
          version: result.providerVersion ?? t("instructions.versionUnknown"),
        })}
      </Text>
      {result.ruleset === "unknown" ? (
        <Alert
          size="sm"
          variant="warning"
          title={t("instructions.unknownRuleset.title")}
          description={t("instructions.unknownRuleset.description")}
        />
      ) : null}
      {result.truncated ? (
        <Alert
          size="sm"
          variant="warning"
          testID={`${testID}-truncated`}
          title={t("instructions.truncated.title")}
          description={t("instructions.truncated.description")}
        />
      ) : null}
      {result.notices.map((notice) => (
        <Alert
          key={`${notice.code}:${notice.path ?? ""}`}
          size="sm"
          variant="warning"
          title={t(`instructions.notice.${notice.code}`)}
          description={notice.path ?? undefined}
        />
      ))}
      <View style={settingsStyles.card}>
        {visibleLayers.map((layer, index) => (
          <LayerRow key={layer.id} layer={layer} isFirst={index === 0} />
        ))}
        {visibleLayers.length === 0 ? (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("instructions.empty")}</Text>
          </View>
        ) : null}
      </View>
      {missingCount > 0 ? (
        <Button variant="ghost" onPress={toggleMissing} testID={`${testID}-toggle-missing`}>
          {showMissing
            ? t("instructions.hideMissing")
            : t("instructions.showMissing", { count: missingCount })}
        </Button>
      ) : null}
    </View>
  );
}

function LayerRow({ layer, isFirst }: { layer: InstructionLayer; isFirst: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const hasPreview = layer.preview !== null;
  const accessibilityState = useMemo(
    () => (hasPreview ? { expanded } : undefined),
    [expanded, hasPreview],
  );

  const details = useMemo(() => {
    const parts: string[] = [t(`instructions.scope.${layer.scope}`)];
    if (layer.reason) parts.push(t(`instructions.reason.${layer.reason}`));
    if (layer.sizeBytes !== null) parts.push(formatSize(layer.sizeBytes));
    if (layer.importedBy) parts.push(t("instructions.importedBy", { path: layer.importedBy }));
    if (layer.symlinkTarget) parts.push(t("instructions.symlink", { path: layer.symlinkTarget }));
    if (layer.path !== null && !layer.insideWorkspace && layer.origin === "provider") {
      parts.push(t("instructions.outsideWorkspace"));
    }
    return parts.join(" · ");
  }, [layer, t]);

  return (
    <View style={isFirst ? undefined : settingsStyles.rowBorder} testID={`instruction-${layer.id}`}>
      <PressHighlight
        accessibilityRole={hasPreview ? "button" : undefined}
        accessibilityState={accessibilityState}
        disabled={!hasPreview}
        onPress={toggle}
        style={settingsStyles.row}
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle} numberOfLines={2}>
            {layerTitle(layer, t)}
          </Text>
          <Text style={settingsStyles.rowHint}>{details}</Text>
        </View>
        <StatusBadge
          size="xs"
          label={t(`instructions.status.${layer.status}`)}
          variant={statusVariant(layer.status)}
        />
      </PressHighlight>
      {expanded && layer.preview !== null ? (
        <View style={styles.preview}>
          <Text selectable style={styles.previewText}>
            {layer.preview}
          </Text>
          {layer.previewTruncated ? (
            <Text style={settingsStyles.rowHint}>{t("instructions.previewTruncated")}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[3],
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  preview: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  previewText: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
