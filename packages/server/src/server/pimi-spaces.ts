// Pimi addition to the Paseo fork. Apache-2.0.
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { z } from "zod";
import { parsePimiSpaceUrl, pimiSpaceEmbed } from "@pimi/protocol/pimi-task";
import { writePrivateFileAtomic } from "./private-files.js";
import { SpacesSearch } from "./pimi-spaces-search.js";
import { fetchSpaceLinkPreview, SpaceLinkPreview } from "./pimi-space-link-preview.js";

const MAX_CARDS = 200;
const PREVIEW_TIMEOUT_MS = 4_000;
const PREVIEW_RETRY_MS = 5 * 60_000;
export const SpaceItemId = z.uuid();
export const SpaceNote = z.string().max(65536).regex(/\S/, "Enter a note.");
export const SpaceSearchQuery = z.string().trim().min(1).max(160);
export const SpaceImageType = z.enum(["image/png", "image/jpeg", "image/webp"]);
type ImageType = z.infer<typeof SpaceImageType>;

const imageExtensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} satisfies Record<ImageType, string>;
const imageTypes = new Map(
  Object.entries(imageExtensions).map(([mime, ext]) => [ext, mime as ImageType]),
);

interface ItemFile {
  id: string;
  path: string;
  mime: ImageType | null;
  link: boolean;
}
export type SpaceCard = { id: string; updatedAt: string } & (
  | { kind: "note"; text: string }
  | { kind: "image"; mime: ImageType }
  | { kind: "link"; url: string; embedUrl: string | null; preview?: SpaceLinkPreview }
);
type LinkCard = Extract<SpaceCard, { kind: "link" }>;

export class SpaceInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class PimiSpaces {
  private readonly root: string;
  private readonly serialize = pLimit(1);
  private readonly listIO = pLimit(8);
  private readonly previewIO = pLimit(4);
  private readonly previews = new Map<string, Promise<SpaceLinkPreview | null>>();
  private readonly previewRetries = new Map<string, number>();
  private readonly searchIndex = new SpacesSearch();

  constructor(paseoHome: string) {
    this.root = path.join(paseoHome, "spaces");
  }

  private async files(): Promise<ItemFile[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    return entries.flatMap((entry) => {
      if (!entry.isFile()) return [];
      const [id, ext, extra] = entry.name.split(".");
      const mime = imageTypes.get(ext);
      if (
        extra !== undefined ||
        !SpaceItemId.safeParse(id).success ||
        (!["txt", "link"].includes(ext) && !mime)
      )
        return [];
      return [
        { id, path: path.join(this.root, entry.name), mime: mime ?? null, link: ext === "link" },
      ];
    });
  }

  async list(): Promise<SpaceCard[]> {
    return this.serialize(async () => {
      const files = await this.files();
      const items = await Promise.all(files.map((file) => this.listIO(() => this.card(file))));
      return items.sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
    });
  }

  async search(query: string, limit = MAX_CARDS) {
    const cards = await this.list();
    const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
    const indexed = await Promise.all(
      cards.map((card) => (card.kind === "link" ? this.previewLink(card, signal) : card)),
    );
    const result = await this.searchIndex.search(indexed, query, limit);
    return {
      ...result,
      unindexedLinks: indexed.filter((card) => card.kind === "link" && !card.preview).length,
      excerptedLinks: indexed.filter((card) => card.kind === "link" && card.preview?.truncated)
        .length,
    };
  }

  private async card(file: ItemFile): Promise<SpaceCard> {
    const updatedAt = (await stat(file.path)).mtime.toISOString();
    if (file.mime) return { id: file.id, updatedAt, kind: "image", mime: file.mime };
    const text = await readFile(file.path, "utf8");
    if (!file.link) return { id: file.id, updatedAt, kind: "note", text };
    const url = parsePimiSpaceUrl(text);
    if (!url) throw new SpaceInputError("This card contains an invalid link.");
    const preview = await this.readPreview(file.id);
    return {
      id: file.id,
      updatedAt,
      kind: "link",
      url: url.href,
      embedUrl: pimiSpaceEmbed(url),
      ...(preview && { preview }),
    };
  }

  private previewPath(id: string): string {
    return path.join(this.root, `${id}.preview.json`);
  }

  private async readPreview(id: string): Promise<SpaceLinkPreview | null> {
    try {
      const result = SpaceLinkPreview.safeParse(
        JSON.parse(await readFile(this.previewPath(id), "utf8")),
      );
      return result.success ? result.data : null;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      throw error;
    }
  }

  private async previewLink(
    card: LinkCard,
    signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
  ): Promise<LinkCard> {
    if (card.preview || signal.aborted || Date.now() < (this.previewRetries.get(card.id) ?? 0))
      return card;
    let pending = this.previews.get(card.id);
    if (!pending) {
      pending = this.previewIO(async () => {
        if (signal.aborted) return null;
        const preview = await fetchSpaceLinkPreview(new URL(card.url), card.embedUrl, signal).catch(
          () => null,
        );
        return this.serialize(async () => {
          const savedUrl = await readFile(path.join(this.root, `${card.id}.link`), "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (savedUrl !== card.url) return null;
          if (preview)
            await writePrivateFileAtomic(this.previewPath(card.id), JSON.stringify(preview));
          else this.previewRetries.set(card.id, Date.now() + PREVIEW_RETRY_MS);
          return preview;
        });
      })
        // The URL has already been saved. A failed optional preview must not
        // make the caller retry the card creation or hide other search results.
        .catch(() => null)
        .finally(() => this.previews.delete(card.id));
      this.previews.set(card.id, pending);
    }
    const preview = await pending;
    return preview ? { ...card, preview } : card;
  }

  async read(id: string) {
    const file = (await this.files()).find((entry) => entry.id === id);
    if (!file) return null;
    try {
      const item = await this.card(file);
      if (item.kind === "image")
        return { ...item, data: (await readFile(file.path)).toString("base64") };
      return item.kind === "link" ? await this.previewLink(item) : item;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async addNote(text: string) {
    const url = parsePimiSpaceUrl(text.trim());
    const card = url ? await this.add(url.href, null, true) : await this.add(text, null);
    return card.kind === "link" ? this.previewLink(card) : card;
  }

  addImage(data: Buffer, mime: ImageType) {
    return this.add(data, mime);
  }

  private add(data: string | Buffer, mime: ImageType | null, link = false) {
    return this.serialize(async () => {
      if ((await this.files()).length >= MAX_CARDS) {
        throw new SpaceInputError(
          `Spaces holds up to ${MAX_CARDS} cards. Remove a card to add another.`,
          409,
        );
      }
      const id = randomUUID();
      const extension = mime ? imageExtensions[mime] : "txt";
      const file = {
        id,
        path: path.join(this.root, `${id}.${link ? "link" : extension}`),
        mime,
        link,
      };
      await writePrivateFileAtomic(file.path, data);
      return this.card(file);
    });
  }

  editNote(id: string, text: string) {
    return this.serialize(async () => {
      const file = (await this.files()).find(
        (entry) => entry.id === id && entry.mime === null && !entry.link,
      );
      if (!file) throw new SpaceInputError("This note no longer exists.", 404);
      await writePrivateFileAtomic(file.path, text);
      return this.card(file);
    });
  }

  remove(id: string) {
    return this.serialize(async () => {
      const file = (await this.files()).find((entry) => entry.id === id);
      if (!file) return;
      await rm(file.path, { force: true });
      if (file.link) {
        await rm(this.previewPath(id), { force: true });
        this.previewRetries.delete(id);
      }
    });
  }
}
