// Pimi. Apache-2.0.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { endianness } from "node:os";
import { z } from "zod";

const VOCAB_SIZE = 29_528;
const DIMENSIONS = 64;
const MATRIX_BYTES = VOCAB_SIZE * DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
const MAX_TOKENS = 512;
// Bound tokenization before WordPiece runs, including for notes with very long words.
const MAX_INPUT_CODE_UNITS = 16_384;
const MODEL_DIGEST = "f95ffde02ad06f63ae38eb9d400038cd5ccaf8411ec3cb650c6025113f96cbb8";
const TOKENIZER_DIGEST = "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50";

const matrixHeader = z.strictObject({
  embeddings: z.strictObject({
    dtype: z.literal("F32"),
    shape: z.tuple([z.literal(VOCAB_SIZE), z.literal(DIMENSIONS)]),
    data_offsets: z.tuple([z.literal(0), z.literal(MATRIX_BYTES)]),
  }),
});

export interface SpacesEmbedder {
  embed(text: string): Float32Array | null;
}

async function readAsset(name: string, digest: string): Promise<Buffer> {
  const bytes = await readFile(new URL(`./pimi-spaces-embedding-assets/${name}`, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error(`Bundled Spaces embedding asset failed integrity check (${name}).`);
  }
  return bytes;
}

function readEmbeddingMatrix(bytes: Buffer): Float32Array {
  const headerOffset = 8;
  if (bytes.length <= headerOffset + MATRIX_BYTES) {
    throw new Error("Invalid bundled Spaces embedding matrix length.");
  }
  const headerBytes = bytes.length - headerOffset - MATRIX_BYTES;
  if (bytes.readBigUInt64LE(0) !== BigInt(headerBytes)) {
    throw new Error("Invalid bundled Spaces embedding matrix header length.");
  }
  const matrixOffset = headerOffset + headerBytes;
  matrixHeader.parse(JSON.parse(bytes.toString("utf8", headerOffset, matrixOffset)));
  const matrix = bytes.subarray(matrixOffset);
  if (endianness() === "BE") matrix.swap32();
  return new Float32Array(matrix.buffer, matrix.byteOffset, VOCAB_SIZE * DIMENSIONS);
}

async function createSpacesEmbedder(): Promise<SpacesEmbedder> {
  const [weights, tokenizerJson, { Tokenizer }] = await Promise.all([
    readAsset("model.safetensors", MODEL_DIGEST),
    readAsset("tokenizer.json", TOKENIZER_DIGEST),
    import("@huggingface/tokenizers"),
  ]);
  const matrix = readEmbeddingMatrix(weights);
  const tokenizer = new Tokenizer(JSON.parse(tokenizerJson.toString("utf8")), {});
  const unknownId = tokenizer.token_to_id("[UNK]");
  if (unknownId !== 1 || tokenizer.get_vocab().size !== VOCAB_SIZE) {
    throw new Error("Bundled Spaces tokenizer does not match the embedding matrix.");
  }

  return {
    embed(text) {
      const input = text.slice(0, MAX_INPUT_CODE_UNITS).trim();
      if (!input) return null;
      const { ids } = tokenizer.encode(input, { add_special_tokens: false });
      const sum = new Float64Array(DIMENSIONS);
      for (const id of ids.slice(0, MAX_TOKENS)) {
        if (id === unknownId) continue;
        if (!Number.isInteger(id) || id < 0 || id >= VOCAB_SIZE) return null;
        const offset = id * DIMENSIONS;
        for (let dimension = 0; dimension < DIMENSIONS; dimension += 1) {
          sum[dimension] += matrix[offset + dimension];
        }
      }
      // A normalized sum has the same direction as the normalized mean.
      const norm = Math.hypot(...sum);
      return norm > 0 && Number.isFinite(norm)
        ? Float32Array.from(sum, (value) => value / norm)
        : null;
    },
  };
}

let embedder: Promise<SpacesEmbedder> | undefined;

export function loadSpacesEmbedder(): Promise<SpacesEmbedder> {
  return (embedder ??= createSpacesEmbedder());
}
