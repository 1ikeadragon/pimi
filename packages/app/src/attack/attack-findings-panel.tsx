import { useCallback, useMemo, useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  type Finding,
  type FindingEvidence,
  type FindingSeverity,
  type FindingStatus,
} from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { usePaneContext } from "@/panels/pane-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { useAttackFindings, useAttackSync, useLatestAttackRun } from "./attack-store";
import { buildFixPrompt } from "./fix-prompt";

const SEVERITIES: readonly FindingSeverity[] = ["blocker", "major", "minor"];

export function AttackFindingsPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId } = usePaneContext();
  useAttackSync(serverId, workspaceId);
  const run = useLatestAttackRun(serverId, workspaceId);
  const findings = useAttackFindings(serverId, run?.id ?? null);
  const grouped = useMemo(() => {
    const bySeverity = new Map<FindingSeverity, Finding[]>();
    for (const finding of findings) {
      const list = bySeverity.get(finding.severity) ?? [];
      list.push(finding);
      bySeverity.set(finding.severity, list);
    }
    for (const list of bySeverity.values()) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return bySeverity;
  }, [findings]);

  let empty: string | null = null;
  if (!run) empty = t("attack.findings.noRun");
  else if (findings.length === 0) {
    empty =
      run.status === "completed" ? t("attack.findings.nothingFound") : t("attack.findings.empty");
  }

  return (
    <ScrollView contentContainerStyle={styles.content} testID="attack-findings-panel">
      {empty ? <Text style={styles.emptyText}>{empty}</Text> : null}
      {run
        ? SEVERITIES.map((severity) => {
            const list = grouped.get(severity);
            if (!list?.length) return null;
            return (
              <View key={severity} style={styles.group} testID={`attack-group-${severity}`}>
                <Text style={styles.groupTitle}>
                  {t(`attack.findings.severity.${severity}`)} · {list.length}
                </Text>
                {list.map((finding) => (
                  <FindingCard key={finding.id} finding={finding} />
                ))}
              </View>
            );
          })
        : null}
    </ScrollView>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const { t } = useTranslation();
  const { serverId, workspaceId, openTab } = usePaneContext();
  const client = useHostRuntimeClient(serverId);
  const run = useLatestAttackRun(serverId, workspaceId);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Finding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onToggle = useCallback(() => {
    setOpen((value) => !value);
    if (open || detail || !client) return;
    client
      .attackFindingGet({ runId: finding.runId, findingId: finding.id })
      .then((payload) => {
        setDetail(payload.finding);
        return payload.finding;
      })
      .catch((caught: unknown) => setError(toErrorMessage(caught)));
  }, [client, detail, finding.id, finding.runId, open]);

  const setStatus = useCallback(
    async (status: FindingStatus) => {
      if (!client) return;
      setBusy(true);
      setError(null);
      try {
        await client.attackFindingUpdate({
          runId: finding.runId,
          findingId: finding.id,
          status,
        });
      } catch (caught) {
        setError(toErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [client, finding.id, finding.runId],
  );

  const onFix = useCallback(async () => {
    if (!client || !run) return;
    setBusy(true);
    setError(null);
    try {
      const slash = run.provider.indexOf("/");
      const provider = slash === -1 ? run.provider : run.provider.slice(0, slash);
      const model = slash === -1 ? undefined : run.provider.slice(slash + 1);
      const agent = await client.createAgent({
        provider,
        ...(model ? { model } : {}),
        cwd: run.cwd,
        workspaceId,
        title: `Fix: ${finding.title}`.slice(0, 120),
        initialPrompt: buildFixPrompt(run, finding),
      });
      await client.attackFindingUpdate({
        runId: finding.runId,
        findingId: finding.id,
        fixAgentId: agent.id,
        status: "triaged",
      });
      openTab({ kind: "agent", agentId: agent.id });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [client, finding, openTab, run, workspaceId]);

  const view = detail ?? finding;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={styles.card} testID={`attack-finding-${finding.id}`}>
      <PressHighlight onPress={onToggle} style={styles.cardHeader} testID="attack-finding-toggle">
        <Chevron size={14} color="gray" />
        <View style={styles.cardTitleBlock}>
          <Text style={styles.cardTitle} numberOfLines={open ? undefined : 2}>
            {finding.title}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {finding.route} · {t(`attack.findings.status.${finding.status}`)}
            {finding.reportCount > 1
              ? ` · ${t("attack.findings.reported", { count: finding.reportCount })}`
              : ""}
          </Text>
        </View>
      </PressHighlight>
      {open ? (
        <View style={styles.cardBody}>
          <Text style={styles.bodyText}>{view.description}</Text>
          <Text style={styles.sectionLabel}>{t("attack.findings.repro")}</Text>
          <Text style={styles.codeText} selectable>
            {view.repro}
          </Text>
          {view.evidence.length > 0 ? (
            <Text style={styles.sectionLabel}>{t("attack.findings.evidence")}</Text>
          ) : null}
          {view.evidence.map((item) => (
            <EvidenceBlock key={evidenceKey(item)} item={item} loaded={detail !== null} />
          ))}
          <View style={styles.actions}>
            <Button
              size="sm"
              variant="default"
              leftIcon={Wrench}
              onPress={onFix as () => void}
              disabled={busy || !run}
              testID="attack-fix-it"
            >
              {t("attack.findings.fixIt")}
            </Button>
            {finding.status !== "triaged" ? (
              <StatusButton
                status="triaged"
                label={t("attack.findings.action.triage")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
            {finding.status !== "dismissed" ? (
              <StatusButton
                status="dismissed"
                label={t("attack.findings.action.dismiss")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
            {finding.status !== "fixed" ? (
              <StatusButton
                status="fixed"
                label={t("attack.findings.action.fixed")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
            {finding.status !== "new" ? (
              <StatusButton
                status="new"
                label={t("attack.findings.action.reopen")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function StatusButton({
  status,
  label,
  busy,
  onSet,
}: {
  status: FindingStatus;
  label: string;
  busy: boolean;
  onSet: (status: FindingStatus) => Promise<void>;
}) {
  const onPress = useCallback(() => void onSet(status), [onSet, status]);
  return (
    <Button
      size="sm"
      variant="ghost"
      onPress={onPress}
      disabled={busy}
      testID={`attack-status-${status}`}
    >
      {label}
    </Button>
  );
}

function evidenceKey(item: FindingEvidence): string {
  return item.kind === "screenshot"
    ? `shot:${item.caption}:${item.width}x${item.height}`
    : `${item.kind}:${item.caption}:${item.excerpt.slice(0, 40)}`;
}

function ScreenshotEvidence({ item }: { item: Extract<FindingEvidence, { kind: "screenshot" }> }) {
  const source = useMemo(
    () => ({ uri: `data:image/png;base64,${item.dataBase64 ?? ""}` }),
    [item.dataBase64],
  );
  const style = useMemo(
    () => [
      styles.screenshot,
      { aspectRatio: item.width > 0 && item.height > 0 ? item.width / item.height : 1.6 },
    ],
    [item.height, item.width],
  );
  return (
    <View style={styles.evidence}>
      <Text style={styles.cardMeta}>{item.caption}</Text>
      <Image source={source} style={style} resizeMode="contain" testID="attack-screenshot" />
    </View>
  );
}

function EvidenceBlock({ item, loaded }: { item: FindingEvidence; loaded: boolean }) {
  const { t } = useTranslation();
  if (item.kind === "screenshot") {
    if (item.dataBase64) return <ScreenshotEvidence item={item} />;
    return (
      <Text style={styles.cardMeta}>
        {loaded ? t("attack.findings.screenshotMissing") : t("attack.findings.screenshotLoading")}
      </Text>
    );
  }
  return (
    <View style={styles.evidence}>
      <Text style={styles.cardMeta}>{item.caption}</Text>
      <Text style={styles.codeText} selectable>
        {item.excerpt}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.spacing[3],
    gap: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  group: {
    gap: theme.spacing[2],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  card: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  cardTitleBlock: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
  },
  cardMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  cardBody: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  bodyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  codeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  evidence: {
    gap: theme.spacing[1],
  },
  screenshot: {
    width: "100%",
    borderRadius: theme.borderRadius.md,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
