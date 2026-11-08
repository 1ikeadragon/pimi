# Pimi desktop releases

[GitHub Actions](../.github/workflows/pimi-release.yml) builds Apple silicon and Windows x64 installers from a new `pimi-vX.Y.Z` tag on `main`. The workflow checks the tag and versions, builds both platforms, and publishes the installers, release notes, checksums, and build attestations together. It uses standard GitHub-hosted runners in the public repository.

## Cut a release

1. Bump the root version, run `npm run version:sync-internal`, and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`. Run `./scripts/update-nix.sh` for the new lockfile.
2. Add a dated `## X.Y.Z - YYYY-MM-DD` entry to `CHANGELOG.md`. Describe changes users will notice.
3. Run `npm run typecheck` and smoke-test the changed behavior. Commit and push to `main`.
4. Create and push `pimi-vX.Y.Z` at the tested commit. Watch both build jobs and verify the [published release](https://github.com/1ikeadragon/pimi/releases/latest).

Check the SHA-256 digest and verify attestations before installing downloaded artifacts:

```sh
gh attestation verify Pimi-macOS-arm64.dmg --repo 1ikeadragon/pimi
gh attestation verify Pimi-Windows-x64.exe --repo 1ikeadragon/pimi
```

The download page and the desktop updater both use the latest Pimi GitHub release. The macOS installer is ad hoc signed and the Windows installer is unsigned.

## Build locally

Run `npm ci` with the Node.js version in `.tool-versions`. Use `npm run pimi:package:mac` on Apple silicon or `npm run pimi:package:win` on Windows x64. Installers are written under `packages/desktop/release-pimi/`.
