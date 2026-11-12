// Pimi. Apache-2.0.
import { setImmediate } from "node:timers/promises";
import { loadSpacesEmbedder, type SpacesEmbedder } from "./pimi-spaces-embeddings.js";
import type { SpaceCard } from "./pimi-spaces.js";

// The embedding helper admits up to 512 tokens per call. Keep chunks below
// that bound even for short tokens and overlap phrase boundaries.
const CHUNK_STEP = 432;
const CHUNK_OVERLAP = 80;
const SEMANTIC_MATCH = 0.32;

type SearchableCard = Extract<SpaceCard, { kind: "note" | "link" }>;
interface Chunk {
  offset: number;
  vector: Float32Array;
}
interface Entry {
  content: string;
  chunks: Promise<Chunk[]>;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let i = 0; i < left.length; i++) score += left[i] * right[i];
  return score;
}

async function indexCard(content: string, embedder: SpacesEmbedder): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for (let offset = 0; offset < content.length; offset += CHUNK_STEP) {
    const vector = embedder.embed(content.slice(offset, offset + CHUNK_STEP + CHUNK_OVERLAP));
    if (vector) chunks.push({ offset, vector });
    // Keep long notes from blocking unrelated daemon work.
    await setImmediate();
  }
  return chunks;
}

function bestChunk(chunks: Chunk[], query: Float32Array | null) {
  let score = 0;
  let offset = 0;
  if (query) {
    for (const chunk of chunks) {
      const similarity = cosine(query, chunk.vector);
      if (similarity <= score) continue;
      score = similarity;
      offset = chunk.offset;
    }
  }
  return { score, offset };
}

export class SpacesSearch {
  private readonly entries = new Map<string, Entry>();
  private embedder?: Promise<SpacesEmbedder | null>;

  async search(cards: SpaceCard[], query: string, limit: number) {
    const liveIds = new Set(cards.map((card) => card.id));
    for (const id of this.entries.keys()) {
      if (!liveIds.has(id)) this.entries.delete(id);
    }

    // Boards still support keyword search when the installation has no model asset.
    const embedder = await (this.embedder ??= loadSpacesEmbedder().catch(() => null));
    const queryVector = embedder?.embed(query) ?? null;
    const terms = query.toLowerCase().split(/\s+/);
    const matches: { card: SearchableCard; excerpt: string; exact: boolean; score: number }[] = [];

    for (const card of cards) {
      if (card.kind === "image") continue;
      const content =
        card.kind === "note"
          ? card.text
          : [card.preview?.title, card.preview?.text, card.url].filter(Boolean).join("\n");
      const normalized = content.toLowerCase();
      const exact = terms.every((term) => normalized.includes(term));
      let chunks: Chunk[] = [];
      if (queryVector && embedder) {
        let entry = this.entries.get(card.id);
        if (entry?.content !== content) {
          entry = { content, chunks: indexCard(content, embedder) };
          this.entries.set(card.id, entry);
        }
        chunks = await entry.chunks;
      }
      const { score, offset } = bestChunk(chunks, queryVector);
      if (!exact && score < SEMANTIC_MATCH) continue;
      const start = exact ? Math.max(0, normalized.indexOf(terms[0]) - 40) : offset;
      matches.push({ card, excerpt: content.slice(start, start + 240), exact, score });
    }

    matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
    return {
      mode: queryVector ? "hybrid" : "keyword",
      totalMatches: matches.length,
      items: matches.slice(0, limit).map(({ card, excerpt }) => ({ card, excerpt })),
    };
  }
}
