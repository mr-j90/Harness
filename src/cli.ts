#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { request, stateDir } from './service';

const help = `Usage: harness [--json] <command>

  service start|stop|shutdown|status  Manage the local service
  repo attach <path>           Attach a repository
  repo list                    List attached repositories
  status --repo <name>         Show project status
  goal show --repo <name>      Show the saved objective and priority order
  goal set --repo <name> --objective <text> --priority <numbers> [--expected-revision <number>]
  goal pause|resume --repo <name>
  goal retry --repo <name> --issue <number>
  goal resolve --repo <name> --issue <number> --run <id> --outcome complete|blocked --summary <text>
  context --repo <name>        Read saved Slack context
  wake --repo <name>           Reconcile the project

Set HARNESS_STATE_DIR to override the state directory. Set HARNESS_RECONCILE=0
before starting the service to disable periodic reconciliation (default 300s;
HARNESS_RECONCILE_SECONDS overrides the interval).`;
const args = process.argv.slice(2);
const jsonIndex = ['goal-show', 'goal-set'].includes(args[0]) ? -1 : args.findIndex((arg, index) => arg === '--json' && args[index - 1] !== '--objective');
const json = jsonIndex >= 0;
if (json) args.splice(jsonIndex, 1);
function output(value: any) {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  if (Array.isArray(value)) { console.log(value.length ? value.map(item => `${item.project}: ${item.state}`).join('\n') : 'No repositories attached.'); return; }
  if (value.project) { console.log(`${value.project}: ${value.state}\nManager configured: ${value.manager_configured ? 'yes' : 'no'}${value.jobs?.length ? `\nJobs: ${value.jobs.map((j: any) => `#${j.issue_number} ${j.state}`).join(', ')}` : ''}${value.last_error ? `\nError: ${value.last_error}` : ''}${value.slack_last_error ? `\nSlack: ${value.slack_last_error}` : ''}`); return; }
  if (typeof value.running === 'boolean') { console.log(value.running ? `Service ${value.draining ? `draining (${value.active} active)` : 'running'} (PID ${value.pid}).` : 'Service stopped.'); return; }
  if (value.draining) { console.log(`Service draining (${value.active} active).`); return; }
  if (value.stopping) { console.log('Service stopping.'); return; }
  console.log(JSON.stringify(value, null, 2));
}
function repo(): string {
  const index = args.includes('--repo') ? args.indexOf('--repo') : args.indexOf('--project');
  if (index < 0 || !args[index + 1]) throw new Error('Provide --repo <name>');
  return args[index + 1];
}
async function main() {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const [command, sub] = args;
  if ((command === 'goal' && (sub === 'show' || sub === 'set')) || command === 'goal-show' || command === 'goal-set') {
    const operation = command === 'goal' ? sub : command.slice(5);
    if (operation === 'show') { const goal = await request({ command: 'goal-show', project: repo() }); if (json || command === 'goal-show') console.log(JSON.stringify(goal, null, 2)); else console.log(`Objective: ${goal.objective || '(none)'}\nPriority: ${goal.priorityIssues.length ? goal.priorityIssues.map((n: number) => `#${n}`).join(', ') : '(none)'}\nRevision: ${goal.revision}\nUpdated: ${goal.updatedAt || 'never'}`); return; }
    const option = (name: string) => { const i = args.indexOf(name); if (i < 0 || args[i + 1] === undefined || (name !== '--objective' && args[i + 1].startsWith('--'))) throw new Error(`Provide ${name}`); return args[i + 1]; };
    const objective = option('--objective');
    let priorityIssues: unknown;
    if (args.includes('--priority-issue-ids')) { try { priorityIssues = JSON.parse(option('--priority-issue-ids')); } catch { throw new Error('Provide a JSON array for --priority-issue-ids'); } }
    else { const raw = option('--priority'); priorityIssues = raw === 'none' ? [] : raw.split(',').map(part => /^\d+$/.test(part) ? Number(part) : NaN); }
    if (!Array.isArray(priorityIssues) || !priorityIssues.every(n => Number.isSafeInteger(n) && n > 0) || new Set(priorityIssues).size !== priorityIssues.length) throw new Error('Priority must contain unique positive issue numbers; use none for an empty list');
    const revisionIndex = args.indexOf('--expected-revision');
    const revisionText = revisionIndex < 0 ? undefined : option('--expected-revision');
    const expectedRevision = revisionText === undefined ? undefined : Number(revisionText);
    if (revisionText !== undefined && (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(expectedRevision))) throw new Error('Expected revision must be a nonnegative integer');
    const goal = await request({ command: 'goal-set', project: repo(), objective, priorityIssues, expectedRevision }, 120000);
    if (json || command === 'goal-set') console.log(JSON.stringify(goal, null, 2)); else console.log(`Saved goal revision ${goal.revision}.\nObjective: ${goal.objective || '(none)'}\nPriority: ${goal.priorityIssues.length ? goal.priorityIssues.map((n: number) => `#${n}`).join(', ') : '(none)'}`); return;
  }
  if (command === 'service' && sub === 'start') {
    try { const status = await request({ command: 'ping' }); output({ ...status, alreadyRunning: true }); return; }
    catch (e: any) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
    const child = spawn(process.execPath, [resolve(import.meta.dir, 'service.ts')], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    for (let i = 0; i < 50; i++) { await Bun.sleep(100); try { output(await request({ command: 'ping' }, 500)); return; } catch {} }
    throw new Error(`Service failed to start; inspect state directory ${stateDir} and run bun ${resolve(import.meta.dir, 'service.ts')} for diagnostics`);
  }
  if (command === 'service' && sub === 'status') {
    try { output(await request({ command: 'ping' })); } catch (e: any) { if (['ENOENT', 'ECONNREFUSED'].includes(e.code)) { output({ running: false, stateDir }); return; } throw e; }
    return;
  }
  if (command === 'service' && sub === 'shutdown') { output(await request({ command: 'shutdown' })); return; }
  if (command === 'service' && sub === 'stop') { output(await request({ command: 'stop' })); return; }
  if (command === 'repo' && sub === 'attach' && args[2]) { output(await request({ command: 'attach', root: resolve(args[2]) })); return; }
  if (command === 'repo' && sub === 'list') { output(await request({ command: 'projects' })); return; }
  if (command === 'status') { output(await request({ command: 'status', project: repo() })); return; }
  if (command === 'goal' && (sub === 'pause' || sub === 'resume')) { output(await request({ command: sub, project: repo() }, 120000)); return; }
  if (command === 'goal' && sub === 'retry') { const i = args.indexOf('--issue'); const issue = Number(args[i + 1]); if (i < 0 || !Number.isInteger(issue) || issue <= 0) throw new Error('Provide --issue <number>'); output(await request({ command: 'retry', project: repo(), issue }, 120000)); return; }
  if (command === 'goal' && sub === 'resolve') {
    const option = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Provide ${name}`); return args[i + 1]; };
    const issue = Number(option('--issue')); if (!Number.isInteger(issue) || issue <= 0) throw new Error('Provide a valid issue number');
    output(await request({ command: 'resolve', project: repo(), issue, run: option('--run'), outcome: option('--outcome'), summary: option('--summary') }, 120000)); return;
  }
  if (command === 'context') { const result = await request({ command: 'context', project: repo() }); if (!json) { console.log(result.length ? result.map((m: any) => `${m.ts} ${m.user}: ${m.text}`).join('\n') : 'No saved Slack context.'); } else output(result); return; }
  if (command === 'wake') { output(await request({ command: 'wake', project: repo() }, 120000)); return; }
  throw new Error('Unknown command or missing argument. Run harness --help.');
}
main().catch(e => { if (json || args[0] === 'goal-show' || args[0] === 'goal-set') console.error(JSON.stringify({ error: e.message, ...(e.message === 'Goal revision conflict' ? { code: 'GOAL_REVISION_CONFLICT' } : {}) })); else console.error(`harness: ${e.message}`); process.exitCode = 1; });
