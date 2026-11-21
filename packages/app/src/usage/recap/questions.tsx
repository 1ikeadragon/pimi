import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { RecapNarrative, RecapStats } from "@pimi/protocol/recap";
import { useTranslation } from "@/i18n/use-translation";
import { UsageGrid } from "../overview/grid";
import { formatPercent } from "../overview/format";
import { providerLabel } from "../overview/providers";
import { formatCount, formatDay, formatDuration, formatHour, formatHours } from "./format";

interface Question {
  id: string;
  question: string;
  answer: string;
  note?: string;
}

const HOUR_MS = 3_600_000;

function quote(text: string): string {
  return `“${text.replace(/\s+/g, " ").trim()}”`;
}

function useQuestions(stats: RecapStats, narrative: RecapNarrative | null): Question[] {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const n = (value: number) => formatCount(value, locale);
  const questions: Question[] = [];
  if (narrative) {
    questions.push({
      id: "archetype",
      question: t("usageRecap.questions.archetype"),
      answer: narrative.archetype.name,
    });
  }
  questions.push({
    id: "shipped",
    question: t("usageRecap.questions.shipped"),
    answer: `+${n(stats.linesAdded)} −${n(stats.linesRemoved)}`,
    note: t("usageRecap.questions.shippedNote", {
      files: t("usageRecap.units.files", { count: stats.filesChanged }),
      tasks: t("usageRecap.units.tasksDone", { count: stats.doneTasks }),
    }),
  });
  questions.push({
    id: "parallel",
    question: t("usageRecap.questions.parallel"),
    answer: t("usageRecap.questions.parallelValue", { count: stats.peakParallel }),
    note: t("usageRecap.questions.parallelNote", {
      agents: t("usageRecap.units.agentsRan", { count: stats.agents }),
      subagents: t("usageRecap.units.subagents", { count: stats.subagents }),
    }),
  });
  const [topModel] = stats.models;
  if (topModel) {
    questions.push({
      id: "model",
      question: t("usageRecap.questions.model"),
      answer: topModel.model,
      note: `${providerLabel(topModel.provider)} · ${t("usageRecap.questions.modelNote", {
        percent: formatPercent(topModel.prompts / stats.prompts, locale),
      })}`,
    });
  }
  if (narrative) {
    questions.push({
      id: "relationship",
      question: t("usageRecap.questions.relationship"),
      answer: narrative.relationship,
    });
  }
  if (stats.longestRun) {
    questions.push({
      id: "longest",
      question: t("usageRecap.questions.longestRun"),
      answer: formatDuration(stats.longestRun.ms),
      note: stats.longestRun.title ?? t("usageRecap.sections.untitled"),
    });
  }
  if (stats.chats > 0) {
    questions.push({
      id: "plan",
      question: t("usageRecap.questions.plan"),
      answer: formatPercent(stats.plannedChats / stats.chats, locale),
      note: t("usageRecap.questions.planNote", {
        planned: n(stats.plannedChats),
        chats: t("usageRecap.units.chats", { count: stats.chats }),
      }),
    });
  }
  if (stats.peakHour !== null) {
    questions.push({
      id: "hour",
      question: t("usageRecap.questions.hour"),
      answer: t("usageRecap.questions.hourValue", { hour: formatHour(stats.peakHour, locale) }),
    });
  }
  if (stats.goToPrompt) {
    questions.push({
      id: "goTo",
      question: t("usageRecap.questions.goTo"),
      answer: quote(stats.goToPrompt.text),
      note: t("usageRecap.questions.goToNote", { count: stats.goToPrompt.count }),
    });
  }
  if (stats.busiestDay) {
    questions.push({
      id: "day",
      question: t("usageRecap.questions.day"),
      answer: formatDay(stats.busiestDay.day, locale),
      note: t("usageRecap.units.prompts", { count: stats.busiestDay.prompts }),
    });
  }
  questions.push({
    id: "polite",
    question: t("usageRecap.questions.polite"),
    answer: t("usageRecap.questions.politeValue", { count: stats.thanks }),
  });
  if (stats.avgPromptWords !== null) {
    questions.push({
      id: "length",
      question: t("usageRecap.questions.length"),
      answer: t("usageRecap.questions.lengthValue", { count: Math.round(stats.avgPromptWords) }),
    });
  }
  if (stats.shortestPrompt) {
    questions.push({
      id: "shortest",
      question: t("usageRecap.questions.shortest"),
      answer: quote(stats.shortestPrompt),
    });
  }
  if (stats.chats > 0) {
    questions.push({
      id: "talk",
      question: t("usageRecap.questions.talk"),
      answer: t("usageRecap.questions.talkValue", {
        count: Math.round((stats.prompts / stats.chats) * 10) / 10,
      }),
      note: t("usageRecap.questions.talkNote", {
        prompts: t("usageRecap.units.prompts", { count: stats.prompts }),
        chats: t("usageRecap.units.chats", { count: stats.chats }),
      }),
    });
  }
  // Plural agrees with the number as shown, so 0.96 hours reads "1 hour".
  const oneHour = formatHours(HOUR_MS, locale);
  const activeHours = formatHours(stats.activeMs, locale);
  const agentHours = formatHours(stats.agentMs, locale);
  questions.push({
    id: "time",
    question: t("usageRecap.questions.time"),
    answer: t("usageRecap.questions.timeValue", {
      hours: activeHours,
      count: activeHours === oneHour ? 1 : 2,
    }),
    note: t("usageRecap.questions.timeNote", {
      agentHours,
      count: agentHours === oneHour ? 1 : 2,
    }),
  });
  return questions;
}

/** Paxel-style question cards: a question, a big answer, one line of evidence. */
export function RecapQuestions({
  stats,
  narrative,
}: {
  stats: RecapStats;
  narrative: RecapNarrative | null;
}) {
  const questions = useQuestions(stats, narrative);
  return (
    <UsageGrid minColumn={220} maxColumns={3} gap={8} testID="recap-questions">
      {questions.map((item) => (
        <View key={item.id} style={styles.tile} testID={`recap-question-${item.id}`}>
          <Text style={styles.question}>{item.question}</Text>
          <Text style={styles.answer} numberOfLines={2}>
            {item.answer}
          </Text>
          {item.note ? (
            <Text style={styles.note} numberOfLines={2}>
              {item.note}
            </Text>
          ) : null}
        </View>
      ))}
    </UsageGrid>
  );
}

const styles = StyleSheet.create((theme) => ({
  tile: {
    flex: 1,
    gap: theme.spacing[1],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
  },
  question: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  answer: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
