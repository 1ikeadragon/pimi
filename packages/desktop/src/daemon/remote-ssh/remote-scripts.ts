// POSIX sh scripts that run on the remote dev machine through `ssh host sh -s -- <args>`. They
// print `key=value` lines (probe) or `PIMI_STEP <name>` markers, and report a failure as
// `PIMI_ERROR <CODE> <detail>` with exit status 10. The login shell on the remote can be anything,
// so nothing here depends on bash.

const PREAMBLE = String.raw`
fail() { printf 'PIMI_ERROR %s %s\n' "$1" "$2"; exit 10; }
PIMI_DIR="$HOME/.pimi"
RUNTIME_DIR="$PIMI_DIR/runtime"
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else fail MISSING_TOOLS "sha256sum"; fi
}
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then wget -q -T 3 -O - "$1" 2>/dev/null
  elif [ -n "$PIMI_NODE" ]; then "$PIMI_NODE" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))' "$1"
  else return 1; fi
}
# The status endpoint answers before the websocket server accepts clients (it answers 503
# until then), so health means a websocket upgrade succeeds.
ws_ready() {
  [ -n "$PIMI_NODE" ] || return 1
  "$PIMI_NODE" -e 'const h=require("http");const r=h.request({host:"127.0.0.1",port:Number(process.argv[1]),path:"/ws",timeout:3000,headers:{Connection:"Upgrade",Upgrade:"websocket","Sec-WebSocket-Version":"13","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ=="}});r.on("upgrade",(res,sock)=>{sock.destroy();process.exit(0)});r.on("response",()=>process.exit(1));r.on("error",()=>process.exit(1));r.on("timeout",()=>process.exit(1));r.end()' "$1" >/dev/null 2>&1
}
`;

// $1 = daemon port, $2 = the version the desktop needs. Prints one fact per line.
export const PROBE_SCRIPT = `${PREAMBLE}
PORT="$1"
WANT_VERSION="$2"
echo "os=$(uname -s 2>/dev/null)"
echo "machine=$(uname -m 2>/dev/null)"
echo "home=$HOME"
if ldd --version 2>&1 | grep -qi musl; then echo "libc=musl"; else echo "libc=glibc"; fi
echo "diskKb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
for t in curl wget tar sha256sum shasum openssl setsid nohup; do
  command -v "$t" >/dev/null 2>&1 && echo "tool.$t=1"
done
PIMI_NODE=""
for n in "$(command -v node 2>/dev/null)" "$RUNTIME_DIR"/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ]; then
    v="$("$n" -v 2>/dev/null)"
    [ -n "$v" ] && echo "node=$n $v" && [ -z "$PIMI_NODE" ] && PIMI_NODE="$n"
  fi
done
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then echo "systemd=1"; fi
[ -f "$HOME/.config/systemd/user/pimi-daemon.service" ] && echo "unit=1"
for f in "$RUNTIME_DIR"/*/bundle.json; do
  [ -f "$f" ] && echo "runtime=$(basename "$(dirname "$f")")"
done
st="$(http_get "http://127.0.0.1:$PORT/api/status" | tr -d '\\n')"
echo "status=$st"
[ -n "$st" ] && ws_ready "$PORT" && echo "wsReady=1"
[ -f "$PIMI_DIR/pimi.pid" ] && echo "lock=$(tr -d '\\n' < "$PIMI_DIR/pimi.pid")"
# Work a running daemon has, so an upgrade never stops it silently. Only an upgrade needs it, and
# counting starts Node twice, so a daemon already at the wanted version skips it.
if [ -n "$st" ] && [ -f "$PIMI_DIR/pimi.pid" ] && [ -n "$PIMI_NODE" ] && ! printf %s "$st" | grep -Fq '"version":"'"$WANT_VERSION"'"'; then
  CLI="$RUNTIME_DIR/current/node_modules/@pimi/cli/bin/pimi"
  if [ -f "$CLI" ]; then
    agents="$("$PIMI_NODE" "$CLI" agent ls --global --background --home "$PIMI_DIR" --json 2>/dev/null)"
    agents_rc=$?
    terms="$("$PIMI_NODE" "$CLI" terminal ls --all --home "$PIMI_DIR" --json 2>/dev/null)"
    terms_rc=$?
    if [ "$agents_rc" = 0 ] && [ "$terms_rc" = 0 ]; then
      echo "busyAgents=$(printf %s "$agents" | grep -Eo '"status": ?"(running|initializing)"' | wc -l | tr -d ' ')"
      echo "terminals=$(printf %s "$terms" | grep -Eo '"id": ?"' | wc -l | tr -d ' ')"
    else
      echo "activity=unknown"
    fi
  else
    echo "activity=unknown"
  fi
fi
exit 0
`;

