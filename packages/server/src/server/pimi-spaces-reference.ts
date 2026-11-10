import { NETWORK_PURPOSE } from "@pimi/protocol/network-activity";
import { withNetworkInitiator } from "./network/activity.js";
import { isPimiArxivEmbed } from "@pimi/protocol/pimi-task";
import { SpaceInputError, type SpaceCard } from "./pimi-spaces.js";

const MAX_ATOM_BYTES = 2 * 1024 * 1024;
const TITLE_CACHE_MS = 10 * 60 * 1000;
const titleKey = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const unescapeTitle = (title: string) =>
  title.replace(
    /&(amp|apos|lt|gt|quot);/g,
    (entity) =>
      ({
        "&amp;": "&",
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
      })[entity] ?? entity,
  );

function arxivId(card: SpaceCard): string | null {
  const url = card.kind === "link" && card.embedUrl ? URL.parse(card.embedUrl) : null;
  return url && isPimiArxivEmbed(url) ? url.pathname.slice("/html/".length) : null;
}

async function fetchTitles(ids: string[]): Promise<Map<string, string>> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("id_list", ids.join(","));
  url.searchParams.set("max_results", String(ids.length));
  const response = await withNetworkInitiator(NETWORK_PURPOSE.spaces, () =>
    fetch(url, { redirect: "error", signal: AbortSignal.timeout(4000) }),
  );
  if (!response.ok || !response.body) throw new Error("arXiv metadata is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let xml = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ATOM_BYTES) throw new Error("arXiv metadata exceeded its size limit.");
      xml += decoder.decode(value, { stream: true });
    }
    xml += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const titles = new Map<string, string>();
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/.exec(entry)?.[1];
    const title = /<title>([^<]+)<\/title>/.exec(entry)?.[1];
    if (id && title) {
      const key = titleKey(unescapeTitle(title));
      titles.set(id, key);
      titles.set(id.replace(/v\d+$/, ""), key);
    }
  }
  return titles;
}

export class SpacesReferences {
  private cached?: { key: string; at: number; titles: Promise<Map<string, string>> };

  async find(cards: SpaceCard[], query: string, arxiv: boolean): Promise<SpaceCard[]> {
    const reference = query.replace(/^space:/i, "").toLowerCase();
    const key = titleKey(query);
    const direct = cards.filter(
      (card) =>
        card.id === reference ||
        (!arxiv &&
          card.kind === "note" &&
          key &&
          titleKey(card.text.split(/\r?\n/, 1)[0]) === key) ||
        (card.kind === "link" && card.url === query),
    );
    if (direct.length || !arxiv || !key) return direct;
    const ids = [...new Set(cards.map(arxivId).filter((id) => id !== null))].sort();
    if (!ids.length) return [];
    const setKey = ids.join(",");
    if (this.cached?.key !== setKey || Date.now() - this.cached.at > TITLE_CACHE_MS) {
      const titles = fetchTitles(ids);
      this.cached = { key: setKey, at: Date.now(), titles };
    }
    const titles = await this.cached.titles.catch(() => {
      throw new SpaceInputError(
        "Couldn’t look up arXiv titles. You can use the saved card ID or URL.",
        503,
      );
    });
    return cards.filter((card) => {
      const id = arxivId(card);
      return id !== null && titles.get(id) === key;
    });
  }
}
