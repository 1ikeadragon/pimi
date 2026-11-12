// What the remote dev machine needs to run the daemon. scripts/build-daemon-bundle.mjs checks
// REMOTE_NODE_VERSION against .tool-versions, so the Node the bundle was built for and the Node
// the installer downloads cannot drift apart.
export const REMOTE_NODE_VERSION = "24.15.0";
export const REMOTE_NODE_MIN_MAJOR = 24;
export const REMOTE_DAEMON_PORT_DEFAULT = 6767;
export const REMOTE_BUNDLE_ARCHES = ["x64", "arm64"] as const;
export type RemoteBundleArch = (typeof REMOTE_BUNDLE_ARCHES)[number];

export function remoteBundleAssetName(arch: RemoteBundleArch): string {
  return `Pimi-daemon-linux-${arch}.tar.gz`;
}
