import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { LayoutTemplate, Plus, Rocket } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { MenuHeader } from "@/components/headers/menu-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { AutomationFormSheet } from "@/components/automations/automation-form-sheet";
import {
  AutomationCompileSheet,
  type CompiledAutomationDraft,
} from "@/components/automations/automation-compile-sheet";
import {
  AutomationsTable,
  type AutomationRowView,
} from "@/components/automations/automations-table";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  useAutomations,
  type AggregateLoadState,
  type AggregatedAutomation,
  type AutomationHostError,
  type AutomationHostInput,
} from "@/hooks/use-automations";
import { useHosts } from "@/runtime/host-runtime";
import {
  resolveAutomation,
  type AutomationBucket,
  type AutomationOriginAgent,
} from "@/automations/automation-derivation";
import { resolveAutomationsScreenBodyState } from "./automations-screen-state";
import {
  buildProjectNameByCwd,
  buildAutomationProjectTargets,
} from "@/automations/automation-project-targets";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "@/automations/automation-templates";
import type { Automation } from "@pimi/protocol/automation/types";

type FormState =
  | { mode: "closed" }
  | { mode: "describe" }
  | { mode: "create"; template?: AutomationTemplate; draft?: CompiledAutomationDraft }
  | { mode: "edit"; serverId: string; automation: Automation };

function formServerId(form: FormState): string | undefined {
  if (form.mode === "edit") {
    return form.serverId;
  }
  return form.mode === "create" ? form.draft?.serverId : undefined;
}

const STATUS_FILTER_OPTIONS: { value: AutomationBucket; label: string; testID: string }[] = [
  { value: "runnable", label: "Active", testID: "automations-filter-active" },
  { value: "ended", label: "Ended", testID: "automations-filter-ended" },
];

const EMPTY_AUTOMATIONS: AggregatedAutomation[] = [];

// Module-scope themed icon so the trigger's `leading` is a stable element.
const ThemedLayoutTemplate = withUnistyles(LayoutTemplate);
const templatesLeading = (
  <ThemedLayoutTemplate
    uniProps={(theme: Theme) => ({ size: theme.iconSize.sm, color: theme.colors.foregroundMuted })}
  />
);

export function AutomationsScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <AutomationsScreenContent />;
}

