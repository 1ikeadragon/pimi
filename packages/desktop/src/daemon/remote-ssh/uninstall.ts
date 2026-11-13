import { REMOTE_DAEMON_PORT_DEFAULT } from "./bundle-spec.js";
import { parseFacts, runRemoteScript, type SshTarget } from "./ssh-exec.js";

// Removal of what the installer put on a remote dev machine. Self-contained on purpose: the
// install scripts live in remote-scripts.ts, and a cleanup must not break when they change.

export interface RemoteUninstallTarget extends SshTarget {
  daemonPort?: number;
}

/** What is on the remote machine right now, for the confirm sheet. Counts are null when unknown. */
export interface RemoteUninstallCheck {
  /** Version reported by the daemon that answers on the port, null when none answers. */
  daemonVersion: string | null;
  /** A daemon answers on the port but does not hold ~/.pimi, so uninstall leaves it alone. */
  foreignDaemon: boolean;
  /** Agents that are running or starting. Null when the running daemon could not be asked. */
  busyAgents: number | null;
  /** Open terminals. Null when the running daemon could not be asked. */
  terminals: number | null;
  /** A `pimi-daemon.service` systemd user unit exists. */
  systemdUnit: boolean;
  runtimeKb: number | null;
  dataKb: number | null;
  /** Worktrees Pimi created under ~/.pimi/worktrees. They can hold uncommitted work. */
  worktrees: number;
}

export type RemoteUninstallStep = "connecting" | "stopping" | "removing" | "done";

export interface RemoteUninstallProgress {
  step: RemoteUninstallStep;
  message: string;
}

export type RemoteUninstallRemoved = "service" | "daemon" | "terminals" | "runtime" | "data";
export type RemoteUninstallKept = "data" | "foreignDaemon";

/** What the script did, one entry per `removed=` or `kept=` line it printed. */
export interface RemoteUninstallResult {
  removed: RemoteUninstallRemoved[];
  kept: RemoteUninstallKept[];
  /** The systemd unit could not be disabled; it was deleted anyway. */
  serviceWarning: boolean;
}

const PREAMBLE = String.raw`
fail() { printf 'PIMI_ERROR %s %s\n' "$1" "$2"; exit 10; }
case "$HOME" in /?*) ;; *) fail UNSAFE_HOME "HOME is not an absolute path below /" ;; esac
PIMI_DIR="$HOME/.pimi"
RUNTIME_DIR="$PIMI_DIR/runtime"
UNIT="$HOME/.config/systemd/user/pimi-daemon.service"
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then wget -q -T 3 -O - "$1" 2>/dev/null
  elif [ -n "$PIMI_NODE" ]; then "$PIMI_NODE" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))' "$1"
  else return 1; fi
}
PIMI_NODE=""
for n in "$(command -v node 2>/dev/null)" "$RUNTIME_DIR"/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ] && [ -z "$PIMI_NODE" ]; then PIMI_NODE="$n"; fi
done
# The pid of the daemon that holds ~/.pimi, printed only when that process is alive and is a Pimi
# process (a stale pid file can name a process that has since been reused).
daemon_pid() {
  pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$PIMI_DIR/pimi.pid" 2>/dev/null | head -n 1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qi 'pimi' || return 1
  fi
  printf %s "$pid"
}
# Terminal workers outlive the daemon so terminals survive a restart. Only the ones that were
# started for this ~/.pimi are listed.
worker_pids() {
  ps -eo pid=,args= 2>/dev/null | while read -r wpid wargs; do
    case "$wargs" in
      *"--pimi-terminal-worker "*"--pimi-home $PIMI_DIR "*|*"--pimi-terminal-worker "*"--pimi-home $PIMI_DIR") echo "$wpid" ;;
    esac
  done
}
`;

// $1 = daemon port. Prints one fact per line, changes nothing.
const CHECK_SCRIPT = `${PREAMBLE}
PORT="$1"
st="$(http_get "http://127.0.0.1:$PORT/api/status" | tr -d '\\n')"
echo "status=$st"
ours=""
daemon_pid >/dev/null && ours=1
[ -n "$st" ] && [ -z "$ours" ] && echo "foreign=1"
if [ -n "$st" ] && [ -n "$ours" ]; then
  CLI="$RUNTIME_DIR/current/node_modules/@pimi/cli/bin/pimi"
  if [ -f "$CLI" ] && [ -n "$PIMI_NODE" ]; then
    agents="$("$PIMI_NODE" "$CLI" agent ls --global --background --home "$PIMI_DIR" --json 2>/dev/null)"
    agents_rc=$?
    terms="$("$PIMI_NODE" "$CLI" terminal ls --all --home "$PIMI_DIR" --json 2>/dev/null)"
    terms_rc=$?
    if [ "$agents_rc" = 0 ] && [ "$terms_rc" = 0 ]; then
      echo "busyAgents=$(printf %s "$agents" | grep -Eo '"status": ?"(running|initializing)"' | wc -l | tr -d ' ')"
      echo "terminals=$(printf %s "$terms" | grep -Eo '"id": ?"' | wc -l | tr -d ' ')"
    fi
  fi
fi
[ -f "$UNIT" ] && echo "unit=1"
echo "runtimeKb=$(du -sk "$RUNTIME_DIR" 2>/dev/null | cut -f1)"
echo "dataKb=$(du -sk "$PIMI_DIR" 2>/dev/null | cut -f1)"
n=0
for d in "$PIMI_DIR"/worktrees/*/*/; do
  [ -d "$d" ] && n=$((n+1))
done
echo "worktrees=$n"
exit 0
`;

