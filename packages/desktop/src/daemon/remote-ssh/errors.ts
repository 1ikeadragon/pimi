export type RemoteSshErrorCode =
  | "SSH_MISSING"
  | "SSH_AUTH"
  | "SSH_HOST_KEY"
  | "SSH_UNREACHABLE"
  | "SSH_TIMEOUT"
  | "SSH_FAILED"
  | "UNSUPPORTED_OS"
  | "UNSUPPORTED_ARCH"
  | "UNSUPPORTED_LIBC"
  | "MISSING_TOOLS"
  | "NODE_DOWNLOAD"
  | "NODE_CHECKSUM"
  | "NODE_EXTRACT"
  | "DISK_FULL"
  | "BUNDLE_DOWNLOAD"
  | "BUNDLE_CHECKSUM"
  | "BUNDLE_UNVERIFIED"
  | "UPLOAD_CHECKSUM"
  | "UPLOAD_MISSING"
  | "UPLOAD_FAILED"
  | "EXTRACT"
  | "BUNDLE_BROKEN"
  | "PORT_IN_USE"
  | "DAEMON_START"
  | "CANCELLED";

/** A failure with advice the user can act on. `message` is shown as is. */
export class RemoteSshError extends Error {
  readonly code: RemoteSshErrorCode;
  readonly detail: string | null;

  constructor(code: RemoteSshErrorCode, message: string, detail?: string | null) {
    super(message);
    this.name = "RemoteSshError";
    this.code = code;
    this.detail = detail?.trim() || null;
  }
}

const trim = (detail: string): string => detail.trim().slice(0, 600);

/** Maps a `PIMI_ERROR <CODE> <detail>` line from a remote script to an error with advice. */
export function errorFromRemoteScript(code: string, rawDetail: string): RemoteSshError {
  const detail = trim(rawDetail);
  switch (code) {
    case "DISK_FULL":
      return new RemoteSshError(
        "DISK_FULL",
        "The remote machine is out of disk space for ~/.pimi. Free some space in your home directory (the Pimi runtime needs about 1 GB), then try again.",
        detail,
      );
    case "NODE_DOWNLOAD":
      return new RemoteSshError(
        "NODE_DOWNLOAD",
        "The remote machine could not download Node.js from nodejs.org. Check that it has internet access (or a proxy configured for curl), or install Node.js 24 or newer on it yourself, then try again.",
        detail,
      );
    case "NODE_CHECKSUM":
      return new RemoteSshError(
        "NODE_CHECKSUM",
        "The Node.js download did not match the SHA-256 that this Pimi version pins for it, so Pimi discarded it. Try again; if it keeps failing, install Node.js 24 or newer on the remote machine.",
        detail,
      );
    case "NODE_EXTRACT":
      return new RemoteSshError(
        "NODE_EXTRACT",
        "Pimi could not unpack Node.js on the remote machine. Install Node.js 24 or newer there and try again.",
        detail,
      );
    case "MISSING_TOOLS":
      return new RemoteSshError(
        "MISSING_TOOLS",
        `The remote machine is missing a tool Pimi needs (${detail || "tar, curl or wget, sha256sum"}). Install it with the system package manager and try again.`,
        detail,
      );
    case "UPLOAD_CHECKSUM":
      return new RemoteSshError(
        "UPLOAD_CHECKSUM",
        "The uploaded daemon bundle was corrupted in transit. Try again; if it keeps failing, check the network between the two machines.",
        detail,
      );
    case "UPLOAD_MISSING":
      return new RemoteSshError(
        "UPLOAD_MISSING",
        "The daemon bundle never reached the remote machine. Try again.",
        detail,
      );
    case "EXTRACT":
      return new RemoteSshError(
        "EXTRACT",
        "Pimi could not unpack the daemon on the remote machine. Try again; if it keeps failing, delete ~/.pimi/runtime on the remote machine first.",
        detail,
      );
    case "BUNDLE_BROKEN":
      return new RemoteSshError(
        "BUNDLE_BROKEN",
        "The installed daemon on the remote machine is incomplete. Delete ~/.pimi/runtime there and connect again.",
        detail,
      );
    case "PORT_IN_USE":
      return new RemoteSshError(
        "PORT_IN_USE",
        "Another Pimi daemon that Pimi did not start is already using the daemon port on the remote machine. Stop it (pimi daemon stop) or choose a different daemon port, then try again.",
        detail,
      );
    case "DAEMON_START":
      return new RemoteSshError(
        "DAEMON_START",
        "The daemon was installed but did not start on the remote machine. Check ~/.pimi/daemon-remote.log there for the reason.",
        detail,
      );
    default:
      return new RemoteSshError("SSH_FAILED", `The remote setup failed (${code}).`, detail);
  }
}

/** Maps ssh's own stderr (before any remote script ran) to an error with advice. */
export function errorFromSshStderr(
  host: string,
  stderr: string,
  exitCode: number | null,
): RemoteSshError {
  const text = stderr.trim();
  const lower = text.toLowerCase();
  if (lower.includes("permission denied") || lower.includes("too many authentication failures")) {
    return new RemoteSshError(
      "SSH_AUTH",
      `SSH could not sign in to ${host}. Pimi uses your system ssh with BatchMode, so it needs a key that works without a prompt: run \`ssh ${host}\` in a terminal to check it, add the key to your ssh-agent (ssh-add), and try again.`,
      text,
    );
  }
  if (
    lower.includes("host key verification failed") ||
    lower.includes("host identification has changed")
  ) {
    return new RemoteSshError(
      "SSH_HOST_KEY",
      `The host key for ${host} does not match ~/.ssh/known_hosts. If the machine was reinstalled, remove the old entry with \`ssh-keygen -R ${host}\`; otherwise do not connect.`,
      text,
    );
  }
  if (
    lower.includes("could not resolve hostname") ||
    lower.includes("connection refused") ||
    lower.includes("no route to host") ||
    lower.includes("network is unreachable") ||
    lower.includes("connection reset") ||
    lower.includes("connection closed")
  ) {
    return new RemoteSshError(
      "SSH_UNREACHABLE",
      `Pimi could not reach ${host} over SSH. Check the host name, port, VPN and that sshd is running, then try again.`,
      text,
    );
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new RemoteSshError(
      "SSH_TIMEOUT",
      `The SSH connection to ${host} timed out. Check the network or VPN and try again.`,
      text,
    );
  }
  if (lower.includes("no space left on device")) {
    return errorFromRemoteScript("DISK_FULL", text);
  }
  return new RemoteSshError(
    "SSH_FAILED",
    `ssh to ${host} failed${exitCode === null ? "" : ` (exit ${exitCode})`}. Run \`ssh ${host}\` in a terminal to see why.`,
    text,
  );
}
