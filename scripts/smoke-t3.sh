#!/usr/bin/env bash
set -euo pipefail
base=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
cleanup() { HARNESS_STATE_DIR="$tmp/state" bun "$base/src/cli.ts" service stop >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/repo" "$tmp/bin" "$tmp/t3/userdata" "$tmp/state"
git init -q "$tmp/repo"
git -C "$tmp/repo" remote add origin https://github.com/example/smoke.git
cat > "$tmp/repo/.harness.toml" <<'CONFIG'
[repository]
github = "example/smoke"
[standing_goal]
enabled = true
github_assignee_allowlist = ["tester"]
CONFIG
sqlite3 "$tmp/t3/userdata/statev2.sqlite" 'CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);'
sqlite3 "$tmp/t3/userdata/statev2.sqlite" "INSERT INTO projection_projects VALUES ('project', '$tmp/repo', NULL);"
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env python3
import json
print(json.dumps([dict(number=n,title=f'Issue {n}',url=f'https://github.com/example/smoke/issues/{n}',assignees=[dict(login='tester')],state='OPEN') for n in (1,2)]))
GH
cat > "$tmp/bin/t3" <<'T3'
#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
if args[:2] == ['thread','list']:
 print(json.dumps([dict(threadId='thread',projectId='project',settled=not bool(os.environ.get('SMOKE_BUSY')),status='waiting' if os.environ.get('SMOKE_BUSY') else 'idle',pendingBackgroundTasks=[])]))
elif args[:2] == ['thread','show']:
 print(json.dumps(dict(thread=dict(threadId='thread',projectId='project',pendingRequestCount=0,worktreePath=None))))
elif args[:2] == ['thread','send']:
 prompt=sys.stdin.read(); payload=json.loads(prompt.split('Harness payload:\n',1)[1])
 with open(os.environ['SMOKE_SENDS'],'a') as f: f.write(str(payload['issue']['number'])+'\n')
 reply=dict(run_id='stale' if os.environ.get('SMOKE_STALE') else payload['run_id'],project=payload['project'],issue_number=payload['issue']['number'],outcome='complete',evidence='Fixture verified completion')
 print(json.dumps(dict(threadId='thread',runId='fixture-run-'+str(payload['issue']['number']),status='completed',reply=json.dumps(reply))))
else: sys.exit(1)
T3
chmod +x "$tmp/bin/gh" "$tmp/bin/t3"
export PATH="$tmp/bin:$PATH" HARNESS_STATE_DIR="$tmp/state" T3CODE_HOME="$tmp/t3" HARNESS_T3_BIN="$tmp/bin/t3" HARNESS_T3_PROJECT_ID=project HARNESS_T3_THREAD_ID=thread HARNESS_MANAGER=t3 HARNESS_RECONCILE=0 SMOKE_SENDS="$tmp/sends"
bun "$base/src/cli.ts" service start >/dev/null
bun "$base/src/cli.ts" repo attach "$tmp/repo" >/dev/null
for i in $(seq 1 100); do
  count=$(sqlite3 "$tmp/state/manager.sqlite" "select count(*) from claims where state='complete';" 2>/dev/null || true)
  [ "$count" = 2 ] && break
  sleep .1
done
[ "${count:-}" = 2 ] || { echo 'FAIL: two issues did not complete'; exit 1; }
[ "$(sort "$tmp/sends" | tr '\n' ' ')" = '1 2 ' ] || { echo 'FAIL: incorrect dispatch count'; exit 1; }
bun "$base/src/cli.ts" wake --repo example/smoke >/dev/null
sleep .5
[ "$(wc -l < "$tmp/sends" | tr -d ' ')" = 2 ] || { echo 'FAIL: duplicate dispatch'; exit 1; }
payload=$(printf '{"run_id":"test-run","project":"example/smoke","root":"%s","issue":{"number":1,"url":"https://github.com/example/smoke/issues/1"}}' "$tmp/repo")
set +e
printf '%s' "$payload" | SMOKE_STALE=1 bun "$base/src/t3-manager.ts" >/dev/null 2>&1
stale=$?
printf '%s' "$payload" | SMOKE_BUSY=1 bun "$base/src/t3-manager.ts" >/dev/null 2>&1
busy=$?
set -e
[ "$stale" = 1 ] || { echo 'FAIL: stale response accepted'; exit 1; }
[ "$busy" = 75 ] || { echo 'FAIL: busy preflight did not defer'; exit 1; }
[ "$(wc -l < "$tmp/sends" | tr -d ' ')" = 3 ] || { echo 'FAIL: busy preflight dispatched'; exit 1; }
echo 'PASS: two issues processed once; stale result rejected; busy preflight did not send'
