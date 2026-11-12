# Android

## Pimi APK

[Download the signed ARM64 preview](https://github.com/1ikeadragon/pimi/releases/tag/pimi-android-v0.17.18).

Pimi for Android runs chats on your paired host. You can browse workspace
files and diffs, open Work, tile agents, and check usage. Tasks reads and
writes the board on a running Pimi Desktop 0.16.6 or newer. It needs an
encrypted Wi-Fi pairing or a password-protected host paired over the encrypted relay. Memory, Spaces,
cross-repository Review, and Usage Recap stay on desktop for this preview.
Cloud push notifications are unavailable in the preview.

On Pimi Desktop, open **Pair a device** in your local host settings.
Choose **Same Wi-Fi**, enable local pairing, then scan the QR code in Pimi for
Android or paste the pairing link. Pimi decodes QR codes on the device with
ZXing. After restarting the desktop daemon or changing its network address,
enable local pairing again and use the new link.

Remote pairing uses the configured relay, including a self-hosted
[Pimi Relay](self-hosted-relay.md). Use WSS for a relay
reachable over the internet.

The signed APK uses `io.github.ikeadragon.pimi` and supports Android 10 and
newer. Build the arm64 APK with Java 21 and Android SDK 36 after `npm ci` and
`npm run setup`.
Use `-- universal` after the command to build for all four supported ABIs.

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PIMI_ANDROID_KEYSTORE=/path/outside/the/checkout/pimi-release.p12
export PIMI_ANDROID_PASSWORD_FILE=/path/outside/the/checkout/keystore.pass
npm run pimi:package:android
```

Install Build Tools `36.0.0`, NDK `27.1.12297006`, and CMake `3.22.1` with
`sdkmanager`. The build uses the `pimi-android` Expo variant and writes
`artifacts/Pimi-Android-arm64.apk`. It excludes Firebase messaging, the Google
barcode scanner, and Expo development modules. It signs with the `pimi` alias and verifies
the APK before copying it to that path. Keep the same signing key for future
updates. Keep the keystore and password file outside the checkout with
user-only access and an offline backup.

### Gradle dependencies

`packages/app/android` is generated, so its Gradle supply-chain settings live in
`packages/app/plugins/with-pimi-android-release.js`, which applies only to the `pimi-android`
variant. It removes the JitPack repository the Expo template and the React Native Gradle plugin add,
and copies `packages/app/plugins/pimi-android-verification-metadata.xml` to
`android/gradle/verification-metadata.xml`. Gradle then fails the build when any downloaded
artifact, including plugins, does not match its SHA-256 there. The
`@react-native-masked-view/masked-view` patch removes the JitPack repository from that package.
Native modules checked into this repository pin their Maven versions in a `gradle.lockfile` next
to their `build.gradle`; refresh one with `./gradlew :<module>:dependencies --write-locks`.

After a dependency change, the release build fails verification. Regenerate the metadata from
`packages/app/android` after the prebuild that `npm run pimi:package:android` runs, then copy it
back and review the diff:

```sh
APP_VARIANT=pimi-android ./gradlew --write-verification-metadata sha256 assembleRelease \
  --no-daemon --max-workers=2 -Dorg.gradle.parallel=false -PreactNativeArchitectures=arm64-v8a
cp gradle/verification-metadata.xml ../plugins/pimi-android-verification-metadata.xml
```

The hashes record what Gradle downloaded when you regenerated them. Regenerate on a clean Gradle
cache (`GRADLE_USER_HOME` pointed at an empty directory) when you need them to come from the
repositories rather than an earlier local download.

## App variants

Controlled by `APP_VARIANT` in `packages/app/app.config.js` (vanilla Expo, no custom Gradle plugin):

| Variant        | App name   | Package ID                        |
| -------------- | ---------- | --------------------------------- |
| `production`   | Pimi       | `io.github.ikeadragon.pimi`       |
| `development`  | Pimi Debug | `io.github.ikeadragon.pimi.debug` |
| `pimi-android` | Pimi       | `io.github.ikeadragon.pimi`       |

`development` uses Android `debug`.

## Version codes

`packages/app/native-release-version.js` is the single definition of native version-code math. Do not re-derive these numbers anywhere else — Android and iOS use these values to identify builds.

The base version code comes from the package version:

```text
major * 1_000_000 + minor * 1_000 + patch
```

Prerelease metadata is ignored, so `0.1.102-beta.1` and `0.1.102` both produce `1102`. The same value is used as the iOS `buildNumber` so the native build number is visible in the repo. Do not add a remote version counter or Android `autoIncrement`.

The formula reserves three digits each for minor and patch. If either reaches `1000`, change the formula before cutting that release.

## Prerequisites (local dev)

Local Android builds run on macOS (or Linux) and need the Android toolchain, pinned in `.tool-versions` (`java 21`, `android-sdk 21.0`) and wired up by `.mise.toml` (which derives `ANDROID_HOME` and the command-line tool paths from the `android-sdk` entry). With [mise](https://mise.jdx.dev):

```bash
mise install        # java 21 + android-sdk 21.0 command-line tools
```

> **Pin a real `android-sdk` version, not `latest`.** The mise `android-sdk` plugin's `latest` resolved to the ancient `1.0` bundle, whose `sdkmanager` (3.6.0) predates the `emulator` package and fails with `Failed to find package emulator`. `21.0` ships a current `sdkmanager`. If you bump it, update only the version in `.tool-versions`; `.mise.toml` derives its paths from that tool entry.

`mise install` only lays down the command-line tools. Install the rest and create an emulator. On Apple Silicon:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7
emulator @paseo     # start it; leave running
```

On an Intel Mac, use the `x86_64` system image:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;x86_64" -d pixel_7
emulator @paseo     # start it; leave running
```

Gradle auto-fetches the platform/build-tools it needs once licenses are accepted, so adjust `android-35` only if it asks for a different level.

## Local build + install

The `react-native-svg@15.15.4` patch prevents header fades retaining their old painted size after
rotation. Rebuild native Android after changing it; Metro reloads cannot update this code. Keep the
resize hunks until upstream invalidates descendant geometry on canvas resize. Its instrumentation
regression renders real gradient pixels across growing and shrinking layouts, including a nested
group. From `packages/app/android`, run it on your selected emulator:

```bash
ANDROID_SERIAL=emulator-5562 ./gradlew :react-native-svg:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.horcrux.svg.SvgResizeTest \
  --no-daemon --max-workers=2 -Dorg.gradle.parallel=false
```

The locked `expo-modules-core@57.0.25` needs the patch applied by `npm run setup`.
It backports
[Expo's Activity-result launcher fix](https://github.com/expo/expo/pull/49634): changing
font size or another unhandled configuration can otherwise disable image selection
until the app process restarts. Rebuild the native app after changing this patch;
a Metro reload cannot update it. Remove the patch when the installed
`expo-modules-core` includes the fix.

From repo root:

```bash
npm run build:apk       # Universal dogfood APK: 32/64-bit ARM and x86
npm run build:apk:arm64 # Smaller dogfood APK for ARM64 phones
npm run dev:android     # Build/install the debug app and start development
npm run dev:ios         # Build/install the iOS development app
```

`build:apk` writes `artifacts/paseo-dogfood-universal.apk`; `build:apk:arm64` writes
`artifacts/paseo-dogfood-arm64.apk`. Neither command launches or installs on a device. Both enable
`PIMI_WATCHDOG_BUILD=1`, the production React profiling renderer, and Android's shell-profileable
flag. These builds keep the production package ID (`io.github.ikeadragon.pimi`) and release optimizations. Use this APK for
personal dogfooding. Android system-trace spans require the separate `PIMI_PROFILE_BUILD=1` flag;
watchdog recording does not send duplicate spans to that sink by default. Normal store/release
workflows leave diagnostics disabled.

The older `android`, `android:development`, and `ios` commands remain aliases for development.
`android:production` still builds and installs a release through Expo; use `build:apk` when you
need an artifact. `android:clear` removes the generated Android project.

### Diagnostic logs without ADB

In a dogfood build, open Android's Files app → Downloads → **Pimi diagnostics** and share all
retained `.jsonl` files. No app screen, storage permission, or attached debugger is required.
The recorder retains eight files of about 5 MiB each across reconnects and app restarts. Rotation
replaces the oldest files, so collect them soon after reproducing a freeze. Uninstall/reinstall
can leave older Downloads files that the new installation cannot manage.

Each file identifies its build and session. Events include application-transport frame sizes and
message/request IDs, connection transitions, parse/validation/dispatch spans, named React subtree
render timings, and foreground JS heartbeat gaps. Payloads, passwords, and message contents
are excluded; connection identifiers include host addresses. Each size has a unit: **bytes** when
already available, otherwise **UTF-16 code units** for text. These are
client transport observations, after relay decryption where applicable, not packet arrival times.

The native recorder flags a heartbeat overdue by more than 500 ms (250 ms expected interval).
A heartbeat gap bounds the unresponsive interval; it is not an exact blocked-stack duration.
Backgrounding suspends detection. `js.stall.started` can be written while JS remains blocked;
`js.stall.recovered` records the gap when JS resumes. Recovery can appear without a start event
when JS resumes before the next native sampling tick. Process death leaves earlier files intact,
but queued/unflushed records can be lost. A missing recovery event alone does not prove a crash.

`react.render.slow` records subtree rendering taking at least 16 ms; one-second summaries include
faster renders. Nested profiler timings overlap: don't add parent and child times. React's render
measurements do not measure native layout/paint or the complete commit phase. `recorder.dropped`
means the bounded queue overflowed; missing events in that interval must not be treated as absence
of activity. Storage failure stops recording rather than blocking the app.

For an ordinary release APK with system trace markers only:

```bash
PIMI_PROFILE_BUILD=1 npm run android:production
```

Those markers emit only while a system trace records `io.github.ikeadragon.pimi` (`perfetto -a sh.pimi ...`);
they do not produce Downloads files.

## Running on an emulator against a worktree daemon

`npm run android` builds and installs the dev client, but two connections have to reach your Mac from inside the emulator — Metro (the JS bundle) and the Pimi daemon — and **the emulator does not share the host's loopback**: `localhost` inside the emulator is the emulator itself. Reach the host at `10.0.2.2` (the standard AVD's host alias) for both:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2 \
  EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:$PIMI_SERVICE_DAEMON_PORT \
  npm run android
```

- **`REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2`** — without it, Expo bakes your Mac's LAN IP into the dev client's Metro URL, which the emulator can't route to, and the app dies with `Failed to connect to /<lan-ip>:8081` before any JS loads.
- **`EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:<port>`** — the client's daemon endpoint (`packages/app/src/runtime/host-runtime.ts`); when unset it defaults to `localhost:6767`, the production daemon. Use `$PIMI_SERVICE_DAEMON_PORT` for a worktree daemon running as a Pimi service, or `6768` for a standalone `npm run dev:server`. It is inlined into the JS bundle at Metro bundle time, so set it on the build command and clear the Metro cache (`npx expo start -c`) if a change doesn't take.

**Alternative — `adb reverse` + `localhost`** (if `10.0.2.2` misbehaves):

```bash
adb reverse tcp:8081 tcp:8081
adb reverse tcp:$PIMI_SERVICE_DAEMON_PORT tcp:$PIMI_SERVICE_DAEMON_PORT
REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  EXPO_PUBLIC_LOCAL_DAEMON=localhost:$PIMI_SERVICE_DAEMON_PORT \
  npm run android
```

This is the Android counterpart of the iOS local-simulator flow in [development.md](development.md): on iOS the simulator shares the Mac's loopback so `localhost:<port>` works directly; on Android you need `10.0.2.2` or `adb reverse`.

## Scroll view corrections

`modules/paseo-scroll` replaces React Native's vertical scroll view with `PaseoScrollView`, which
keeps React Native's scroll manager interface and corrects `maintainVisibleContentPosition` for the
chat timeline. [agent-stream-disclosure.md](agent-stream-disclosure.md#scroll-view-corrections)
lists the corrections and the React Native issues they work around.

Register this package before React Native's core package through its Expo config plugin. Normal
Android builds use the prebuilt `react-android` library, so patching Java under `node_modules` does
not change the shipped scroll view. Keep this behavior in the app's compiled native module.

## Gradle memory

Pimi applies `expo-gradle-jvmargs` with `-Xmx4096m` and `-XX:MaxMetaspaceSize=1024m` so local Expo prebuilds have enough Gradle heap. Release builds compile the native ABIs and run Hermes bundling in the same Gradle invocation. On a small machine, the default worker count can exhaust the remaining memory and kill Hermes with exit code 137 even when Gradle's own heap is sized correctly. If that happens, build with `--no-daemon --max-workers=1 -Dorg.gradle.parallel=false`.

### React version lockstep

Keep `react` and `react-dom` pinned to the React version embedded by the current `react-native` release. React Native `0.81.x` embeds `react-native-renderer` `19.1.0`, so `packages/app` must use React `19.1.0`. Bumping React to a newer patch can build successfully but crash at JS startup on Android with `Incompatible React versions`, leaving the app on the native splash screen.

## Screenshots

```bash
adb exec-out screencap -p > screenshot.png
```