// $1 = daemon port, $2 = 1 to delete ~/.pimi as well, 0 to keep everything but the runtime.
// Order matters: the service goes first so systemd does not restart the daemon, then the daemon
// that holds ~/.pimi, then its terminal workers, and only when nothing answers on the port are
// files removed. Every rm -rf names a fixed path below a $HOME that was checked above.
const UNINSTALL_SCRIPT = `${PREAMBLE}
PORT="$1"; WIPE="$2"
echo "PIMI_STEP stopping"
if [ -f "$UNIT" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now pimi-daemon.service >/dev/null 2>&1 || echo "serviceWarning=1"
  fi
  rm -f "$UNIT"
  command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1
  echo "removed=service"
fi
pid="$(daemon_pid)"
if [ -n "$pid" ]; then
  kill -TERM "$pid" 2>/dev/null
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i+1)); done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 0.5; i=$((i+1)); done
  kill -0 "$pid" 2>/dev/null && fail UNINSTALL_STOP "process $pid did not exit"
  echo "removed=daemon"
fi
workers="$(worker_pids)"
if [ -n "$workers" ]; then
  for w in $workers; do kill -TERM "$w" 2>/dev/null; done
  i=0
  while [ "$i" -lt 10 ] && [ -n "$(worker_pids)" ]; do sleep 0.5; i=$((i+1)); done
  for w in $(worker_pids); do kill -KILL "$w" 2>/dev/null; done
  echo "removed=terminals"
fi
st="$(http_get "http://127.0.0.1:$PORT/api/status" | tr -d '\\n')"
if [ -n "$st" ]; then
  # Something else owns the port. It does not hold ~/.pimi, so it is not ours to stop.
  echo "kept=foreignDaemon"
fi
echo "PIMI_STEP removing"
rm -f "$PIMI_DIR/pimi.pid"
if [ "$WIPE" = 1 ]; then
  rm -rf "$PIMI_DIR" || fail UNINSTALL_REMOVE "could not delete $PIMI_DIR"
  echo "removed=data"
else
  if [ -e "$RUNTIME_DIR" ]; then
    rm -rf "$RUNTIME_DIR" || fail UNINSTALL_REMOVE "could not delete $RUNTIME_DIR"
    echo "removed=runtime"
  fi
  rm -f "$PIMI_DIR/daemon-remote.log"
  [ -e "$PIMI_DIR" ] && echo "kept=data"
fi
exit 0
`;

const portOf = (target: RemoteUninstallTarget): string =>
  String(target.daemonPort ?? REMOTE_DAEMON_PORT_DEFAULT);

const sshTargetOf = (target: RemoteUninstallTarget): SshTarget => ({
  host: target.host,
  ...(target.sshPort !== undefined ? { sshPort: target.sshPort } : {}),
});

function kbOf(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseCheck(stdout: string): RemoteUninstallCheck {
  const facts = parseFacts(stdout);
  const one = (key: string): string | undefined => facts.get(key)?.[0];
  let daemonVersion: string | null = null;
  const rawStatus = one("status");
  if (rawStatus) {
    try {
      const parsed = JSON.parse(rawStatus) as { version?: unknown };
      daemonVersion = typeof parsed.version === "string" ? parsed.version : "unknown";
    } catch {
      daemonVersion = "unknown";
    }
  }
  return {
    daemonVersion,
    foreignDaemon: facts.has("foreign"),
    busyAgents: kbOf(one("busyAgents")),
    terminals: kbOf(one("terminals")),
    systemdUnit: facts.has("unit"),
    runtimeKb: kbOf(one("runtimeKb")),
    dataKb: kbOf(one("dataKb")),
    worktrees: kbOf(one("worktrees")) ?? 0,
  };
}

/** Looks at the remote machine without changing it. */
export async function checkRemoteUninstall(
  target: RemoteUninstallTarget,
  options: { signal?: AbortSignal } = {},
): Promise<RemoteUninstallCheck> {
  const out = await runRemoteScript(sshTargetOf(target), CHECK_SCRIPT, [portOf(target)], {
    signal: options.signal,
    timeoutMs: 60_000,
  });
  return parseCheck(out);
}

const REMOVED = new Set<string>(["service", "daemon", "terminals", "runtime", "data"]);
const KEPT = new Set<string>(["data", "foreignDaemon"]);

function parseResult(stdout: string): RemoteUninstallResult {
  const facts = parseFacts(stdout);
  return {
    removed: (facts.get("removed") ?? []).filter((item): item is RemoteUninstallRemoved =>
      REMOVED.has(item),
    ),
    kept: (facts.get("kept") ?? []).filter((item): item is RemoteUninstallKept => KEPT.has(item)),
    serviceWarning: facts.has("serviceWarning"),
  };
}

/**
 * Stops the daemon and removes the runtime on the remote machine, and with `deleteData` also
 * ~/.pimi. The caller owns the "this machine is being uninstalled" mark that keeps the app from
 * reinstalling the daemon while this runs.
 */
export async function uninstallRemoteDaemon(
  target: RemoteUninstallTarget,
  options: {
    deleteData: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: RemoteUninstallProgress) => void;
  },
): Promise<RemoteUninstallResult> {
  const report = (step: RemoteUninstallStep, message: string) =>
    options.onProgress?.({ step, message });
  report("connecting", `Connecting to ${target.host}`);
  const out = await runRemoteScript(
    sshTargetOf(target),
    UNINSTALL_SCRIPT,
    [portOf(target), options.deleteData ? "1" : "0"],
    {
      signal: options.signal,
      timeoutMs: 3 * 60_000,
      onStep: (step) => {
        if (step === "stopping") report("stopping", `Stopping Pimi on ${target.host}`);
        else if (step === "removing") report("removing", `Removing files on ${target.host}`);
      },
    },
  );
  report("done", `Pimi was removed from ${target.host}`);
  return parseResult(out);
}
