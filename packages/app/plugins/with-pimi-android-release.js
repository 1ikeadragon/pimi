const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withGradleProperties,
  withProjectBuildGradle,
  withSettingsGradle,
} = require("expo/config-plugins");

// Gradle checks every downloaded artifact against these SHA-256 hashes. Regenerate after a
// dependency change; docs/android.md has the command.
const verificationMetadata = path.join(__dirname, "pimi-android-verification-metadata.xml");

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
    // The React Native Gradle plugin adds JitPack to every project unless this is false.
    const properties = {
      "expo.camera.pimi-offline-qr": "true",
      "react.includeJitpackRepository": "false",
    };
    modConfig.modResults = modConfig.modResults.filter(
      (entry) => entry.type !== "property" || !(entry.key in properties),
    );
    for (const [key, value] of Object.entries(properties)) {
      modConfig.modResults.push({ type: "property", key, value });
    }
    return modConfig;
  });
  // Nothing resolves from JitPack. The Expo template still declares it for all projects.
  config = withProjectBuildGradle(config, (modConfig) => {
    const contents = modConfig.modResults.contents.replace(
      /^[ \t]*maven \{ url ['"]https:\/\/(www\.)?jitpack\.io['"] \}\n/m,
      "",
    );
    if (/jitpack/i.test(contents)) {
      throw new Error(
        "Could not remove the JitPack repository from the Android root build.gradle.",
      );
    }
    modConfig.modResults.contents = contents;
    return modConfig;
  });
  config = withDangerousMod(config, [
    "android",
    (modConfig) => {
      const gradleDir = path.join(modConfig.modRequest.platformProjectRoot, "gradle");
      fs.mkdirSync(gradleDir, { recursive: true });
      fs.copyFileSync(verificationMetadata, path.join(gradleDir, "verification-metadata.xml"));
      return modConfig;
    },
  ]);
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
