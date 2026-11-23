#!/usr/bin/env bash
set -euo pipefail
base=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
cleanup() {
  touch "$tmp/release"
  if [ -f "$tmp/pid" ]; then kill "$(cat "$tmp/pid")" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
mkdir -p "$tmp/repo" "$tmp/bin" "$tmp/state"
git init -q "$tmp/repo"
git -C "$tmp/repo" remote add origin https://github.com/example/shutdown.git
cat > "$tmp/repo/.harness.toml" <<'CONFIG'
[repository]
github = "example/shutdown"
[standing_goal]
enabled = true
github_assignee_allowlist = ["tester"]
CONFIG
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env python3
import json
print(json.dumps([dict(number=n, title=f'Issue {n}', url=f'https://github.com/example/shutdown/issues/{n}', assignees=[dict(login='tester')], state='OPEN') for n in (1, 2)]))
GH
cat > "$tmp/bin/manager" <<'MANAGER'
#!/usr/bin/env python3
import json, os, sys, time
payload = json.load(sys.stdin)
with open(os.environ['SMOKE_DISPATCHES'], 'a') as f:
    f.write(str(payload['issue']['number']) + '\n')
while not os.path.exists(os.environ['SMOKE_RELEASE']):
    time.sleep(.05)
print(json.dumps(dict(outcome='complete', summary='Fixture finished active work')))
MANAGER
chmod +x "$tmp/bin/gh" "$tmp/bin/manager"
export PATH="$tmp/bin:$PATH" HARNESS_STATE_DIR="$tmp/state" HARNESS_MANAGER_BIN="$tmp/bin/manager" HARNESS_RECONCILE=0 SMOKE_DISPATCHES="$tmp/dispatches" SMOKE_RELEASE="$tmp/release"
cli() { bun "$base/src/cli.ts" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cli service start --json > "$tmp/start.json"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$tmp/start.json" > "$tmp/pid"
cli repo attach "$tmp/repo" >/dev/null
for i in $(seq 1 100); do [ -s "$tmp/dispatches" ] && break; sleep .1; done
[ -s "$tmp/dispatches" ] || fail 'manager did not start'
cli service shutdown --json > "$tmp/shutdown.json" || fail 'shutdown was rejected while work was active'
python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["draining"] is True and v["active"] == 1' "$tmp/shutdown.json" || fail 'shutdown did not report active drain'
cli service status --json > "$tmp/status.json"
python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["draining"] is True and v["active"] == 1' "$tmp/status.json" || fail 'status did not report active drain'
kill -0 "$(cat "$tmp/pid")" 2>/dev/null || fail 'daemon exited before active work finished'
# Starting during the drain must not replace the live daemon.
if cli service start --json > "$tmp/restart.json" 2>/dev/null; then
  restart_pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$tmp/restart.json")
  [ "$restart_pid" = "$(cat "$tmp/pid")" ] || { kill "$restart_pid" 2>/dev/null || true; fail 'second daemon started while draining'; }
fi
touch "$tmp/release"
for i in $(seq 1 100); do kill -0 "$(cat "$tmp/pid")" 2>/dev/null || break; sleep .1; done
kill -0 "$(cat "$tmp/pid")" 2>/dev/null && fail 'daemon did not exit after active work finished'
[ "$(cat "$tmp/dispatches")" = 1 ] || fail 'pending issue was dispatched during shutdown'
[ "$(sqlite3 "$tmp/state/manager.sqlite" "select state || ':' || summary from claims where issue_number=1;")" = 'complete:Fixture finished active work' ] || fail 'active outcome was not recorded'
[ "$(sqlite3 "$tmp/state/manager.sqlite" 'select count(*) from claims where issue_number=2;')" = 0 ] || fail 'pending issue was claimed'
# Empty state exercises immediate shutdown without starting more issue work.
export HARNESS_STATE_DIR="$tmp/empty"
cli service start --json > "$tmp/empty-start.json"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$tmp/empty-start.json" > "$tmp/pid"
cli service shutdown >/dev/null || fail 'idle shutdown was rejected'
for i in $(seq 1 100); do kill -0 "$(cat "$tmp/pid")" 2>/dev/null || break; sleep .1; done
kill -0 "$(cat "$tmp/pid")" 2>/dev/null && fail 'idle daemon did not exit'
echo 'PASS: shutdown drains active work, prevents further dispatch and exits; idle shutdown exits'
