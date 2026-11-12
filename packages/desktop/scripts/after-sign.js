const path = require("node:path");

const { smokePackagedDesktopApp } = require("./packaged-app-smoke.js");

exports.default = async function afterSign(context) {
  if (process.env.PIMI_DESKTOP_SMOKE !== "1") {
    return;
  }

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  await smokePackagedDesktopApp({
    appPath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
  });
};
