const pkg = require("./package.json");
const withAndroidAsyncStorageSize = require("./plugins/with-android-async-storage-size");
const withAndroidOptionalCamera = require("./plugins/with-android-optional-camera");
const withAndroidProfileable = require("./plugins/with-android-profileable");
const withFdroidAutolinking = require("./plugins/with-fdroid-autolinking");
const withPasteInput = require("./plugins/with-paste-input");
const withPimiAndroidRelease = require("./plugins/with-pimi-android-release");
const withAndroidScroll = require("./modules/paseo-scroll/app.plugin");
const { getNativeReleaseVersion } = require("./native-release-version");
const appVariant = process.env.APP_VARIANT ?? "production";
const isPimiAndroid = appVariant === "pimi-android";
const isFdroidBuild = process.env.PASEO_FDROID_BUILD === "1";
const isWatchdogBuild = process.env.PASEO_WATCHDOG_BUILD === "1";
const isProfileBuild = process.env.PASEO_PROFILE_BUILD === "1";

const buildProfile = isFdroidBuild
  ? {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
      ],
      cameraPlugins: [],
      fdroidPlugins: [withFdroidAutolinking],
      notificationPlugins: [],
    }
  : {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "CAMERA",
        "android.permission.CAMERA",
      ],
      cameraPlugins: [
        [
          "expo-camera",
          {
            cameraPermission:
              "Allow $(PRODUCT_NAME) to access your camera to scan pairing QR codes.",
          },
        ],
      ],
      fdroidPlugins: [],
      notificationPlugins: [
        [
          "expo-notifications",
          {
            icon: "./assets/images/notification-icon.png",
            color: "#20744A",
          },
        ],
      ],
    };

const variants = {
  "pimi-android": { name: "Pimi", packageId: "io.github.ikeadragon.pimi" },
  production: { name: "Pimi", packageId: "io.github.ikeadragon.pimi" },
  development: { name: "Pimi Debug", packageId: "io.github.ikeadragon.pimi.debug" },
};

const variant = variants[appVariant] ?? variants.production;
const nativeReleaseVersion = getNativeReleaseVersion(pkg.version);

export default {
  expo: {
    name: variant.name,
    slug: "pimi",
    version: nativeReleaseVersion.appVersion,
    orientation: "default",
    icon: "./assets/images/pimi-icon.png",
    scheme: "pimi",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      infoPlist: {
        NSMicrophoneUsageDescription: "This app needs access to the microphone for voice commands.",
        ITSAppUsesNonExemptEncryption: false,
      },
      bundleIdentifier: variant.packageId,
      buildNumber: nativeReleaseVersion.iosBuildNumber,
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#3a2c34",
        foregroundImage: "./assets/images/pimi-android-foreground.png",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: "resize",
      // Allow HTTP connections for local network hosts (required for release builds)
      usesCleartextTraffic: true,
      permissions: buildProfile.androidPermissions,
      package: variant.packageId,
      ...(isPimiAndroid
        ? { allowBackup: false, blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW"] }
        : {}),
      versionCode: nativeReleaseVersion.androidVersionCode,
    },
    web: {
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    autolinking: {
      searchPaths: ["../../node_modules", "./node_modules"],
    },
    plugins: [
      "./modules/paseo-hardware-keyboard/app.plugin",
      "expo-router",
      withPasteInput,
      withAndroidScroll,
      [withAndroidAsyncStorageSize, 64],
      ...buildProfile.cameraPlugins,
      withAndroidOptionalCamera,
      [
        "expo-splash-screen",
        {
          image: "./assets/images/pimi-splash.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
      ...(isPimiAndroid
        ? [["expo-dev-client", { addGeneratedScheme: false }], withPimiAndroidRelease]
        : buildProfile.notificationPlugins),
      "expo-audio",
      [
        "expo-gradle-jvmargs",
        {
          xmx: "4096m",
          maxMetaspace: "1024m",
        },
      ],
      [
        "expo-build-properties",
        {
          ios: { enableSceneSupport: true },
          android: {
            minSdkVersion: 29,
            kotlinVersion: "2.1.20",
            // Allow HTTP connections for local network hosts in release builds
            usesCleartextTraffic: true,
          },
        },
      ],
      ...buildProfile.fdroidPlugins,
      ...(isProfileBuild || isWatchdogBuild ? [withAndroidProfileable] : []),
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: {
      ...(isPimiAndroid ? { pimiAndroid: true } : {}),
      fdroidBuild: isFdroidBuild,
      profileBuild: isProfileBuild,
      watchdogBuild: isWatchdogBuild,
      diagnosticRevision: process.env.PASEO_DIAGNOSTIC_REVISION,
      diagnosticBuildTime: process.env.PASEO_DIAGNOSTIC_BUILD_TIME,
      router: {},
    },
  },
};
