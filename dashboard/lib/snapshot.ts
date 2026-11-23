import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);
const root = resolve(process.cwd(), process.cwd().endsWith('/dashboard') ? '..' : '.');

export type Issue = { number: number; title: string; url: string; assignees: string[]; state: string };
export type Job = { issueNumber: number; state: string; runId: string; summary: string | null; updatedAt: string; childPid: number | null };
export type Project = { name: string; state: string; enabled: boolean; paused: boolean; lastReconciledAt: string | null; error: string | null; managerConfigured: boolean; issues: Issue[]; jobs: Job[] };
export type Worker = { id: string; name: string; status: string; updatedAt: string | null; project: string };
export type Event = { time: string; title: string; detail: string; url: string | null };
export type Snapshot = {
  generatedAt: string;
  service: { state: 'running' | 'draining' | 'stopped' | 'unavailable'; pid: number | null; active: number | null; error: string | null };
  projects: Project[]; workers: Worker[]; events: Event[];
  sources: { harness: string; t3: string }; errors: string[];
};

async function command(binary: string, args: string[]): Promise<any> {
  const { stdout } = await exec(binary, args, { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
const message = (error: unknown) => error instanceof Error ? error.message.split('\n')[0].slice(0, 250) : 'Unknown error';
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;

export async function getSnapshot(): Promise<Snapshot> {
  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    service: { state: 'unavailable', pid: null, active: null, error: null },
    projects: [], workers: [], events: [], errors: [],
    sources: {
      harness: 'Harness service via read-only CLI. Issues are assigned open candidates, not verified actionable work; job outcomes are manager reports.',
      t3: 'T3 thread list metadata for attached project paths. Unsettled threads and pending tasks are reported states, not independently verified running processes. Awaited means the thread is waiting on a monitor; background means it is not marked awaited.',
    },
  };
  const harness = (...args: string[]) => command('bun', ['src/cli.ts', '--json', ...args]);
  let listed: any[] = [];
  try {
    const status = await harness('service', 'status');
    snapshot.service = { state: status.running ? status.draining ? 'draining' : 'running' : 'stopped', pid: status.pid ?? null, active: status.active ?? null, error: null };
    if (status.running) {
      const result = await harness('repo', 'list');
      if (!Array.isArray(result)) throw new Error('Invalid project list');
      listed = result.slice(0, 20);
      if (result.length > 20) snapshot.errors.push('Harness project list limited to 20 projects.');
    }
  } catch (error) {
    snapshot.service.error = message(error);
    snapshot.errors.push(`Harness: ${message(error)}`);
  }
  for (const item of listed) {
    try {
      const value = await harness('status', '--repo', item.project);
      const issues: Issue[] = (Array.isArray(value.issues) ? value.issues : []).slice(0, 1000).map((issue: any) => ({ number: issue.number, title: text(issue.title), url: text(issue.url), assignees: Array.isArray(issue.assignees) ? issue.assignees : [], state: text(issue.state) }));
      const jobs: Job[] = (Array.isArray(value.jobs) ? value.jobs : []).slice(0, 1000).map((job: any) => ({ issueNumber: job.issue_number, state: text(job.state), runId: text(job.run_id), summary: typeof job.summary === 'string' ? job.summary : null, updatedAt: text(job.updated_at), childPid: typeof job.child_pid === 'number' ? job.child_pid : null }));
      const project: Project = { name: text(value.project), state: text(value.state), enabled: !!value.enabled, paused: !!value.paused, lastReconciledAt: value.last_reconciled_at ?? null, error: value.last_error ?? value.slack_last_error ?? null, managerConfigured: !!value.manager_configured, issues, jobs };
      snapshot.projects.push(project);
      if (project.lastReconciledAt) snapshot.events.push({ time: project.lastReconciledAt, title: 'Issues reconciled', detail: `${project.name}: ${issues.length} assigned open candidates`, url: null });
      for (const job of jobs) if (job.updatedAt) snapshot.events.push({ time: job.updatedAt, title: `Issue #${job.issueNumber}: ${job.state}`, detail: `${project.name}${job.summary ? ` · ${job.summary}` : ''}`, url: issues.find(issue => issue.number === job.issueNumber)?.url ?? null });
    } catch (error) { snapshot.errors.push(`Harness ${text(item.project)}: ${message(error)}`); }
    try {
      if (typeof item.root !== 'string') throw new Error('Project path unavailable');
      const t3 = process.env.HARNESS_T3_BIN || join(homedir(), '.t3/bin/t3');
      if (!isAbsolute(t3)) throw new Error('HARNESS_T3_BIN must be an absolute path');
      const threads = await command(t3, ['thread', 'list', '--project', item.root, '--json']);
      if (!Array.isArray(threads)) throw new Error('Invalid thread list');
      const seen = new Set<string>();
      for (const thread of threads) {
        if (thread.settled === false && ['running', 'waiting', 'active'].includes(thread.status)) {
          const id = `thread:${text(thread.threadId)}`;
          if (!seen.has(id)) {
            seen.add(id);
            snapshot.workers.push({ id, name: text(thread.title, 'Untitled thread'), status: `thread: ${thread.status}`, updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : null, project: text(item.project) });
          }
        }
        if (!Array.isArray(thread.pendingBackgroundTasks)) continue;
        for (const task of thread.pendingBackgroundTasks) {
          const id = text(task.taskId);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const status = task.kind === 'subagent' ? 'pending subagent' : task.kind === 'monitor'
            ? `${id.startsWith('pull-request-watch:') ? 'PR watch' : 'monitor'}: ${task.awaited === true ? 'awaited' : 'background'}`
            : 'pending task';
          snapshot.workers.push({ id, name: text(task.description, 'Unnamed task'), status, updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : null, project: text(item.project) });
        }
      }
    } catch (error) { snapshot.errors.push(`T3 ${text(item.project)}: ${message(error)}`); }
  }
  snapshot.events.sort((a, b) => b.time.localeCompare(a.time));
  snapshot.events = snapshot.events.slice(0, 30);
  return snapshot;
}
