// Policy for the console document (the pimi://app page, or the Metro page in dev). Its job is
// `script-src`: markup that reaches the console DOM cannot run an inline handler or load a remote
// script, so it cannot reach window.pimiDesktop. Everything else is the allowlist that
// `default-src 'none'` needs to keep the app working. Add a named source here, never `*`.
export const CONSOLE_CSP = [
  "default-src 'none'",
  // Plugin client bundles run through eval (plugins/evaluate.ts); the markdown (md4c) and sixel
  // decoders are wasm.
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  // react-native-web and the root font style write inline styles.
  "style-src 'self' 'unsafe-inline'",
  // data: attack screenshots and project icons, blob: workspace images and attachments,
  // http(s): browser-tab favicons.
  "img-src 'self' data: blob: http: https:",
  // The Tide video backdrop and plugin theme videos.
  "media-src 'self' blob:",
  // ws: and wss: are user-entered hosts and relays; raw.githubusercontent.com is the changelog;
  // data: and blob: are attachment and document reads.
  "connect-src 'self' ws: wss: https://raw.githubusercontent.com data: blob:",
  // Sealed previews (features/sealed-frames.ts) and the PDF viewer.
  "frame-src pimi://frame blob:",
].join("; ");
