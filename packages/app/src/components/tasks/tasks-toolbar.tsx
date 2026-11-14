import { Columns3, Plus, Rows3, Tags } from "lucide-react-native";
import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Label } from "@pimi/protocol/labels";
import { HostFilter } from "@/components/hosts/host-filter";
import type { HostPickerHost } from "@/components/hosts/host-picker";
import { LabelColorDot } from "@/components/tasks/task-group-heading";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useTranslation } from "@/i18n/use-translation";
import type { Theme } from "@/styles/theme";
import {
  labelFilterValue,
  type TaskBucket,
  type TaskGroupBy,
  type TaskViewMode,
} from "@/tasks/task-view-model";

const ThemedTags = withUnistyles(Tags);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const tagsLeading = <ThemedTags size={14} uniProps={mutedMapping} />;
const GROUP_BY_VALUES: readonly TaskGroupBy[] = ["status", "label", "none"];

export interface LabelFilterOption {
  serverId: string;
  hostLabel: string;
  label: Label;
}

export interface TasksToolbarProps {
  hosts: readonly HostPickerHost[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  viewMode: TaskViewMode;
  onViewModeChange: (mode: TaskViewMode) => void;
  bucket: TaskBucket;
  onBucketChange: (bucket: TaskBucket) => void;
  groupBy: TaskGroupBy;
  onGroupByChange: (groupBy: TaskGroupBy) => void;
  labelOptions: readonly LabelFilterOption[];
  labelFilter: readonly string[];
  onLabelFilterChange: (next: string[]) => void;
  onNewTask: () => void;
}

function renderListIcon({ color, size }: { color: string; size: number }): ReactElement {
  return <Rows3 color={color} size={size} />;
}

function renderBoardIcon({ color, size }: { color: string; size: number }): ReactElement {
  return <Columns3 color={color} size={size} />;
}

/**
 * The filter row, Automations' shape: host, open/done, label filter and grouping on the left; the
 * list/board toggle and New task on the right. It wraps on compact widths. Open/done and grouping
 * belong to the list; the board always shows its three columns.
 */
export function TasksToolbar(props: TasksToolbarProps): ReactElement {
  const { t } = useTranslation();
  const { viewMode } = props;
  const viewOptions = useMemo(
    () => [
      {
        value: "list" as const,
        label: t("tasks.view.list"),
        icon: renderListIcon,
        testID: "tasks-view-list",
      },
      {
        value: "board" as const,
        label: t("tasks.view.board"),
        icon: renderBoardIcon,
        testID: "tasks-view-board",
      },
    ],
    [t],
  );
  const bucketOptions = useMemo(
    () => [
      { value: "open" as const, label: t("tasks.filter.open"), testID: "tasks-filter-open" },
      { value: "done" as const, label: t("tasks.filter.done"), testID: "tasks-filter-done" },
    ],
    [t],
  );
  return (
    <View style={styles.row}>
      <View style={styles.controls}>
        {props.hosts.length > 1 ? (
          <HostFilter
            hosts={props.hosts as HostPickerHost[]}
            selectedHost={props.selectedHost}
            onSelectHost={props.onSelectHost}
            triggerTestID="tasks-host-filter-trigger"
          />
        ) : null}
        {viewMode === "list" ? (
          <SegmentedControl
            value={props.bucket}
            onValueChange={props.onBucketChange}
            options={bucketOptions}
            testID="tasks-status-filter"
          />
        ) : null}
        <LabelFilterMenu
          options={props.labelOptions}
          selected={props.labelFilter}
          onChange={props.onLabelFilterChange}
          showHost={props.hosts.length > 1}
        />
        {viewMode === "list" ? (
          <GroupByMenu value={props.groupBy} onChange={props.onGroupByChange} />
        ) : null}
      </View>
      <View style={styles.controls}>
        <SegmentedControl
          value={viewMode}
          onValueChange={props.onViewModeChange}
          options={viewOptions}
          hideLabels
          accessibilityLabel={t("tasks.view.accessibility")}
          testID="tasks-view-toggle"
        />
        <Button variant="outline" leftIcon={Plus} onPress={props.onNewTask} testID="tasks-new">
          {t("tasks.newTask")}
        </Button>
      </View>
    </View>
  );
}

function GroupByItem({
  value,
  selected,
  onChange,
}: {
  value: TaskGroupBy;
  selected: boolean;
  onChange: (value: TaskGroupBy) => void;
}): ReactElement {
  const { t } = useTranslation();
  const select = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      onSelect={select}
      testID={`tasks-group-by-${value}`}
    >
      {t(`tasks.groupBy.${value}`)}
    </DropdownMenuItem>
  );
}

function GroupByMenu({
  value,
  onChange,
}: {
  value: TaskGroupBy;
  onChange: (value: TaskGroupBy) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownTrigger
        accessibilityRole="button"
        accessibilityLabel={t("tasks.groupBy.menuTitle")}
        testID="tasks-group-by"
      >
        {`${t("tasks.groupBy.menuTitle")}: ${t(`tasks.groupBy.${value}`)}`}
      </DropdownTrigger>
      <DropdownMenuContent align="start" width={200}>
        <DropdownMenuLabel>{t("tasks.groupBy.menuTitle")}</DropdownMenuLabel>
        {GROUP_BY_VALUES.map((group) => (
          <GroupByItem key={group} value={group} selected={group === value} onChange={onChange} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelFilterItem({
  option,
  selected,
  showHost,
  onToggle,
}: {
  option: LabelFilterOption;
  selected: boolean;
  showHost: boolean;
  onToggle: (value: string) => void;
}): ReactElement {
  const value = labelFilterValue(option.serverId, option.label.id);
  const select = useCallback(() => onToggle(value), [onToggle, value]);
  const leading = useMemo(() => <LabelColorDot color={option.label.color} />, [option.label.color]);
  return (
    <DropdownMenuItem
      leading={leading}
      selected={selected}
      showSelectedCheck
      closeOnSelect={false}
      description={showHost ? option.hostLabel : undefined}
      onSelect={select}
      testID={`tasks-label-filter-${option.label.id}`}
    >
      {option.label.name}
    </DropdownMenuItem>
  );
}

function LabelFilterMenu({
  options,
  selected,
  onChange,
  showHost,
}: {
  options: readonly LabelFilterOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  showHost: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const toggle = useCallback(
    (value: string) =>
      onChange(
        selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
      ),
    [onChange, selected],
  );
  const title =
    selected.length === 0
      ? t("tasks.labelFilter.all")
      : t("tasks.labelFilter.count", { count: selected.length });
  return (
    <DropdownMenu>
      <DropdownTrigger
        leading={tagsLeading}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.labelFilter.title")}
        testID="tasks-label-filter"
      >
        {title}
      </DropdownTrigger>
      <DropdownMenuContent align="start" width={240}>
        <DropdownMenuLabel>{t("tasks.labelFilter.title")}</DropdownMenuLabel>
        {options.length === 0 ? (
          <DropdownMenuItem disabled muted>
            {t("tasks.labelFilter.empty")}
          </DropdownMenuItem>
        ) : (
          options.map((option) => (
            <LabelFilterItem
              key={labelFilterValue(option.serverId, option.label.id)}
              option={option}
              selected={selected.includes(labelFilterValue(option.serverId, option.label.id))}
              showHost={showHost}
              onToggle={toggle}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    flexShrink: 1,
  },
}));
