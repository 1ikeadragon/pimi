import type { Logger } from "pino";
import { RecapNarrativeSchema, type Recap, type RecapNarrative } from "@pimi/protocol/recap";
import { z } from "zod";
import { SqlRecordStore } from "../db/sql-record-store.js";
import { generateRecapNarrative, type RecapNarrativeDeps } from "./narrative.js";
import { computeRecap, type RecapRange, type RecapSources } from "./stats.js";

const StoredNarrativeSchema = RecapNarrativeSchema.extend({ id: z.string() });
type StoredNarrative = z.infer<typeof StoredNarrativeSchema>;

// A written narrative is kept per period so reopening Recap does not pay for the model again.
function narrativeId(range: RecapRange): string {
  return `${range.startMs}_${range.endMs}`;
}

function withoutId(stored: StoredNarrative): RecapNarrative {
  const { id: _id, ...narrative } = stored;
  return narrative;
}

export class RecapService {
  private readonly narratives: SqlRecordStore<StoredNarrative>;
  // One model call per period at a time; a second Generate joins the first.
  private readonly writing = new Map<string, Promise<RecapNarrative>>();

  constructor(
    private readonly options: {
      sources: RecapSources;
      narrative: RecapNarrativeDeps;
      logger: Logger;
    },
  ) {
    this.narratives = new SqlRecordStore({
      database: options.sources.pimiDatabase,
      kind: "recap_narrative",
      schema: StoredNarrativeSchema,
      logger: options.logger,
      label: "recap narrative",
    });
  }

  async get(range: RecapRange): Promise<Recap> {
    const { stats } = await computeRecap(this.options.sources, range);
    const stored = await this.narratives.get(narrativeId(range));
    return { stats, narrative: stored ? withoutId(stored) : null };
  }

  writeNarrative(range: RecapRange): Promise<RecapNarrative> {
    const id = narrativeId(range);
    const running = this.writing.get(id);
    if (running) return running;
    const job = (async () => {
      const computation = await computeRecap(this.options.sources, range);
      const narrative = await generateRecapNarrative({
        deps: this.options.narrative,
        computation,
        range,
      });
      await this.narratives.put({ id, ...narrative });
      return narrative;
    })().finally(() => this.writing.delete(id));
    this.writing.set(id, job);
    return job;
  }
}
