import { z } from "zod";

export const PIMI_VISUALIZATION_FENCE = "pimi-chart";

const MAX_POINTS = 36;
const MAX_SERIES = 4;
const MAX_SOURCE_LENGTH = 16_384;

const visualizationSchema = z
  .strictObject({
    type: z.enum(["bar", "line", "area", "pie", "donut"]),
    id: z.string().trim().min(1).max(64).optional(),
    title: z.string().trim().min(1).max(120),
    unit: z.string().trim().min(1).max(24).optional(),
    labels: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_POINTS),
    series: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1).max(64),
          values: z.array(z.number()).min(1).max(MAX_POINTS),
        }),
      )
      .min(1)
      .max(MAX_SERIES),
  })
  .refine(
    ({ labels, series }) =>
      new Set(labels).size === labels.length &&
      new Set(series.map(({ name }) => name)).size === series.length &&
      series.every(({ values }) => values.length === labels.length),
  )
  .refine(
    ({ type, series }) =>
      (type !== "pie" && type !== "donut") ||
      (series.length === 1 &&
        series[0].values.every((value) => value >= 0) &&
        series[0].values.some((value) => value > 0)),
  );

export type ChatVisualization = z.infer<typeof visualizationSchema>;

export function parseChatVisualization(source: string): ChatVisualization | null {
  if (source.length > MAX_SOURCE_LENGTH) return null;
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return null;
  }
  const result = visualizationSchema.safeParse(data);
  return result.success ? result.data : null;
}

export const PIMI_VISUALIZATION_INSTRUCTIONS = [
  `Use a ${PIMI_VISUALIZATION_FENCE} block for interactive bar, line, area, pie, or donut charts. Put only JSON inside the block.`,
  `\`\`\`${PIMI_VISUALIZATION_FENCE}`,
  '{"type":"bar","id":"jobs","title":"Jobs by day","labels":["Mon","Tue"],"series":[{"name":"Jobs","values":[4,7]}]}',
  "```",
  `Use up to ${MAX_POINTS} distinct labels and ${MAX_SERIES} distinctly named series. Give each series one number per label. Add a short unit when useful.`,
  "For pie and donut charts, use one series with nonnegative values and a positive total.",
  "To update a chart within the same reply, send another complete block with the same id. In a new reply, send a new complete block.",
  "Use Mermaid for flow diagrams. Use real values or label the chart as an example.",
].join("\n");
