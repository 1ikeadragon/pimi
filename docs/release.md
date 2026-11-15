# Pimi releases

Releases are built on the maintainer's Apple silicon Mac and published as one GitHub release, `pimi-vX.Y.Z`, with these assets and a `SHA256SUMS.txt`:

| Asset                                                            | Built with                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Pimi-macOS-arm64.dmg`                                           | `npm run pimi:package:mac` (ad hoc signed, not notarized)                                                            |
| `Pimi-daemon-linux-x64.tar.gz`, `Pimi-daemon-linux-arm64.tar.gz` | `scripts/build-daemon-bundle.mjs` after `npm run build:server`                                                       |
| `Pimi-Android-arm64.apk`                                         | `npm run pimi:package:android`, signed with the release key; set `PIMI_ANDROID_GOOGLE_SERVICES_FILE` to include push |
| `Pimi-iOS-arm64.ipa`                                             | Unsigned `xcodebuild` of the Expo prebuild, for SideStore                                                            |

Windows is not built. The desktop app updates itself from the newest stable release; macOS may ask for approval when opening the new version.

## Cut a release

1. Bump the root version, run `npm run version:sync-internal`, and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
2. Add a dated `## X.Y.Z - YYYY-MM-DD` entry to `CHANGELOG.md`. Describe changes users will notice.
3. Run `npm run typecheck`, smoke-test the changed behavior, and push to `main`.
4. From a clean checkout at that commit, run the [dependency checks](development.md#dependency-checks), build every asset, tag the commit, and publish the release with the changelog entry and the commits since the previous release as notes. Published releases are immutable, so every asset goes up at once.

Compare the downloads against `SHA256SUMS.txt` from the release.

## Build locally

Run `npm ci` and `npm run setup` with the Node.js version in `.tool-versions`. Use `npm run pimi:package:mac` on Apple silicon or `npm run pimi:package:win` on Windows x64. The installers are written under `packages/desktop/release-pimi/`. The iOS build needs Xcode and CocoaPods.
