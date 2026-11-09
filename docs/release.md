# Pimi desktop releases

[GitHub Actions](../.github/workflows/pimi-release.yml) builds the Apple silicon installer first, then Windows x64, from a new `pimi-vX.Y.Z` tag on `main`. It publishes the installers, release notes, and SHA-256 checksums together.

Without an `APPLE_TEAM_ID` repository variable, the Mac installer is ad hoc signed. Pimi can install it in-app, and macOS may require approval when opening the new version. The release notes flag the signing status.

## Set up macOS signing

Use a [Developer ID Application certificate](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) and an [App Store Connect team API key](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api) from the same Apple Developer team. Export the certificate and private key as a password-protected `.p12` from Keychain Access.

Add these under [GitHub Actions secrets](https://github.com/1ikeadragon/pimi/settings/secrets/actions).

| Secret                     | Value                            |
| -------------------------- | -------------------------------- |
| `MAC_CERTIFICATE_P12`      | Base64 of the `.p12` export      |
| `MAC_CERTIFICATE_PASSWORD` | Password used for the export     |
| `APPLE_NOTARY_KEY_BASE64`  | Base64 of the team API key `.p8` |
| `APPLE_NOTARY_KEY_ID`      | Key ID from App Store Connect    |
| `APPLE_NOTARY_ISSUER`      | Issuer ID from App Store Connect |

Set `APPLE_TEAM_ID` as a repository Actions variable using the 10-character Team ID from Apple Developer. The release job signs and notarizes both the app and its disk image, checks the mounted app with Gatekeeper, and publishes only after verification succeeds.

## Cut a release

1. Bump the root version, run `npm run version:sync-internal`, and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`. Run `./scripts/update-nix.sh` for the new lockfile.
2. Add a dated `## X.Y.Z - YYYY-MM-DD` entry to `CHANGELOG.md`. Describe changes users will notice.
3. Run `npm run typecheck` and smoke-test the changed behavior. Commit and push to `main`.
4. Create and push `pimi-vX.Y.Z` at the tested commit. Watch both build jobs and verify the [published release](https://github.com/1ikeadragon/pimi/releases/latest).

Compare the downloads against `SHA256SUMS.txt` from the release. For the first signed build, check both a fresh macOS install and an in-app update from the previous release on a separate Mac.

## Build locally

Run `npm ci` with the Node.js version in `.tool-versions`. Use `npm run pimi:package:mac` on Apple silicon or `npm run pimi:package:win` on Windows x64. The installers are written under `packages/desktop/release-pimi/`. The local Mac command produces an ad hoc build for development.
