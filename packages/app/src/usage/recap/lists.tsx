import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { RecapStats } from "@pimi/protocol/recap";
import { DensityIcon } from "@/components/ui/density-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useTasks, type AggregatedTask } from "@/hooks/use-tasks";
import { useTranslation } from "@/i18n/use-translation";
import { pushPimiTask } from "@/navigation/pimi-tasks";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { UsageGrid } from "../overview/grid";
import type { RecapRange } from "./period";
import { formatDuration } from "./format";

const SHIPPED_PAGE_SIZE = 100;

type RecapChat = RecapStats["topChats"][number];

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ChatRow({ serverId, chat }: { serverId: string; chat: RecapChat }) {
  const { t } = useTranslation();
  const { agentId, workspaceId } = chat;
  const open = useCallback(
    () => navigateToAgent({ serverId, agentId, workspaceId }),
    [agentId, serverId, workspaceId],
  );
  const note = [
    chat.project,
    t("usageRecap.sections.chatNote", {
      prompts: t("usageRecap.units.prompts", { count: chat.prompts }),
      time: formatDuration(chat.agentMs),
    }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <PressHighlight
      style={styles.row}
      highlightStyle={styles.highlight}
      accessibilityRole="button"
      onPress={open}
      testID="recap-chat-row"
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {chat.title ?? t("usageRecap.sections.untitled")}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {note}
        </Text>
      </View>
      <DensityIcon icon={ChevronRight} size="sm" color="foregroundMuted" />
    </PressHighlight>
  );
}

/** The chats with the most prompts, and the projects the period's prompts went to. */
export function RecapWork({ serverId, stats }: { serverId: string; stats: RecapStats }) {
  const { t } = useTranslation();
  return (
    <UsageGrid minColumn={320} maxColumns={2} gap={16} testID="recap-work">
      <Card key="chats" title={t("usageRecap.sections.chats")}>
        <View>
          {stats.topChats.map((chat) => (
            <ChatRow key={chat.agentId} serverId={serverId} chat={chat} />
          ))}
        </View>
      </Card>
      <Card key="projects" title={t("usageRecap.sections.projects")}>
        <View>
          {stats.projects.map((project) => (
            <View key={project.project} style={styles.row}>
              <Text style={[styles.rowTitle, styles.rowText]} numberOfLines={1}>
                {project.project}
              </Text>
              <Text style={styles.muted}>
                {t("usageRecap.sections.projectNote", {
                  chats: t("usageRecap.units.chats", { count: project.chats }),
                  prompts: t("usageRecap.units.prompts", { count: project.prompts }),
                })}
              </Text>
            </View>
          ))}
        </View>
      </Card>
    </UsageGrid>
  );
}

function TaskRow({ task }: { task: AggregatedTask }) {
  const { i18n } = useTranslation();
  const open = useCallback(() => pushPimiTask(task.serverId, task.id), [task.id, task.serverId]);
  return (
    <PressHighlight
      style={styles.row}
      highlightStyle={styles.highlight}
      accessibilityRole="button"
      onPress={open}
    >
      <Text style={[styles.rowTitle, styles.rowText]} numberOfLines={2}>
        {task.title}
      </Text>
      <Text style={styles.muted}>
        {new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: "short", day: "numeric" }).format(
          new Date(task.completedAt ?? task.updatedAt),
        )}
      </Text>
      <DensityIcon icon={ChevronRight} size="sm" color="foregroundMuted" />
    </PressHighlight>
  );
}

/** Tasks on this host marked done in the period, newest first. */
export function RecapShipped({ serverId, range }: { serverId: string; range: RecapRange }) {
  const { t } = useTranslation();
  const { loadState } = useTasks();
  const done = useMemo(() => {
    if (loadState.status !== "loaded") return [];
    const inPeriod = loadState.data.filter((task) => {
      if (task.serverId !== serverId || task.status !== "done" || !task.completedAt) return false;
      const at = Date.parse(task.completedAt);
      return at >= range.startMs && at < range.endMs;
    });
    return inPeriod.sort(
      (a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""),
    );
  }, [loadState, range.endMs, range.startMs, serverId]);
  const shown = done.slice(0, SHIPPED_PAGE_SIZE);
  return (
    <Card title={t("usageRecap.sections.shipped")}>
      <View testID="recap-shipped">
        {shown.length > 0 ? (
          shown.map((task) => <TaskRow key={task.id} task={task} />)
        ) : (
          <Text style={styles.muted}>{t("usageRecap.sections.noTasks")}</Text>
        )}
        {shown.length < done.length ? (
          <Text style={[styles.muted, styles.more]}>
            {t("usageRecap.sections.moreTasks", { shown: shown.length, total: done.length })}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  highlight: { backgroundColor: theme.colors.surface2 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  more: { paddingTop: theme.spacing[2] },
}));
