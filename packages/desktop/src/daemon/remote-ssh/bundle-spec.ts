// What the remote dev machine needs to run the daemon. scripts/build-daemon-bundle.mjs checks
// REMOTE_NODE_VERSION against .tool-versions, so the Node the bundle was built for and the Node
// the installer downloads cannot drift apart.
export const REMOTE_NODE_VERSION = "24.15.0";
// SHA-256 of the official linux tarballs for REMOTE_NODE_VERSION. The remote compares the download
// against these and never trusts a checksum file served next to the tarball. Taken from nodejs.org's
// SHASUMS256.txt and verified with its GPG signature (SHASUMS256.txt.asc, Node release key
// 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356) on 2026-11-13. Update them with REMOTE_NODE_VERSION.
export const REMOTE_NODE_SHA256 = {
  x64: "44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89",
  arm64: "73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed",
} as const;
export const REMOTE_NODE_MIN_MAJOR = 24;
export const REMOTE_DAEMON_PORT_DEFAULT = 6767;
export const REMOTE_BUNDLE_ARCHES = ["x64", "arm64"] as const;
export type RemoteBundleArch = (typeof REMOTE_BUNDLE_ARCHES)[number];

export function remoteBundleAssetName(arch: RemoteBundleArch): string {
  return `Pimi-daemon-linux-${arch}.tar.gz`;
}
