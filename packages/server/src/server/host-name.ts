import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

let hostName: string | undefined;

// macOS's kernel hostname comes from DHCP/reverse DNS and can be "UNKNOWN";
// ComputerName is the name the user gave the Mac.
function readHostName(): string {
  if (process.platform !== "darwin") return hostname();
  const computerName = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
    encoding: "utf8",
  }).trim();
  // server_info.hostname is a plain string that clients show as the host label, so never empty.
  return computerName || hostname();
}

export function getHostName(): string {
  hostName ??= readHostName();
  return hostName;
}