// $1 = bytes of free space the install needs, in KB.
export const PREPARE_SCRIPT = `${PREAMBLE}
mkdir -p "$RUNTIME_DIR" || fail DISK_FULL "cannot create $RUNTIME_DIR"
rm -rf "$RUNTIME_DIR"/.incoming-* "$RUNTIME_DIR"/.stage-* "$RUNTIME_DIR"/.node-dl-*
free="$(df -Pk "$RUNTIME_DIR" | awk 'NR==2{print $4}')"
[ -n "$free" ] && [ "$free" -lt "$1" ] && fail DISK_FULL "$free KB free, $1 KB needed"
exit 0
`;

// $1 = node version, $2 = x64|arm64, $3 = expected sha256 of the tarball, embedded in the desktop.
// The remote never fetches a checksum file: one served next to the tarball proves nothing.
// Prints nodePath=... on success.
export const NODE_SCRIPT = `${PREAMBLE}
V="$1"; A="$2"; WANT="$3"
case "$WANT" in *[!0-9a-f]*|"") fail NODE_CHECKSUM "no pinned checksum for node $V $A" ;; esac
[ "$(printf %s "$WANT" | wc -c | tr -d ' ')" = 64 ] || fail NODE_CHECKSUM "no pinned checksum for node $V $A"
file="node-v$V-linux-$A.tar.gz"
base="https://nodejs.org/dist/v$V"
dest="$RUNTIME_DIR/node/v$V-linux-$A"
if [ -x "$dest/bin/node" ]; then echo "nodePath=$dest/bin/node"; exit 0; fi
tmp="$RUNTIME_DIR/.node-dl-$$"
mkdir -p "$tmp" || fail DISK_FULL "cannot create $tmp"
trap 'rm -rf "$tmp"' EXIT
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 15 --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -T 30 -O "$2" "$1"
  else fail MISSING_TOOLS "curl or wget"; fi
}
echo "PIMI_STEP node-download"
fetch "$base/$file" "$tmp/$file" 2>"$tmp/err" || {
  if grep -qi "no space" "$tmp/err"; then fail DISK_FULL "$(tr '\\n' ' ' < "$tmp/err")"; fi
  fail NODE_DOWNLOAD "$(tr '\\n' ' ' < "$tmp/err")"
}
got="$(sha256_of "$tmp/$file")"
[ "$got" = "$WANT" ] || fail NODE_CHECKSUM "expected $WANT, got $got"
echo "PIMI_STEP node-extract"
tar -xzf "$tmp/$file" -C "$tmp" 2>"$tmp/err" || {
  if grep -qi "no space" "$tmp/err"; then fail DISK_FULL "$(tr '\\n' ' ' < "$tmp/err")"; fi
  fail NODE_EXTRACT "$(tr '\\n' ' ' < "$tmp/err")"
}
mkdir -p "$RUNTIME_DIR/node"
rm -rf "$dest"
mv "$tmp/node-v$V-linux-$A" "$dest" || fail NODE_EXTRACT "cannot move node into place"
"$dest/bin/node" -v >/dev/null 2>&1 || fail NODE_EXTRACT "the downloaded node does not run (wrong libc?)"
echo "nodePath=$dest/bin/node"
exit 0
`;