function AutomationsScreenContent(): ReactElement {
  const { t } = useTranslation();
  const { loadState, hostErrors, connectingHosts, isError, refetch } = useAutomations();
  const automations = loadState.status === "loaded" ? loadState.data : EMPTY_AUTOMATIONS;
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const { projects } = useProjects();
  const hosts = useHosts();
  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [statusFilter, setStatusFilter] = useState<AutomationBucket>("runnable");

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const openCreate = useCallback(
    (template?: AutomationTemplate) => setForm({ mode: "create", template }),
    [],
  );
  const openEdit = useCallback((automation: AggregatedAutomation) => {
    setForm({ mode: "edit", serverId: automation.serverId, automation });
  }, []);
  const closeForm = useCallback(() => setForm({ mode: "closed" }), []);
  const openDescribe = useCallback(() => setForm({ mode: "describe" }), []);
  const openCompiled = useCallback(
    (draft: CompiledAutomationDraft) => setForm({ mode: "create", draft }),
    [],
  );

  const agentsByKey = useMemo(() => {
    const map = new Map<string, AutomationOriginAgent>();
    for (const agent of agents) {
      map.set(`${agent.serverId}:${agent.id}`, { title: agent.title });
    }
    return map;
  }, [agents]);

  const projectNameByCwd = useMemo(
    () => buildProjectNameByCwd(buildAutomationProjectTargets(projects)),
    [projects],
  );

  // Resolve every automation's derived state and target line once, then partition
  // by the host and status filters. Sorted newest-first for a stable order
  // across hosts.
  const resolvedRows = useMemo(() => {
    const now = Date.now();
    return automations.map((automation) => ({
      automation,
      resolved: resolveAutomation({
        automation,
        serverId: automation.serverId,
        now,
        agentsByKey,
        projectNameByCwd,
      }),
    }));
  }, [automations, agentsByKey, projectNameByCwd]);

  const visibleRows = useMemo<AutomationRowView[]>(() => {
    const singleHost = hosts.length <= 1;
    return (
      resolvedRows
        .filter(
          ({ automation, resolved }) =>
            (selectedHost === ALL_HOSTS_OPTION_ID || automation.serverId === selectedHost) &&
            resolved.bucket === statusFilter,
        )
        // Automations waiting for approval first, then newest first.
        .sort(
          (a, b) =>
            Number(b.resolved.state === "pending") - Number(a.resolved.state === "pending") ||
            Date.parse(b.automation.createdAt) - Date.parse(a.automation.createdAt),
        )
        .map(({ automation, resolved }) => ({
          automation,
          projectLabel: resolved.projectLabel,
          provider: resolved.provider,
          originLabel: resolved.originLabel,
          state: resolved.state,
          serverName: automation.serverName,
          singleHost,
        }))
    );
  }, [resolvedRows, selectedHost, statusFilter, hosts.length]);

  const showLoadError = isError && loadState.status !== "loaded";
  const showHostFilter = hosts.length > 1;

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sidebar.sections.automations")} inPimiTitlebar />
      <AutomationsScreenBody
        rows={visibleRows}
        loadState={loadState}
        hostErrors={hostErrors}
        connectingHosts={connectingHosts}
        showLoadError={showLoadError}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        showHostFilter={showHostFilter}
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        onRetry={refetch}
        onCreate={openCreate}
        onDescribe={openDescribe}
        onEdit={openEdit}
      />
      <AutomationCompileSheet
        visible={form.mode === "describe"}
        onClose={closeForm}
        onCompiled={openCompiled}
      />
      <AutomationFormSheet
        serverId={formServerId(form)}
        visible={form.mode === "create" || form.mode === "edit"}
        onClose={closeForm}
        mode={form.mode === "edit" ? "edit" : "create"}
        automation={form.mode === "edit" ? form.automation : undefined}
        template={form.mode === "create" ? form.template : undefined}
        draft={form.mode === "create" ? form.draft?.definition : undefined}
      />
    </View>
  );
}

function AutomationsScreenBody({
  rows,
  loadState,
  hostErrors,
  connectingHosts,
  showLoadError,
  statusFilter,
  onStatusFilterChange,
  showHostFilter,
  hosts,
  selectedHost,
  onSelectHost,
  onRetry,
  onCreate,
  onDescribe,
  onEdit,
}: {
  rows: AutomationRowView[];
  loadState: AggregateLoadState<AggregatedAutomation>;
  hostErrors: AutomationHostError[];
  connectingHosts: AutomationHostInput[];
  showLoadError: boolean;
  statusFilter: AutomationBucket;
  onStatusFilterChange: (value: AutomationBucket) => void;
  showHostFilter: boolean;
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  onRetry: () => void;
  onCreate: (template?: AutomationTemplate) => void;
  onDescribe: () => void;
  onEdit: (automation: AggregatedAutomation) => void;
}): ReactElement {
  const bodyState = resolveAutomationsScreenBodyState({ loadState, showLoadError });

  if (bodyState.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (bodyState.kind === "load-error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Unable to load automations</Text>
        <Button variant="ghost" onPress={onRetry} testID="automations-retry">
          Try again
        </Button>
      </View>
    );
  }

  if (bodyState.kind === "empty") {
    return (
      <View style={styles.centered}>
        {hostErrors.length > 0 ? <AutomationHostErrorsBanner errors={hostErrors} /> : null}
        <AutomationsEmptyState
          onCreate={onCreate}
          onDescribe={onDescribe}
          testID="automations-empty"
        />
        <ConnectingHostsNote hosts={connectingHosts} />
      </View>
    );
  }

  let automationsContent: ReactElement;
  if (rows.length > 0) {
    automationsContent = <AutomationsTable rows={rows} onEditAutomation={onEdit} />;
  } else if (statusFilter === "ended") {
    automationsContent = <AutomationsEndedEmptyState />;
  } else {
    automationsContent = (
      <View style={styles.filterEmpty} testID="automations-empty">
        <Text style={styles.emptyTitle}>No active automations</Text>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.filterRow}>
        <View style={styles.filterRowControls}>
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={onSelectHost}
              triggerTestID="automations-host-filter-trigger"
            />
          ) : null}
          <SegmentedControl
            value={statusFilter}
            onValueChange={onStatusFilterChange}
            options={STATUS_FILTER_OPTIONS}
            testID="automations-status-filter"
          />
        </View>
        <AutomationCreateActions
          onCreate={onCreate}
          onDescribe={onDescribe}
          testID="automations-new"
        />
      </View>
      {connectingHosts.length > 0 ? (
        <View style={styles.connectingNoteRow}>
          <ConnectingHostsNote hosts={connectingHosts} />
        </View>
      ) : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="automations-list"
      >
        {hostErrors.length > 0 ? <AutomationHostErrorsBanner errors={hostErrors} /> : null}
        {automationsContent}
      </ScrollView>
    </View>
  );
}

