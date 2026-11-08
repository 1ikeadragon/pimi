const {
  AndroidConfig,
  withAndroidManifest,
  withGradleProperties,
  withSettingsGradle,
} = require("expo/config-plugins");

const excludedModules = [
  "expo-notifications",
  "expo-application",
  "expo-dev-client",
  "expo-dev-launcher",
  "expo-dev-menu",
  "expo-dev-menu-interface",
];

function withPimiAndroidRelease(config) {
  config = withSettingsGradle(config, (modConfig) => {
    const marker = "expoAutolinking.useExpoModules()";
    const exclusion = `expoAutolinking.exclude = ${JSON.stringify(excludedModules)}`;
    const contents = modConfig.modResults.contents;
    if (contents.split(marker).length !== 2) {
      throw new Error("Could not isolate the Expo autolinking call for Pimi Android.");
    }
    modConfig.modResults.contents = contents
      .replace(/^expoAutolinking\.exclude = \[.*\]\n/m, "")
      .replace(marker, `${exclusion}\n${marker}`);
    return modConfig;
  });
  config = withGradleProperties(config, (modConfig) => {
    const key = "expo.camera.pimi-offline-qr";
    modConfig.modResults = modConfig.modResults.filter(
      (entry) => entry.type !== "property" || entry.key !== key,
    );
    modConfig.modResults.push({ type: "property", key, value: "true" });
    return modConfig;
  });
  return withAndroidManifest(config, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(modConfig.modResults);
    const metadata = (application["meta-data"] ??= []);
    const name = "com.google.mlkit.vision.DEPENDENCIES";
    if (!metadata.some((entry) => entry.$["android:name"] === name)) {
      metadata.push({ $: { "android:name": name, "tools:node": "remove" } });
    }
    return modConfig;
  });
}

module.exports = withPimiAndroidRelease;