// $1 = version. Receives the bundle on stdin.
export const UPLOAD_COMMAND = (version: string): string =>
  `sh -c 'mkdir -p "$HOME/.pimi/runtime" && cat > "$HOME/.pimi/runtime/.incoming-${version}.tar.gz"'`;

// $1 = version, $2 = expected sha256 of the uploaded archive.
export const EXTRACT_SCRIPT = `${PREAMBLE}
V="$1"; WANT="$2"
f="$RUNTIME_DIR/.incoming-$V.tar.gz"
[ -f "$f" ] || fail UPLOAD_MISSING "the uploaded bundle is not on the remote"
got="$(sha256_of "$f")"
[ "$got" = "$WANT" ] || fail UPLOAD_CHECKSUM "expected $WANT, got $got"
stage="$RUNTIME_DIR/.stage-$V"
rm -rf "$stage"; mkdir -p "$stage"
tar -xzf "$f" -C "$stage" 2>"$stage.err" || {
  if grep -qi "no space" "$stage.err"; then fail DISK_FULL "$(tr '\\n' ' ' < "$stage.err")"; fi
  fail EXTRACT "$(tr '\\n' ' ' < "$stage.err")"
}
rm -f "$stage.err"
[ -f "$stage/bundle.json" ] || fail EXTRACT "bundle.json missing from the archive"
mkdir -p "$stage/bin"
rm -rf "$RUNTIME_DIR/$V"
mv "$stage" "$RUNTIME_DIR/$V" || fail EXTRACT "cannot move the bundle into place"
rm -f "$f"
echo "installed=$V"
exit 0
`;

