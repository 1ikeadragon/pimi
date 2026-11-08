import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const QUARANTINE = "com.apple.quarantine";
const PIMI_IDENTIFIER = 'identifier "com.pimi.desktop"';

interface StagedMacUpdate {
  directory: string;
  bundle: string;
  installer: string;
}

// The helper gets only fixed commands and absolute paths as separate arguments.
// It runs as the current user, after the app has released its files.
const REPLACE_BUNDLE = `
parent=$1
bundle=$2
stage=$3
installer=$4
backup="$stage/previous.app"
replacement="$stage/Pimi.app"
fallback() {
  /usr/bin/open "$installer"
  exit 1
}
tries=0
while kill -0 "$parent" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 40 ]; then
    /bin/rm -rf "$stage"
    fallback
  fi
  /bin/sleep 0.5
done
if [ -L "$bundle" ] || ! [ -d "$bundle" ] || ! [ -d "$replacement" ]; then
  /bin/rm -rf "$stage"
  fallback
fi
if ! /bin/mv -h "$bundle" "$backup"; then
  /bin/rm -rf "$stage"
  fallback
fi
if ! /bin/mv -h "$replacement" "$bundle"; then
  if /bin/mv -h "$backup" "$bundle"; then /bin/rm -rf "$stage"; fi
  fallback
fi
if ! /usr/bin/open -n "$bundle"; then
  if /bin/mv -h "$bundle" "$replacement" && /bin/mv -h "$backup" "$bundle"; then
    /bin/rm -rf "$stage"
  fi
  fallback
fi
# A successful open only queues the launch. Keep a recovery copy even if
# Gatekeeper prompts later or the new app fails during startup.
recovery="$(/usr/bin/dirname "$bundle")/.pimi-backup-$(/usr/bin/basename "$bundle")"
if ! [ -e "$recovery" ] && ! [ -L "$recovery" ]; then
  if /bin/mkdir -m 700 "$recovery"; then
    printf '%s\n' pimi-update-backup-v1 > "$recovery/owner"
  fi
fi
if [ -d "$recovery" ] && ! [ -L "$recovery" ] &&
   [ -f "$recovery/owner" ] && ! [ -L "$recovery/owner" ] &&
   [ "$(/bin/cat "$recovery/owner")" = pimi-update-backup-v1 ]; then
  previous="$recovery/previous.app"
  if [ -d "$previous" ] && ! [ -L "$previous" ]; then
    /bin/mv -h "$previous" "$stage/older.app"
  fi
  if ! [ -e "$previous" ] && ! [ -L "$previous" ] && /bin/mv -h "$backup" "$previous"; then
    /bin/rm -rf "$stage"
    exit 0
  fi
  if [ -d "$stage/older.app" ] && ! [ -e "$previous" ] && ! [ -L "$previous" ]; then
    /bin/mv -h "$stage/older.app" "$previous"
  fi
fi
printf 'Previous Pimi app retained at %s\n' "$backup"
`;

function installedBundle(executable: string): string {
  const bundle = path.resolve(path.dirname(executable), "../..");
  if (path.extname(bundle) !== ".app" || bundle.includes("/AppTranslocation/")) {
    throw new Error("Pimi must be installed as a local app bundle to replace it.");
  }
  return bundle;
}

