import { z } from "zod";

export const PIMI_VISUALIZATION_FENCE = "pimi-chart";

const MAX_POINTS = 36;
const MAX_SERIES = 4;
const MAX_SOURCE_LENGTH = 16_384;

const visualizationSchema = z
  .strictObject({
    type: z.enum(["bar", "line"]),
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

export const PIMI_VISUALIZATION_INSTRUCTIONS =
  `When a chart helps answer the user, put JSON in a fenced ${PIMI_VISUALIZATION_FENCE} block. Example: ` +
  '{"type":"bar","title":"Jobs by day","labels":["Mon","Tue"],"series":[{"name":"Jobs","values":[4,7]}]}. ' +
  `Use bar or line, up to ${MAX_POINTS} distinct labels and ${MAX_SERIES} distinctly named series. Each series needs one number per label. Add a short unit if useful. When data changes within a reply, reuse an optional short id on complete chart snapshots to update the first chart in place. Across replies, emit a complete updated chart; earlier replies remain historical snapshots. Do not emit JavaScript, CSS, or animation instructions inside chart JSON; Pimi animates supported charts and respects reduced motion. Use Mermaid for flow diagrams. Use real data or label it as an example.`;