// $1 version, $2 port, $3 node path, $4 service (nohup|systemd), $5 restart even if healthy (1|0)
// Stops the daemon that holds ~/.pimi (if any), starts the requested version bound to
// 127.0.0.1, waits for /api/status to report that version, then prunes old runtimes.
export const START_SCRIPT = `${PREAMBLE}
V="$1"; PORT="$2"; PIMI_NODE="$3"; SERVICE="$4"; FORCE="$5"
RT="$RUNTIME_DIR/$V"
ENTRY="$RT/node_modules/@pimi/server/dist/scripts/supervisor-entrypoint.js"
CLI="$RT/node_modules/@pimi/cli/bin/pimi"
LOG="$PIMI_DIR/daemon-remote.log"
UNIT="$HOME/.config/systemd/user/pimi-daemon.service"
[ -f "$ENTRY" ] || fail BUNDLE_BROKEN "$ENTRY is missing"
[ -x "$PIMI_NODE" ] || fail BUNDLE_BROKEN "node not found at $PIMI_NODE"
mkdir -p "$PIMI_DIR"

# The runtime's own pimi wrapper: agents and terminals on the remote run it without node on PATH.
cat > "$RT/bin/pimi" <<WRAP
#!/bin/sh
exec "$PIMI_NODE" --disable-warning=DEP0040 "$CLI" "\\$@"
WRAP
chmod +x "$RT/bin/pimi"

# A non-interactive ssh command skips ~/.bashrc and friends, so the PATH it gets lacks where users
# install agent CLIs (opencode, claude, codex, nvm). Ask the user's own login shell for its PATH.
USER_PATH=""
if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then
  # -i also reads ~/.bashrc/~/.zshrc, where installers add their PATH; it needs the timeout in case
  # an rc file waits for input.
  if command -v timeout >/dev/null 2>&1; then SHELL_RUN="timeout 10 $SHELL -ilc"; else SHELL_RUN="$SHELL -lc"; fi
  USER_PATH="$($SHELL_RUN 'printf "PIMI_PATH<%s>PIMI_PATH" "$(printenv PATH)"' 2>/dev/null < /dev/null | sed -n 's/.*PIMI_PATH<\\(.*\\)>PIMI_PATH.*/\\1/p' | tail -n 1)"
fi
# Only plain path characters go into a unit file or an environment assignment.
case "$USER_PATH" in *[!A-Za-z0-9._:/+@~-]*) USER_PATH="" ;; esac
DAEMON_PATH="$(dirname "$PIMI_NODE")"
[ -n "$USER_PATH" ] && DAEMON_PATH="$DAEMON_PATH:$USER_PATH"

stop_running() {
  echo "PIMI_STEP stopping"
  if [ -f "$UNIT" ] && command -v systemctl >/dev/null 2>&1; then systemctl --user stop pimi-daemon.service >/dev/null 2>&1; fi
  pid="$(sed -n 's/.*"pid": *\\([0-9][0-9]*\\).*/\\1/p' "$PIMI_DIR/pimi.pid" 2>/dev/null | head -n 1)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i+1)); done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  fi
}

running_version="$(http_get "http://127.0.0.1:$PORT/api/status" | sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p')"
if [ "$running_version" != "$V" ] || [ "$FORCE" = "1" ]; then
  if [ -n "$running_version" ]; then
    # Only a daemon that holds ~/.pimi can be stopped here; anything else owns the port.
    [ -f "$PIMI_DIR/pimi.pid" ] || fail PORT_IN_USE "a Pimi daemon $running_version that this install did not start is listening on port $PORT"
  fi
  stop_running
  echo "PIMI_STEP starting"
  if [ "$SERVICE" = "systemd" ]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$UNIT" <<UNITEOF
[Unit]
Description=Pimi daemon
After=network.target

[Service]
Type=simple
Environment="PIMI_HOME=$PIMI_DIR"
Environment="PIMI_LISTEN=127.0.0.1:$PORT"
Environment="PIMI_NODE_ENV=production"
Environment="PIMI_CLI=$RT/bin/pimi"
Environment="PATH=$DAEMON_PATH:/usr/local/bin:/usr/bin:/bin"
WorkingDirectory=$HOME
ExecStart="$PIMI_NODE" "$ENTRY"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNITEOF
    systemctl --user daemon-reload && systemctl --user enable --now pimi-daemon.service >/dev/null 2>&1 \\
      || fail DAEMON_START "systemctl --user could not start pimi-daemon.service"
  else
    if [ -f "$UNIT" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable pimi-daemon.service >/dev/null 2>&1
      rm -f "$UNIT"
    fi
    cd "$HOME" || exit 1
    if command -v setsid >/dev/null 2>&1; then LAUNCH="setsid"; else LAUNCH=""; fi
    (
      PIMI_HOME="$PIMI_DIR" PIMI_LISTEN="127.0.0.1:$PORT" PIMI_NODE_ENV=production PIMI_CLI="$RT/bin/pimi" \\
      PATH="$DAEMON_PATH:$PATH" \\
      nohup $LAUNCH "$PIMI_NODE" "$ENTRY" >> "$LOG" 2>&1 < /dev/null &
    )
  fi
fi
i=0
while [ "$i" -lt 80 ]; do
  now="$(http_get "http://127.0.0.1:$PORT/api/status" | sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p')"
  [ "$now" = "$V" ] && ws_ready "$PORT" && break
  sleep 0.5; i=$((i+1))
done
[ "$now" = "$V" ] && ws_ready "$PORT" || fail DAEMON_START "the daemon did not accept connections as version $V on port $PORT. $(tail -n 8 "$LOG" 2>/dev/null | tr '\\n' ' ')"
ln -sfn "$RT" "$RUNTIME_DIR/current"
# Keep the running version and the one before it; drop the rest.
for d in "$RUNTIME_DIR"/*/; do
  name="$(basename "$d")"
  case "$name" in node|"$V") continue ;; esac
  [ -f "$d/bundle.json" ] || continue
  ls -1dt "$RUNTIME_DIR"/*/bundle.json 2>/dev/null | sed -n '3,$p' | grep -q "/$name/" && rm -rf "$d"
done
echo "running=$V"
exit 0
`;