function isLocationReadOnly(error: unknown): boolean {
  return ["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function canReplacePimiBundle(executable: string): Promise<boolean> {
  try {
    const bundle = installedBundle(executable);
    if (!(await lstat(bundle)).isDirectory()) return false;
    await access(bundle, constants.W_OK);
    await access(path.dirname(bundle), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function quarantinePimiDownload(file: string): Promise<void> {
  const { stdout } = await run("/usr/bin/xattr", [file], { timeout: COMMAND_TIMEOUT_MS });
  if (stdout.split(/\s+/).includes(QUARANTINE)) return;
  // Match ordinary downloaded files. LaunchServices retains responsibility for
  // Gatekeeper and user approval of an ad-hoc release.
  const timestamp = Math.floor(Date.now() / 1000).toString(16);
  await run("/usr/bin/xattr", ["-w", QUARANTINE, `0081;${timestamp};Pimi;`, file], {
    timeout: COMMAND_TIMEOUT_MS,
  });
}

async function readBundleVersion(bundle: string): Promise<string> {
  const { stdout } = await run(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", path.join(bundle, "Contents", "Info.plist")],
    { timeout: COMMAND_TIMEOUT_MS },
  );
  return stdout.trim();
}

async function verifyMacBundle(
  bundle: string,
  installed: string,
  expectedVersion: string,
): Promise<void> {
  if (!(await lstat(bundle)).isDirectory()) throw new Error("The Pimi app bundle is missing.");
  await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", `-R=${PIMI_IDENTIFIER}`, bundle],
    { timeout: COMMAND_TIMEOUT_MS },
  );
  if ((await readBundleVersion(bundle)) !== expectedVersion) {
    throw new Error("The Pimi app bundle version did not match the immutable release.");
  }

  const signature = await run("/usr/bin/codesign", ["-d", "--verbose=4", installed], {
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (!/^Signature=adhoc$/m.test(signature.stderr)) {
    const current = await run("/usr/bin/codesign", ["-d", "-r-", installed], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    const requirement = /^designated => (.+)$/m.exec(current.stderr)?.[1];
    if (!requirement) throw new Error("The installed Pimi signing identity could not be verified.");
    await run("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, bundle], {
      timeout: COMMAND_TIMEOUT_MS,
    });
  }
}

export async function stagePimiMacUpdate(
  installer: string,
  executable: string,
  expectedVersion: string,
): Promise<StagedMacUpdate | null> {
  if (!(await canReplacePimiBundle(executable))) return null;
  const bundle = installedBundle(executable);
  let directory: string;
  try {
    directory = await mkdtemp(path.join(path.dirname(bundle), ".pimi-update-"));
  } catch (error) {
    if (isLocationReadOnly(error)) return null;
    throw error;
  }
  const mountPoint = path.join(path.dirname(installer), "mount");
  try {
    // The mountpoint is within the private download directory.
    await run("/bin/mkdir", [mountPoint], { timeout: COMMAND_TIMEOUT_MS });
    try {
      await run(
        "/usr/bin/hdiutil",
        ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, installer],
        { timeout: COMMAND_TIMEOUT_MS },
      );
      const source = path.join(mountPoint, "Pimi.app");
      const staged = path.join(directory, "Pimi.app");
      await verifyMacBundle(source, bundle, expectedVersion);
      await run("/usr/bin/ditto", ["--rsrc", "--extattr", "--qtn", source, staged], {
        timeout: COMMAND_TIMEOUT_MS,
      });
      await verifyMacBundle(staged, bundle, expectedVersion);
      await quarantinePimiDownload(staged);
    } finally {
      await run("/usr/bin/hdiutil", ["detach", mountPoint], {
        timeout: COMMAND_TIMEOUT_MS,
      }).catch(() => undefined);
      // An unmounted directory is empty. Never recursively remove a mountpoint.
      await run("/bin/rmdir", [mountPoint], { timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined);
    }
    return { directory, bundle, installer };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function discardStagedMacUpdate(staged: StagedMacUpdate): Promise<void> {
  await rm(staged.directory, { recursive: true, force: true });
}

export async function startStagedMacUpdate(staged: StagedMacUpdate): Promise<void> {
  const log = await open(path.join(path.dirname(staged.installer), "install.log"), "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const helper = spawn(
        "/bin/sh",
        [
          "-c",
          REPLACE_BUNDLE,
          "pimi-update",
          String(process.pid),
          staged.bundle,
          staged.directory,
          staged.installer,
        ],
        { detached: true, stdio: ["ignore", log.fd, log.fd] },
      );
      helper.once("error", reject);
      helper.once("spawn", () => {
        helper.unref();
        resolve();
      });
    });
  } finally {
    await log.close();
  }
}
