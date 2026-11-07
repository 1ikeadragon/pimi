// Pimi addition to the Paseo fork. Apache-2.0.
import { cp } from "node:fs/promises";

await cp(new URL("../../../pimi/", import.meta.url), new URL("../dist/pimi/", import.meta.url), {
  recursive: true,
  filter: (path) => !path.endsWith(".md"),
});

await cp(
  new URL("../../app/public/pimi-textures/", import.meta.url),
  new URL("../dist/pimi/public/pimi-textures/", import.meta.url),
  { recursive: true },
);
