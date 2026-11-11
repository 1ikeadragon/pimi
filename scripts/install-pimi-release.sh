#!/bin/zsh
# Install a published Pimi macOS release into /Applications.
# Usage: scripts/install-pimi-release.sh 0.17.21   (waits for the release if CI is still building)
# Replacing the app restarts the Pimi daemon on port 6767, which stops running agents.
set -euo pipefail

version="${1:?usage: install-pimi-release.sh <version>}"
tag="pimi-v$version"
repo="1ikeadragon/pimi"
work="$(mktemp -d)"
trap 'hdiutil detach "$work/mnt" -quiet 2>/dev/null || true; rm -rf "$work"' EXIT

until gh release view "$tag" -R "$repo" --json assets -q '.assets[].name' 2>/dev/null | grep -q '^Pimi-macOS-arm64.dmg$'; do
  echo "Waiting for $tag to be published…"
  /bin/sleep 60
done

gh release download "$tag" -R "$repo" -D "$work" -p 'Pimi-macOS-arm64.dmg' -p 'SHA256SUMS.txt'
(cd "$work" && grep ' Pimi-macOS-arm64.dmg$' SHA256SUMS.txt | shasum -a 256 -c -)

mkdir "$work/mnt"
hdiutil attach "$work/Pimi-macOS-arm64.dmg" -mountpoint "$work/mnt" -nobrowse -quiet

osascript -e 'quit app "Pimi"' 2>/dev/null || true
/bin/sleep 3
rm -rf /Applications/Pimi.app
cp -R "$work/mnt/Pimi.app" /Applications/Pimi.app
xattr -dr com.apple.quarantine /Applications/Pimi.app 2>/dev/null || true
open /Applications/Pimi.app
echo "Installed Pimi $version."
