const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const appNodeModulesRoot = path.resolve(projectRoot, "node_modules");
const appSrcRoot = path.resolve(projectRoot, "src");
const isWatchdogBuild = process.env.PIMI_WATCHDOG_BUILD === "1";
const isPimiAndroid = process.env.APP_VARIANT === "pimi-android";
const pimiAndroidNotificationsStub = path.resolve(appSrcRoot, "fdroid/expo-notifications.ts");
const webBarcodeDetectorStub = path.resolve(appSrcRoot, "web/barcode-detector-stub.ts");
const customWebPlatform = (process.env.PIMI_WEB_PLATFORM ?? "")
  .trim()
  .replace(/^\./, "")
  .toLowerCase();

const config = getDefaultConfig(projectRoot);
config.cacheVersion = isWatchdogBuild ? "watchdog" : "standard";
if (isPimiAndroid) {
  config.cacheVersion = "pimi-android";
}
const defaultResolveRequest = config.resolver.resolveRequest ?? resolve;

// Keep app exports deterministic across dev machines and CI. Metro's Watchman
// crawler behavior depends on the host Watchman build/capabilities, while the
// node crawler is the path used when Watchman is absent.
config.resolver.useWatchman = false;

// Evaluate a module when its first binding is used instead of when it is imported, so launch only
// runs the modules the first screen touches. Side-effect-only imports (polyfills, Unistyles setup)
// have no binding and always run in order. Only the web bundle gets it: the native bundles ship
// with Hermes bytecode, where module evaluation is already cheap and untested here.
const defaultGetTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (entryPoints, options, getDependenciesOf) => {
  const base = await defaultGetTransformOptions(entryPoints, options, getDependenciesOf);
  if (options.platform !== "web") return base;
  return {
    ...base,
    transform: {
      ...base.transform,
      inlineRequires: true,
      nonInlinedRequires: [
        "React",
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-native",
      ],
    },
  };
};

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  react: path.join(appNodeModulesRoot, "react"),
  "react-dom": path.join(appNodeModulesRoot, "react-dom"),
  "react/jsx-runtime": path.join(appNodeModulesRoot, "react/jsx-runtime"),
  "react/jsx-dev-runtime": path.join(appNodeModulesRoot, "react/jsx-dev-runtime"),
};
// Production bundles carry only the Lucide icons the app imports by name. The full set is the
// async chunk behind `src/plugins/lucide-full-set/load.ts`, which resolves plugin icons by name at runtime.
// Dev keeps the full set so a newly imported icon needs no Metro restart.
const lucidePackageName = "lucide-react-native";
const lucideFullSetImporter = path.resolve(appSrcRoot, "plugins/lucide-full-set/load.ts");

function listSourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(entryPath, files);
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function writeLucideUsedBarrel() {
  const esmRoot = path
    .dirname(require.resolve(lucidePackageName, { paths: [projectRoot] }))
    .replace(/dist[/\\]cjs$/, "dist/esm");
  const fileByName = new Map();
  const barrel = fs.readFileSync(path.join(esmRoot, "lucide-react-native.mjs"), "utf8");
  for (const match of barrel.matchAll(/export \{([^}]+)\} from '(\.\/[^']+)'/g)) {
    for (const part of match[1].split(",")) {
      const [original, alias] = part.trim().split(/\s+as\s+/);
      if (original) {
        fileByName.set(alias ?? original, { original, file: path.join(esmRoot, match[2]) });
      }
    }
  }
  const used = new Set();
  for (const file of listSourceFiles(appSrcRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:import|export)\s+\{([^}]*)\}\s+from\s+"lucide-react-native"/g,
    )) {
      for (const part of match[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name && !name.startsWith("type ")) used.add(name);
      }
    }
  }
  const lines = [];
  for (const name of [...used].sort()) {
    const target = fileByName.get(name);
    if (!target) throw new Error(`"${name}" is imported from lucide-react-native but not exported`);
    lines.push(`export { ${target.original} as ${name} } from ${JSON.stringify(target.file)};`);
  }
  // Metro's file map skips dot directories and node_modules, so the file lives in a plain
  // gitignored directory under the project root.
  const outDir = path.resolve(projectRoot, "metro-generated");
  fs.mkdirSync(outDir, { recursive: true });
  const barrelPath = path.join(outDir, "lucide-used-icons.mjs");
  const content = `${lines.join("\n")}\n`;
  if (!fs.existsSync(barrelPath) || fs.readFileSync(barrelPath, "utf8") !== content) {
    fs.writeFileSync(barrelPath, content);
  }
  return barrelPath;
}

// Written when the config loads, before Metro crawls the project, so the file is in its file map.
const lucideUsedBarrelPath = writeLucideUsedBarrel();

function isLocalModuleImport(moduleName) {
  return (
    moduleName.startsWith("./") ||
    moduleName.startsWith("../") ||
    moduleName.startsWith("@/") ||
    path.isAbsolute(moduleName)
  );
}

function resolveWithCustomWebOverlay(context, moduleName, platform) {
  const shouldResolveCustomWebVariant =
    platform === "web" &&
    customWebPlatform.length > 0 &&
    customWebPlatform !== "web" &&
    isLocalModuleImport(moduleName);

  if (shouldResolveCustomWebVariant) {
    const overlayContext = {
      ...context,
      // Resolve only "<custom-platform>.<ext>" variants in overlay mode.
      sourceExts: context.sourceExts.map((ext) => `${customWebPlatform}.${ext}`),
      preferNativePlatform: false,
    };

    try {
      return defaultResolveRequest(overlayContext, moduleName, null);
    } catch {
      // Ignore overlay misses and continue with normal web resolution.
    }
  }

  return defaultResolveRequest(context, moduleName, platform);
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === "web" &&
    context.dev === false &&
    moduleName === lucidePackageName &&
    context.originModulePath !== lucideFullSetImporter
  ) {
    return { type: "sourceFile", filePath: lucideUsedBarrelPath };
  }
  if (
    isWatchdogBuild &&
    platform === "android" &&
    /[/\\]Renderer[/\\]shims[/\\]/.test(context.originModulePath) &&
    /implementations\/(ReactFabric|ReactNativeRenderer)-prod$/.test(moduleName)
  ) {
    return defaultResolveRequest(context, moduleName.replace(/-prod$/, "-profiling"), platform);
  }
  if (platform === "web" && moduleName === "barcode-detector") {
    return { type: "sourceFile", filePath: webBarcodeDetectorStub };
  }
  if (platform === "android" && isPimiAndroid && moduleName === "expo-notifications") {
    return resolveWithCustomWebOverlay(context, pimiAndroidNotificationsStub, platform);
  }

  return resolveWithCustomWebOverlay(context, moduleName, platform);
};

if (process.env.PIMI_SERVE_SIM_PREVIEW === "1") {
  const { simMiddleware } = require("serve-sim/middleware");
  const originalEnhanceMiddleware = config.server?.enhanceMiddleware;
  config.server = config.server ?? {};
  config.server.enhanceMiddleware = (metroMiddleware, server) => {
    const middleware = originalEnhanceMiddleware
      ? originalEnhanceMiddleware(metroMiddleware, server)
      : metroMiddleware;
    const serveSimulator = simMiddleware({
      basePath: "/.sim",
      device: process.env.PIMI_SERVE_SIM_DEVICE_UDID,
    });
    return (req, res, next) => {
      serveSimulator(req, res, (error) => {
        if (error) {
          if (next) {
            next(error);
            return;
          }
          throw error;
        }
        middleware(req, res, next);
      });
    };
  };
}

module.exports = config;
