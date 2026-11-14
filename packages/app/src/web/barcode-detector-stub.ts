// expo-camera's web scanner falls back to the `barcode-detector` polyfill, whose zxing-wasm
// fetches its .wasm from a CDN at runtime. Pimi never scans on web, so the web bundle gets this
// stub instead and loads no remote code.
export function BarcodeDetector(): never {
  throw new Error("Barcode scanning is not available here.");
}
