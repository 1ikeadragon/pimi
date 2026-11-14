// The plugin compiler bundles these imports as strings: a data URL for an image or video, GLSL
// source for a shader.
declare module "*.png" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.webp" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.jpg" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.mp4" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.webm" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.frag" {
  const source: string;
  export default source;
}
