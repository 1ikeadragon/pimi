import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttackAnnotation,
  AttackAnnotationInput,
  AttackAnnotationResult,
} from "@pimi/protocol/attack/types";

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_NOTE = 1000;

function annotationsDir(runsDir: string, runId: string): string {
  if (!SAFE_NAME.test(runId)) throw new Error(`Invalid attack run id: ${runId}`);
  return join(runsDir, runId, "annotations");
}

/**
 * The run's annotations without image bytes. The owner's screenshots go to
 * `<run>/annotations/<label>.jpg`, so run.json and every run push stay small. A label that is not
 * a plain token, or that repeats, cannot name a file and is dropped.
 */
export async function persistAnnotations(
  runsDir: string,
  runId: string,
  inputs: readonly AttackAnnotationInput[],
  clip: (text: string, max: number) => string,
): Promise<AttackAnnotation[]> {
  const seen = new Set<string>();
  const kept: AttackAnnotation[] = [];
  const dir = annotationsDir(runsDir, runId);
  for (const item of inputs) {
    const label = clip(item.label, 16);
    if (!SAFE_NAME.test(label) || seen.has(label)) continue;
    seen.add(label);
    let hasImage = false;
    if (item.imageBase64) {
      const bytes = Buffer.from(item.imageBase64, "base64");
      // JPEG starts with FF D8 FF; anything else is not what the app sends.
      if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, `${label}.jpg`), bytes, { mode: 0o600 });
        hasImage = true;
      }
    }
    kept.push({
      label,
      url: clip(item.url, 2000),
      selector: clip(item.selector, 1000),
      tag: clip(item.tag, 100),
      text: clip(item.text, 400),
      html: clip(item.html, 800),
      note: clip(item.note, 2000),
      hasImage,
    });
  }
  return kept;
}

/** The annotation's screenshot as base64 JPEG, or null when the owner's element had none. */
export async function readAnnotationImage(
  runsDir: string,
  runId: string,
  annotation: AttackAnnotation,
): Promise<string | null> {
  if (!annotation.hasImage || !SAFE_NAME.test(annotation.label)) return null;
  try {
    const bytes = await readFile(join(annotationsDir(runsDir, runId), `${annotation.label}.jpg`));
    return bytes.toString("base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Finds the run's annotation by label, ignoring case and a stray leading "#". */
export function findAnnotation(
  annotations: readonly AttackAnnotation[],
  label: string,
): AttackAnnotation | null {
  const wanted = label.trim().replace(/^#/, "").toUpperCase();
  return annotations.find((item) => item.label.toUpperCase() === wanted) ?? null;
}

/** Labels a finding names, resolved to the run's own spelling; unknown labels are an error. */
export function resolveAnnotationLabels(
  annotations: readonly AttackAnnotation[],
  labels: readonly string[],
): string[] {
  const resolved: string[] = [];
  for (const label of labels) {
    const match = findAnnotation(annotations, label);
    if (!match) {
      const known = annotations.map((item) => item.label).join(", ") || "none";
      throw new Error(`This run has no annotation ${label}. Its annotations: ${known}.`);
    }
    if (!resolved.includes(match.label)) resolved.push(match.label);
  }
  return resolved;
}

export function clipResultNote(result: AttackAnnotationResult): AttackAnnotationResult {
  return {
    result: result.result,
    note: result.note.length > MAX_NOTE ? `${result.note.slice(0, MAX_NOTE)}…` : result.note,
  };
}
