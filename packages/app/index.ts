// Install runtime polyfills before any other module evaluates. Keep this the first import.
// oxlint-disable-next-line import/no-unassigned-import -- Polyfills install on import.
import "./src/polyfills/install-early";

// Configure Unistyles before Expo Router pulls in any components using StyleSheet.
import "./src/styles/unistyles";
// oxlint-disable-next-line import/no-unassigned-import -- Preserve Expo's entry side effects.
import "@expo/metro-runtime";
// oxlint-disable-next-line import/no-unassigned-import -- Preserve Expo's entry side effects.
import "expo-router/build/fast-refresh";
import { renderRootComponent } from "expo-router/build/renderRootComponent";
import { copyLegacyPaseoStorage } from "./src/storage/legacy-paseo-storage";
import { startWatchdog } from "./src/watchdog";

startWatchdog();
// Stores hydrate when the app's modules evaluate, so the old keys are copied before the root
// app is required (COMPAT(paseo-home-mobile)).
async function start(): Promise<void> {
  await copyLegacyPaseoStorage();
  // oxlint-disable-next-line typescript/no-require-imports -- Evaluate the app only after the copy.
  const { RootApp } = require("./src/root-app") as typeof import("./src/root-app");
  renderRootComponent(RootApp);
}
void start();
