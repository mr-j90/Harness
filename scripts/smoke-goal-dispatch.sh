#!/usr/bin/env bash
set -euo pipefail
base=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
cleanup() {
  touch "$tmp/release1" "$tmp/release3"
  if [ -f "$tmp/pid" ]; then kill "$(cat "$tmp/pid")" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
mkdir -p "$tmp/repo" "$tmp/bin" "$tmp/state"
git init -q "$tmp/repo"
git -C "$tmp/repo" remote add origin https://github.com/example/goal.git
config() {
  cat > "$tmp/repo/.harness.toml" <<CONFIG
[repository]
github = "example/goal"
[standing_goal]
enabled = $1
github_assignee_allowlist = ["tester"]
CONFIG
}
config false
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env python3
import json
print(json.dumps([dict(number=n, title=f'Issue {n}', url=f'https://github.com/example/goal/issues/{n}', assignees=[dict(login='other' if n == 4 else 'tester')], state='OPEN') for n in (1, 2, 3, 4)]))
GH
cat > "$tmp/bin/manager" <<'MANAGER'
#!/usr/bin/env python3
import json, os, sys, time
p = json.load(sys.stdin)
with open(os.environ['SMOKE_DISPATCHES'], 'a') as f:
    f.write(json.dumps(p) + '\n')
    f.flush()
while not os.path.exists(os.path.join(os.environ['SMOKE_TMP'], 'release' + str(p['issue']['number']))):
    time.sleep(.05)
print(json.dumps(dict(outcome='blocked' if p['issue']['number'] == 3 else 'complete', summary='Fixture outcome')))
MANAGER
chmod +x "$tmp/bin/gh" "$tmp/bin/manager"
export PATH="$tmp/bin:$PATH" HARNESS_STATE_DIR="$tmp/state" HARNESS_MANAGER_BIN="$tmp/bin/manager" HARNESS_RECONCILE=0 SMOKE_DISPATCHES="$tmp/dispatches" SMOKE_TMP="$tmp"
cli() { bun "$base/src/cli.ts" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
wait_count() { for i in $(seq 1 100); do [ -f "$tmp/dispatches" ] && [ "$(wc -l < "$tmp/dispatches")" -ge "$1" ] && return; sleep .1; done; fail "expected $1 handoffs"; }
cli service start --json > "$tmp/start.json"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$tmp/start.json" > "$tmp/pid"
cli repo attach "$tmp/repo" >/dev/null
cli goal set --repo example/goal --objective original --priority 1 --expected-revision 0 >/dev/null
config true
cli repo attach "$tmp/repo" >/dev/null
wait_count 1
cli goal pause --repo example/goal >/dev/null
cli goal set --repo example/goal --objective updated --priority 999,4,3,2 --expected-revision 1 >/dev/null
if cli goal set --repo example/goal --objective stale --priority 2 --expected-revision 1 >/dev/null 2>&1; then fail 'stale revision was accepted'; fi
sleep .3
[ "$(wc -l < "$tmp/dispatches")" -eq 1 ] || fail 'active work was duplicated or paused project dispatched'
cli goal resume --repo example/goal >/dev/null
sleep .3
[ "$(wc -l < "$tmp/dispatches")" -eq 1 ] || fail 'active work was interrupted or duplicated'
touch "$tmp/release1"
wait_count 2
cli goal pause --repo example/goal >/dev/null
python3 - "$tmp/dispatches" <<'PY'
import json, sys
p = [json.loads(line) for line in open(sys.argv[1])]
assert [x['issue']['number'] for x in p] == [1, 3], p
assert p[0]['goal']['objective'] == 'original' and p[0]['goal']['revision'] == 1
assert p[1]['goal']['objective'] == 'updated' and p[1]['goal']['priorityIssues'] == [999, 4, 3, 2] and p[1]['goal']['revision'] == 2
assert p[0]['run_id'] != p[1]['run_id']
PY
touch "$tmp/release3"
for i in $(seq 1 100); do [ "$(sqlite3 "$tmp/state/manager.sqlite" "select state from claims where issue_number=3;")" = blocked ] && break; sleep .1; done
[ "$(sqlite3 "$tmp/state/manager.sqlite" "select state from claims where issue_number=3;")" = blocked ] || fail 'blocked result was not recorded'
cli goal set --repo example/goal --objective newer --priority 3,2 --expected-revision 2 >/dev/null
cli goal resume --repo example/goal >/dev/null
wait_count 3
python3 - "$tmp/dispatches" <<'PY'
import json, sys
p = [json.loads(line) for line in open(sys.argv[1])]
assert [x['issue']['number'] for x in p] == [1, 3, 2], p
assert p[2]['goal']['revision'] == 3
PY
touch "$tmp/release2"
cli service shutdown >/dev/null
echo 'PASS: revisions, pause, conflict, eligible priority and blocked claims across active handoffs'
