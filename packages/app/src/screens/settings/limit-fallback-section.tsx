import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LIMIT_FALLBACK_MAX_CHAIN, type MutableDaemonConfig } from "@pimi/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { PimiModelControls, type PimiModelChoice } from "@/screens/settings/pimi-model-row";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

type LimitFallback = MutableDaemonConfig["limitFallback"];
type ChainEntry = LimitFallback["chain"][number];

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedRemove = withUnistyles(X);
const ThemedPlus = withUnistyles(Plus);
const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeIcon = <ThemedRemove size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const plusIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

function toEntry(choice: PimiModelChoice): ChainEntry {
  return { provider: choice.provider, ...(choice.model ? { model: choice.model } : {}) };
}

/** Entries have no ids and may repeat, so a key is the entry plus how many equal ones came first. */
function chainRowKeys(chain: readonly ChainEntry[]): string[] {
  const seen = new Map<string, number>();
  return chain.map((entry) => {
    const base = `${entry.provider}\u0000${entry.model ?? ""}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}\u0000${count}`;
  });
}

/**
 * "On limit": the host-wide switch and the ordered list of models a chat continues on when its
 * provider reports a limit. The daemon owns the behavior; this only edits `limitFallback`.
 */
export function LimitFallbackSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // An empty slot at the end of the list, filled by the first model the user picks.
  const [adding, setAdding] = useState(false);

  const saved = config?.limitFallback;
  const save = useCallback(
    async (next: LimitFallback) => {
      setIsSaving(true);
      setSaveError(null);
      try {
        await patchConfig({ limitFallback: next });
      } catch (error) {
        setSaveError(
          `${t("settings.providers.limitFallback.saveError")}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig, t],
  );

  const handleEnabled = useCallback(
    (enabled: boolean) => {
      if (saved) void save({ ...saved, enabled });
    },
    [save, saved],
  );
  const handleChange = useCallback(
    (index: number, choice: PimiModelChoice) => {
      if (!saved) return;
      void save({
        ...saved,
        chain: saved.chain.map((entry, at) => (at === index ? toEntry(choice) : entry)),
      });
    },
    [save, saved],
  );
  const handleAddChoice = useCallback(
    (choice: PimiModelChoice) => {
      if (!saved) return;
      setAdding(false);
      void save({ ...saved, chain: [...saved.chain, toEntry(choice)] });
    },
    [save, saved],
  );
  const handleMove = useCallback(
    (index: number, direction: -1 | 1) => {
      if (!saved) return;
      const chain = [...saved.chain];
      const [moved] = chain.splice(index, 1);
      if (!moved) return;
      chain.splice(index + direction, 0, moved);
      void save({ ...saved, chain });
    },
    [save, saved],
  );
  const handleRemove = useCallback(
    (index: number) => {
      if (saved) void save({ ...saved, chain: saved.chain.filter((_, at) => at !== index) });
    },
    [save, saved],
  );
  const handleStartAdd = useCallback(() => setAdding(true), []);
  const handleCancelAdd = useCallback(() => setAdding(false), []);

  const info = useMemo(() => t("settings.providers.limitFallback.info"), [t]);
  if (!isConnected || !saved) return null;

  const chain = saved.chain;
  const atMax = chain.length >= LIMIT_FALLBACK_MAX_CHAIN;
  const rowKeys = chainRowKeys(chain);
  let addHint = "";
  if (atMax) {
    addHint = t("settings.providers.limitFallback.full", { max: LIMIT_FALLBACK_MAX_CHAIN });
  } else if (chain.length === 0) {
    addHint = t("settings.providers.limitFallback.empty");
  }
  return (
    <SettingsSection
      title={t("settings.providers.limitFallback.title")}
      info={info}
      testID="host-page-limit-fallback"
    >
      <SettingsCard>
        <SettingsRow
          label={t("settings.providers.limitFallback.enableTitle")}
          hint={t("settings.providers.limitFallback.enableHint")}
          error={saveError ?? undefined}
          testID="limit-fallback-enabled-row"
        >
          <Switch
            value={saved.enabled}
            disabled={isSaving}
            onValueChange={handleEnabled}
            accessibilityLabel={t("settings.providers.limitFallback.enableTitle")}
            testID="limit-fallback-enabled"
          />
        </SettingsRow>
        {saved.enabled
          ? chain.map((entry, index) => (
              <ChainRow
                key={rowKeys[index]}
                index={index}
                count={chain.length}
                entry={entry}
                serverId={serverId}
                snapshot={snapshot}
                disabled={isSaving}
                onChange={handleChange}
                onMove={handleMove}
                onRemove={handleRemove}
              />
            ))
          : null}
        {saved.enabled && adding ? (
          <SettingsRow
            label={t("settings.providers.limitFallback.entry", { n: chain.length + 1 })}
            testID="limit-fallback-new-row"
          >
            <View style={styles.rowControls}>
              <PimiModelControls
                label={t("settings.providers.limitFallback.entry", { n: chain.length + 1 })}
                serverId={serverId}
                snapshot={snapshot}
                value={null}
                placeholder={t("settings.providers.limitFallback.selectModel")}
                onChange={handleAddChoice}
                withoutThinking
                disabled={isSaving}
                testID="limit-fallback-new"
              />
              <Button
                variant="ghost"
                leftIcon={removeIcon}
                onPress={handleCancelAdd}
                accessibilityLabel={t("settings.providers.limitFallback.remove")}
                testID="limit-fallback-new-cancel"
              />
            </View>
          </SettingsRow>
        ) : null}
        {saved.enabled && !adding ? (
          <View style={[settingsStyles.row, styles.addRow]}>
            <Text style={settingsStyles.rowHint}>{addHint}</Text>
            <Button
              size="sm"
              variant="outline"
              leftIcon={plusIcon}
              disabled={atMax || isSaving}
              onPress={handleStartAdd}
              testID="limit-fallback-add"
            >
              {t("settings.providers.limitFallback.add")}
            </Button>
          </View>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function ChainRow({
  index,
  count,
  entry,
  serverId,
  snapshot,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  entry: ChainEntry;
  serverId: string;
  snapshot: ReturnType<typeof useProvidersSnapshot>;
  disabled: boolean;
  onChange: (index: number, choice: PimiModelChoice) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  const label = t("settings.providers.limitFallback.entry", { n: index + 1 });
  const handleChange = useCallback(
    (choice: PimiModelChoice) => onChange(index, choice),
    [index, onChange],
  );
  const handleUp = useCallback(() => onMove(index, -1), [index, onMove]);
  const handleDown = useCallback(() => onMove(index, 1), [index, onMove]);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <SettingsRow label={label} testID={`limit-fallback-row-${index}`}>
      <View style={styles.rowControls}>
        <PimiModelControls
          label={label}
          serverId={serverId}
          snapshot={snapshot}
          value={entry}
          placeholder={t("settings.providers.limitFallback.selectModel")}
          onChange={handleChange}
          withoutThinking
          disabled={disabled}
          testID={`limit-fallback-entry-${index}`}
        />
        <Button
          variant="ghost"
          leftIcon={moveUpIcon}
          onPress={handleUp}
          disabled={disabled || index === 0}
          accessibilityLabel={t("settings.providers.limitFallback.moveUp")}
          testID={`limit-fallback-up-${index}`}
        />
        <Button
          variant="ghost"
          leftIcon={moveDownIcon}
          onPress={handleDown}
          disabled={disabled || index === count - 1}
          accessibilityLabel={t("settings.providers.limitFallback.moveDown")}
          testID={`limit-fallback-down-${index}`}
        />
        <Button
          variant="ghost"
          leftIcon={removeIcon}
          onPress={handleRemove}
          disabled={disabled}
          accessibilityLabel={t("settings.providers.limitFallback.remove")}
          testID={`limit-fallback-remove-${index}`}
        />
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  addRow: {
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
}));
