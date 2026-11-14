import type { PluginClientContext } from "@pimi/plugin/client";
import aurora from "./client/aurora.frag";
import drift from "./client/drift.mp4";
import driftPoster from "./client/drift-poster.png";
import driftVeil from "./client/drift-veil.png";
import ember from "./client/ember.png";
import emberVeil from "./client/ember-veil.png";

const dark = {
  background: "#0b1020",
  foreground: "#e6edf7",
  raised: "#141b30",
  control: "#1c2540",
  border: "#2a3558",
  accent: "#7ee0c3",
  mutedForeground: "#a9b8cf",
  ring: "#5c6f99",
};

export default function contribute(client: PluginClientContext) {
  // A live shader. `limit` is left out: Pimi derives it from `mutedForeground`.
  client.addTheme({
    id: "aurora",
    name: "Aurora",
    appearance: "dark",
    colors: dark,
    backdrop: {
      kind: "shader",
      fragment: aurora,
      scheme: "dark",
      uniforms: {
        u_base: "#071022",
        u_ribbon_a: "#2fe0a8",
        u_ribbon_b: "#6a7dff",
      },
    },
  });

  // Static art with a veil: a wash of the surface colour drawn over the art, heaviest under the glow.
  client.addTheme({
    id: "ember",
    name: "Ember",
    appearance: "dark",
    colors: { ...dark, background: "#140c1e", raised: "#1d1230", control: "#271a40" },
    backdrop: { kind: "image", image: ember, veil: emberVeil },
  });

  // A muted looping clip. The poster shows under reduced motion; the veil sits over the video.
  client.addTheme({
    id: "drift",
    name: "Drift",
    appearance: "dark",
    colors: { ...dark, background: "#0e0a1c", raised: "#171230", control: "#201a42" },
    backdrop: { kind: "video", video: drift, poster: driftPoster, veil: driftVeil },
  });
  return () => {};
}
