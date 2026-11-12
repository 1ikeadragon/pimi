import { getDaemonNetworkActivity } from "./activity.js";

// Imported first by the daemon's entry module. Importing it installs the Network tab's hooks
// (HTTP, sockets, DNS, child processes) before any other module is evaluated, so a dependency
// that grabs a function from node:child_process or node:dns while loading gets the observed
// one, and requests made during startup are not missed.
export const networkHooksInstalled = getDaemonNetworkActivity() !== null;
