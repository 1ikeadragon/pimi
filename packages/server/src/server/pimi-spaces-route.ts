// Pimi. Apache-2.0.
import type { RequestHandler } from "express";
import { PIMI_SPACE_IMAGE_BYTES } from "@pimi/protocol/pimi-task";
import { z } from "zod";
import {
  SpaceImageType,
  SpaceInputError,
  SpaceItemId,
  SpaceNote,
  SpaceSearchQuery,
  type PimiSpaces,
} from "./pimi-spaces.js";
import { SpacesReferences } from "./pimi-spaces-reference.js";

const imageSignatures = {
  "image/png": (bytes: Buffer) =>
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  "image/jpeg": (bytes: Buffer) => bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
  "image/webp": (bytes: Buffer) =>
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
};

function decodePastedImage(data: string, mime: z.infer<typeof SpaceImageType>): Buffer {
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length > PIMI_SPACE_IMAGE_BYTES ||
    bytes.toString("base64") !== data ||
    !imageSignatures[mime](bytes)
  ) {
    throw new SpaceInputError("Paste a valid PNG, JPEG or WebP image up to 4 MB.");
  }
  return bytes;
}

const input = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("search"), query: SpaceSearchQuery }),
  z.strictObject({ action: z.literal("preview-link"), id: SpaceItemId }),
  z.strictObject({
    action: z.literal("find-reference"),
    query: SpaceSearchQuery,
    arxiv: z.boolean(),
  }),
  z.strictObject({ action: z.literal("add-note"), text: SpaceNote }),
  z.strictObject({ action: z.literal("edit-note"), id: SpaceItemId, text: SpaceNote }),
  z.strictObject({ action: z.literal("remove"), id: SpaceItemId }),
  z.strictObject({ action: z.literal("image"), id: SpaceItemId }),
  z.strictObject({
    action: z.literal("add-image"),
    mime: SpaceImageType,
    data: z.string().max(4 * Math.ceil(PIMI_SPACE_IMAGE_BYTES / 3)),
  }),
]);

export function createPimiSpacesHandler(
  spaces: PimiSpaces,
  reportError: (error: unknown) => void,
): RequestHandler {
  const references = new SpacesReferences();
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const parsed = input.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Enter a note or paste a PNG, JPEG or WebP image up to 4 MB." });
      return;
    }
    const body = parsed.data;
    try {
      switch (body.action) {
        case "list":
          res.json({ items: await spaces.list() });
          return;
        case "search": {
          const result = await spaces.search(body.query);
          res.json({
            items: result.items.map(({ card }) => card),
            mode: result.mode,
            unindexedLinks: result.unindexedLinks,
          });
          return;
        }
        case "preview-link": {
          const item = await spaces.read(body.id);
          if (item?.kind !== "link") throw new SpaceInputError("This link no longer exists.", 404);
          res.json({ item });
          return;
        }
        case "find-reference": {
          const matches = await references.find(await spaces.list(), body.query, body.arxiv);
          res.json({
            items: matches.map(({ id, kind }) => ({ id, kind })),
            reference: matches.length === 1 ? matches[0] : undefined,
          });
          return;
        }
        case "add-note":
          res.json({ item: await spaces.addNote(body.text) });
          return;
        case "edit-note":
          res.json({ item: await spaces.editNote(body.id, body.text) });
          return;
        case "remove":
          await spaces.remove(body.id);
          res.json({ removed: true });
          return;
        case "image": {
          const item = await spaces.read(body.id);
          if (item?.kind !== "image")
            throw new SpaceInputError("This image no longer exists.", 404);
          res.json({ mime: item.mime, data: item.data });
          return;
        }
        case "add-image": {
          res.json({
            item: await spaces.addImage(decodePastedImage(body.data, body.mime), body.mime),
          });
        }
      }
    } catch (error) {
      if (error instanceof SpaceInputError) {
        res.status(error.status).json({ error: error.message });
      } else {
        reportError(error);
        res.status(500).json({ error: "Spaces couldn’t read or save this card. Try again." });
      }
    }
  };
}