function AutomationsEmptyState({
  onCreate,
  onDescribe,
  testID,
}: {
  onCreate: (template?: AutomationTemplate) => void;
  onDescribe: () => void;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.emptyState} testID={testID}>
      <Rocket size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <View style={styles.emptyTextStack}>
        <Text style={styles.emptyTitle}>No active automations</Text>
        <Text style={styles.emptyDescription}>
          Give agents a job to run on a schedule, on pull requests, or by hand.
        </Text>
      </View>
      <AutomationCreateActions
        onCreate={onCreate}
        onDescribe={onDescribe}
        testID="automations-empty-new"
      />
    </View>
  );
}

function AutomationCreateActions({
  onCreate,
  onDescribe,
  testID,
}: {
  onCreate: (template?: AutomationTemplate) => void;
  onDescribe: () => void;
  testID: string;
}): ReactElement {
  const openBlank = useCallback(() => onCreate(), [onCreate]);
  return (
    <View style={styles.createActions}>
      <Button variant="ghost" onPress={onDescribe} testID="automations-describe">
        Describe it
      </Button>
      <DropdownMenu>
        <DropdownTrigger
          leading={templatesLeading}
          accessibilityRole="button"
          accessibilityLabel="Templates"
          testID="automation-templates"
        >
          Templates
        </DropdownTrigger>
        <DropdownMenuContent align="end" width={238}>
          <DropdownMenuLabel>Start from a template</DropdownMenuLabel>
          {AUTOMATION_TEMPLATES.map((template) => (
            <AutomationTemplateItem key={template.id} template={template} onCreate={onCreate} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" leftIcon={Plus} onPress={openBlank} testID={testID}>
        New automation
      </Button>
    </View>
  );
}

function AutomationTemplateItem({
  template,
  onCreate,
}: {
  template: AutomationTemplate;
  onCreate: (template: AutomationTemplate) => void;
}): ReactElement {
  const select = useCallback(() => onCreate(template), [onCreate, template]);
  return (
    <DropdownMenuItem description={template.description} onSelect={select}>
      {template.name}
    </DropdownMenuItem>
  );
}

// Saved hosts that never connect (a stale entry, a stopped daemon) would
// otherwise hide behind the spinner; the list loads without them and says so.
function ConnectingHostsNote({ hosts }: { hosts: AutomationHostInput[] }): ReactElement | null {
  if (hosts.length === 0) {
    return null;
  }
  const label = `${hosts.length} ${hosts.length === 1 ? "host" : "hosts"} still connecting`;
  const names = hosts.map((host) => host.serverName).join(", ");
  return (
    <Text
      style={styles.connectingNote}
      accessibilityLabel={`${label}: ${names}`}
      testID="automations-connecting-hosts"
    >
      {`${label} · ${names}`}
    </Text>
  );
}

function AutomationsEndedEmptyState(): ReactElement {
  return (
    <View style={styles.filterEmpty}>
      <View style={styles.endedEmptyState}>
        <Rocket size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
        <Text style={styles.emptyTitle}>No ended automations</Text>
      </View>
    </View>
  );
}

function AutomationHostErrorsBanner({ errors }: { errors: AutomationHostError[] }): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="automations-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {`${error.serverName}: Could not load automations`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  createActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  filterRowControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 1,
    flexWrap: "wrap",
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  connectingNoteRow: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[2],
  },
  connectingNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorsBannerWrap: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  filterEmpty: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  endedEmptyState: {
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyTextStack: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without
  // useUnistyles (banned in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
}));
