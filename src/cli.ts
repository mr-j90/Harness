#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { request, stateDir } from './service';

const help = `Usage: harness [--json] <command>

  service start|stop|status    Manage the local service
  repo attach <path>           Attach a repository
  repo list                    List attached repositories
  status --repo <name>         Show project status
  goal pause|resume --repo <name>
  goal retry --repo <name> --issue <number>
  goal resolve --repo <name> --issue <number> --run <id> --outcome complete|blocked --summary <text>
  context --repo <name>        Read saved Slack context
  wake --repo <name>           Reconcile the project

Set HARNESS_STATE_DIR to override the state directory. Set HARNESS_RECONCILE=0
before starting the service to disable periodic reconciliation (default 300s;
HARNESS_RECONCILE_SECONDS overrides the interval).`;
const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const json = jsonIndex >= 0;
if (json) args.splice(jsonIndex, 1);
function output(value: any) {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  if (Array.isArray(value)) { console.log(value.length ? value.map(item => `${item.project}: ${item.state}`).join('\n') : 'No repositories attached.'); return; }
  if (value.project) { console.log(`${value.project}: ${value.state}\nManager configured: ${value.manager_configured ? 'yes' : 'no'}${value.jobs?.length ? `\nJobs: ${value.jobs.map((j: any) => `#${j.issue_number} ${j.state}`).join(', ')}` : ''}${value.last_error ? `\nError: ${value.last_error}` : ''}${value.slack_last_error ? `\nSlack: ${value.slack_last_error}` : ''}`); return; }
  if (typeof value.running === 'boolean') { console.log(value.running ? `Service running (PID ${value.pid}).` : 'Service stopped.'); return; }
  if (value.stopping) { console.log('Service stopping.'); return; }
  console.log(JSON.stringify(value, null, 2));
}
function repo(): string {
  const index = args.indexOf('--repo');
  if (index < 0 || !args[index + 1]) throw new Error('Provide --repo <name>');
  return args[index + 1];
}
async function main() {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const [command, sub] = args;
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
main().catch(e => { console.error(`harness: ${e.message}`); process.exitCode = 1; });
