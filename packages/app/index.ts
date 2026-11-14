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
import { startWatchdog } from "./src/watchdog";

startWatchdog();

// The native host runs the "main" application as soon as this bundle finishes evaluating, so the
// component must be registered synchronously. The app evaluates after the watchdog has started.
// oxlint-disable-next-line typescript/no-require-imports -- Evaluate the app after the watchdog.
const { RootApp } = require("./src/root-app") as typeof import("./src/root-app");
renderRootComponent(RootApp);
