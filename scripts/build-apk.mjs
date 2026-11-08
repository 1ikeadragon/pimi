import { spawnSync, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cliArgs = process.argv.slice(2);
const pimi = cliArgs[0] === "--pimi";
const target = (pimi ? cliArgs[1] : cliArgs[0]) ?? (pimi ? "arm64" : "universal");
const architectures = {
  universal: "armeabi-v7a,arm64-v8a,x86,x86_64",
  arm64: "arm64-v8a",
}[target];
if (!architectures) {
  throw new Error(`Unknown APK target: ${target}. Use universal or arm64.`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const app = path.join(root, "packages/app");
const env = {
  ...process.env,
  APP_VARIANT: pimi ? "pimi-android" : "production",
};
if (pimi) {
  env.EXPO_NO_TELEMETRY = "1";
  delete env.EXPO_USE_COMMUNITY_AUTOLINKING;
  delete env.PASEO_FDROID_BUILD;
  delete env.PASEO_WATCHDOG_BUILD;
  delete env.PASEO_PROFILE_BUILD;
  delete env.PASEO_DIAGNOSTIC_REVISION;
  delete env.PASEO_DIAGNOSTIC_BUILD_TIME;
  delete env.PIMI_ANDROID_KEYSTORE;
  delete env.PIMI_ANDROID_PASSWORD_FILE;
} else {
  env.PASEO_WATCHDOG_BUILD = "1";
  env.PASEO_DIAGNOSTIC_BUILD_TIME = new Date().toISOString();
  env.PASEO_DIAGNOSTIC_REVISION =
    execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim() +
    (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
      ? "-dirty"
      : "");
}

function signingOptions() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const keystore = process.env.PIMI_ANDROID_KEYSTORE;
  const passwordFile = process.env.PIMI_ANDROID_PASSWORD_FILE;
  if (!sdk || !keystore || !passwordFile) {
    throw new Error("Set ANDROID_HOME, PIMI_ANDROID_KEYSTORE and PIMI_ANDROID_PASSWORD_FILE.");
  }
  const apksigner = path.join(sdk, "build-tools/36.0.0/apksigner");
  if (![apksigner, keystore, passwordFile].every(existsSync)) {
    throw new Error("Build Tools 36.0.0 and the Pimi Android signing files must exist.");
  }
  return { apksigner, keystore: path.resolve(keystore), passwordFile: path.resolve(passwordFile) };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
const signing = pimi ? signingOptions() : null;
run("npm", ["run", "build:app-deps"], root);
run(
  "npx",
  [
    "--no-install",
    "expo",
    "prebuild",
    "--platform",
    "android",
    "--no-install",
    ...(pimi ? ["--clean"] : []),
  ],
  app,
);
if (pimi) {
  const wrapper = path.join(app, "android/gradle/wrapper/gradle-wrapper.properties");
  const properties = readFileSync(wrapper, "utf8");
  if (!properties.includes("/gradle-9.3.1-bin.zip\n")) {
    throw new Error("Expo changed the Gradle distribution. Review and pin its new checksum.");
  }
  const checksum = "b266d5ff6b90eada6dc3b20cb090e3731302e553a27c5d3e4df1f0d76beaff06";
  writeFileSync(
    wrapper,
    `${properties.replace(/^distributionSha256Sum=.*\n/m, "")}distributionSha256Sum=${checksum}\n`,
  );
}
// Gradle does not track Metro's environment flags. Always regenerate the JS artifact
// so a previous ordinary release cannot silently bypass the profiling renderer.
rmSync(path.join(app, "android/app/build/generated/assets"), { recursive: true, force: true });
run(
  "./gradlew",
  [
    "assembleRelease",
    "--no-daemon",
    "--max-workers=2",
    "-Dorg.gradle.parallel=false",
    `-PreactNativeArchitectures=${architectures}`,
  ],
  path.join(app, "android"),
);
const apk = path.join(app, "android/app/build/outputs/apk/release/app-release.apk");
const filename = pimi ? `Pimi-Android-${target}.apk` : `paseo-dogfood-${target}.apk`;
const destination = path.join(root, "artifacts", filename);
mkdirSync(path.dirname(destination), { recursive: true });
if (signing) {
  const temp = mkdtempSync(path.join(path.dirname(destination), ".pimi-apk-"));
  try {
    const output = path.join(temp, filename);
    run(
      signing.apksigner,
      [
        "sign",
        "--ks",
        signing.keystore,
        "--ks-key-alias",
        "pimi",
        "--ks-pass",
        `file:${signing.passwordFile}`,
        "--v4-signing-enabled",
        "false",
        "--out",
        output,
        apk,
      ],
      root,
    );
    run(signing.apksigner, ["verify", "--verbose", "--print-certs", output], root);
    renameSync(output, destination);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(`\nSigned Pimi APK: ${destination}\n`);
} else {
  copyFileSync(apk, destination);
  console.log(`\nDiagnostic release APK: ${destination}\nLogs: Downloads/Paseo diagnostics\n`);
}
