// Pimi addition to the Paseo fork. Apache-2.0.
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { z } from "zod";
import { parsePimiSpaceUrl, pimiSpaceEmbed } from "@pimi/protocol/pimi-task";
import { writePrivateFileAtomic } from "./private-files.js";
import { SpacesSearch } from "./pimi-spaces-search.js";

const MAX_CARDS = 200;
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
  | { kind: "link"; url: string; embedUrl: string | null }
);

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
    return this.searchIndex.search(await this.list(), query, limit);
  }

  private async card(file: ItemFile): Promise<SpaceCard> {
    const updatedAt = (await stat(file.path)).mtime.toISOString();
    if (file.mime) return { id: file.id, updatedAt, kind: "image", mime: file.mime };
    const text = await readFile(file.path, "utf8");
    if (!file.link) return { id: file.id, updatedAt, kind: "note", text };
    const url = parsePimiSpaceUrl(text);
    if (!url) throw new SpaceInputError("This card contains an invalid link.");
    return { id: file.id, updatedAt, kind: "link", url: url.href, embedUrl: pimiSpaceEmbed(url) };
  }

  async read(id: string) {
    const file = (await this.files()).find((entry) => entry.id === id);
    if (!file) return null;
    try {
      const item = await this.card(file);
      return item.kind === "image"
        ? { ...item, data: (await readFile(file.path)).toString("base64") }
        : item;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  addNote(text: string) {
    const url = parsePimiSpaceUrl(text.trim());
    return url ? this.add(url.href, null, true) : this.add(text, null);
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
      if (file) await rm(file.path, { force: true });
    });
  }
}
