export const PLUGIN_BACKDROP_IMAGE_MAX_BYTES = 512 * 1024;
export const PLUGIN_BACKDROP_VIDEO_MAX_BYTES = 8 * 1024 * 1024;
export const PLUGIN_BACKDROP_SHADER_MAX_BYTES = 32 * 1024;

/** What the plugin compiler produces for a webp, png or jpg import. */
export const PLUGIN_BACKDROP_IMAGE_DATA_URL =
  /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
/** What the plugin compiler produces for an mp4 or webm import. */
export const PLUGIN_BACKDROP_VIDEO_DATA_URL =
  /^data:video\/(?:mp4|webm);base64,[A-Za-z0-9+/]+={0,2}$/;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** The MIME type of a webp, png or jpg file, or null for anything else. */
export function backdropImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const riff = startsWith(bytes, [0x52, 0x49, 0x46, 0x46]);
  return riff && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8) ? "image/webp" : null;
}

/** The MIME type of an mp4 or webm file, or null for anything else. */
export function backdropVideoMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return "video/mp4"; // "ftyp"
  return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) ? "video/webm" : null; // EBML header
}

/**
 * Why Pimi refuses this file as a backdrop image, or null when it is a webp, png or jpg within the
 * size cap. The plugin compiler applies it to every image a plugin client imports.
 */
export function findBackdropImageProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength > PLUGIN_BACKDROP_IMAGE_MAX_BYTES) return "exceeds 512 KiB";
  return backdropImageMime(bytes) ? null : "not a webp, png, or jpg image";
}

/** Why Pimi refuses this file as a backdrop video, or null when it is an mp4 or webm within the cap. */
export function findBackdropVideoProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength > PLUGIN_BACKDROP_VIDEO_MAX_BYTES) return "exceeds 8 MiB";
  return backdropVideoMime(bytes) ? null : "not an mp4 or webm video";
}

/** Why Pimi refuses this GLSL source before compiling it, or null when it is within the size cap. */
export function findBackdropShaderSourceProblem(source: string): string | null {
  if (new TextEncoder().encode(source).byteLength > PLUGIN_BACKDROP_SHADER_MAX_BYTES) {
    return "exceeds 32 KiB";
  }
  return source.trim() ? null : "is empty";
}
