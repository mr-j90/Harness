import { createServer, createConnection } from 'node:net';
import { mkdirSync, chmodSync, unlinkSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from './engine';
import { ManagerLoop, managerConfigured } from './manager';
import { SlackBridge } from './slack';
import { Database } from 'bun:sqlite';
import { loadConfig } from './config';

const config = loadConfig();
export const stateDir = config.stateDir;
export const socketPath = join(stateDir, 'service.sock');
export type Request = { command: string; project?: string; root?: string; issue?: number; run?: string; outcome?: string; summary?: string };

export async function request(req: Request, timeout = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = '';
    socket.setTimeout(timeout, () => socket.destroy(new Error('Service request timed out')));
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { socket.end(); try { const result = JSON.parse(data.split('\n')[0]); result.ok ? resolve(result.value) : reject(new Error(result.error)); } catch (e) { reject(e); } } });
    socket.on('error', reject);
    socket.on('end', () => { if (!data.includes('\n')) reject(new Error('Service closed without a response')); });
  });
}

export async function runService() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  if (existsSync(socketPath)) {
    const stale = lstatSync(socketPath);
    try { await request({ command: 'ping' }, 1000); throw new Error('Service is already running'); }
    catch (e: any) { if (e.message === 'Service is already running') throw e; if (!['ECONNREFUSED', 'ENOENT'].includes(e.code)) throw new Error(`Cannot verify existing socket: ${e.message}`); }
    const current = lstatSync(socketPath);
    if (current.dev !== stale.dev || current.ino !== stale.ino) throw new Error('Socket changed while checking service; retry');
    unlinkSync(socketPath);
  }
  const engine = new Engine(stateDir);
  const manager = new ManagerLoop(stateDir);
  const slack = new SlackBridge(stateDir);
  const notices = new Database(join(stateDir, 'transitions.sqlite'), { create: true });
  notices.exec('CREATE TABLE IF NOT EXISTS transitions (project TEXT PRIMARY KEY, state TEXT NOT NULL, sequence INTEGER NOT NULL)');
  let queue = Promise.resolve();
  const serialized = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.then(() => {}, () => {});
    return next;
  };
  let stopping = false;
  const pending = new Set<string>();
  const rerun = new Set<string>();
  const slackConfig = (project: string) => {
    const { HARNESS_SLACK_TOKEN: token, HARNESS_SLACK_CHANNEL: channel, HARNESS_SLACK_BOT_ID: bot, HARNESS_SLACK_PROJECT: target } = process.env;
    return token && channel && bot && target === project ? { token, channel, bot } : null;
  };
  let lastSlackError: string | null = null;
  const status = (project: string) => { const value = engine.status(project); return { ...value, slack_last_error: lastSlackError, manager_configured: managerConfigured(), jobs: manager.summary(value.project) }; };
  const reconcile = async (project: string) => {
    const before = engine.status(project);
    const cfg = slackConfig(before.project);
    const value = await engine.reconcile(before.project);
    if (!stopping && value.enabled && !value.paused && !value.last_error && value.last_reconciled_at) {
      void manager.run(value, cfg ? slack.context(value.project) : []).catch(e => console.error('Manager:', e));
    }
    const current = status(value.project);
    if (cfg) {
      for (const job of current.jobs.filter((j: any) => j.state === 'complete' || j.state === 'blocked' || j.state === 'needs attention')) {
        void slack.notify(value.project, cfg.channel, cfg.token, `${value.project} issue #${job.issue_number}: ${job.state}. ${job.summary || ''}`, `job:${job.run_id}:${job.state}`).catch(e => console.error('Slack notice:', e));
      }
      const claims = new Map(current.jobs.map((j: any) => [j.issue_number, j.state]));
      const remaining = current.issues.filter((i: any) => !claims.has(i.number));
      const busy = current.jobs.some((j: any) => j.state === 'running');
      const terminal = !current.paused && current.enabled && !current.last_error && current.last_reconciled_at && !busy && !remaining.length
        ? current.jobs.some((j: any) => current.issues.some((i: any) => i.number === j.issue_number) && (j.state === 'blocked' || j.state === 'needs attention' || j.state === 'deferred')) || !current.allowlist.length ? 'blocked' : 'idle' : '';
      if (terminal) {
        const prior = notices.query('SELECT state, sequence FROM transitions WHERE project = ?').get(value.project) as any;
        if (!prior || prior.state !== terminal) {
          const sequence = (prior?.sequence || 0) + 1;
          notices.query('INSERT INTO transitions VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET state=excluded.state, sequence=excluded.sequence').run(value.project, terminal, sequence);
        }
        const sequence = prior?.state === terminal ? prior.sequence : (prior?.sequence || 0) + 1;
        void slack.notify(value.project, cfg.channel, cfg.token, `${value.project}: ${terminal}.`, `transition:${sequence}`).catch(e => console.error('Slack notice:', e));
      } else notices.query("UPDATE transitions SET state = '' WHERE project = ?").run(value.project);
    }
    return current;
  };
  const schedule = (project: string) => {
    if (stopping) return;
    if (pending.has(project)) { rerun.add(project); return; }
    pending.add(project);
    void serialized(async () => { try { if (!stopping) await reconcile(project); } finally { pending.delete(project); if (rerun.delete(project)) schedule(project); } }).catch(e => console.error('Reconcile:', e));
  };
  manager.onWake = schedule;
  const server = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 65536) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end < 0) return;
      const line = input.slice(0, end); input = '';
      let req: Request;
      try { req = JSON.parse(line); if (!req || typeof req.command !== 'string') throw new Error('Invalid request'); } catch { socket.end(JSON.stringify({ ok: false, error: 'Invalid request' }) + '\n'); return; }
      const respond = (value: any) => socket.end(JSON.stringify({ ok: true, value }) + '\n');
      if (req.command === 'shutdown') {
        beginDrain();
        respond({ draining: true, active: manager.activeCount() });
        return;
      }
      if (req.command === 'ping') { respond({ running: true, pid: process.pid, stateDir, draining: stopping, active: manager.activeCount() }); return; }
      serialized(async () => {
        if (stopping && !['projects', 'status', 'context'].includes(req.command)) throw new Error('Service is draining');
        switch (req.command) {
          case 'projects': return engine.projects();
          case 'attach': if (!req.root) throw new Error('Repository path is required'); { const attached = engine.attach(req.root); if (attached.enabled) schedule(attached.project); return status(attached.project); }
          case 'status': if (!req.project) throw new Error('Repository is required'); return status(req.project);
          case 'context': if (!req.project) throw new Error('Repository is required'); return slack.context(engine.status(req.project).project);
          case 'pause': if (!req.project) throw new Error('Repository is required'); engine.pause(req.project); return status(req.project);
          case 'resume': if (!req.project) throw new Error('Repository is required'); engine.resume(req.project); return await reconcile(req.project);
          case 'wake': if (!req.project) throw new Error('Repository is required'); return await reconcile(req.project);
          case 'retry': if (!req.project || !req.issue) throw new Error('Repository and issue number are required'); { const project = engine.status(req.project).project; manager.retry(project, req.issue); return await reconcile(project); }
          case 'resolve': if (!req.project || !req.issue || !req.run || !req.outcome || !req.summary) throw new Error('Repository, issue, run, outcome and summary are required'); { const project = engine.status(req.project).project; manager.resolve(project, req.issue, req.run, req.outcome, req.summary); return await reconcile(project); }
          case 'stop': if (manager.activeCount()) throw new Error('A manager run is active; wait for it to finish before stopping the service'); stopping = true; return { stopping: true };
          default: throw new Error('Unknown command');
        }
      }).then(value => { respond(value); if (req.command === 'stop') beginDrain(); }, e => socket.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n'));
    });
    socket.on('error', () => {});
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let slackTimer: ReturnType<typeof setInterval> | undefined;
  let slackPolling = false;
  const pollSlack = () => {
    if (stopping || slackPolling) return;
    const project = process.env.HARNESS_SLACK_PROJECT;
    const cfg = project && slackConfig(project);
    if (!project || !cfg) return;
    slackPolling = true;
    void (async () => {
      try {
        const fresh = await slack.poll(project, cfg.channel, cfg.token, cfg.bot);
        lastSlackError = null;
        if (!stopping && fresh.length) schedule(project);
        const prior = notices.query('SELECT state, sequence FROM transitions WHERE project = ?').get(project) as any;
        if (!stopping && prior?.state) await slack.notify(project, cfg.channel, cfg.token, `${project}: ${prior.state}.`, `transition:${prior.sequence}`);
      } catch { lastSlackError = 'Slack heartbeat failed; check service configuration and connectivity'; console.error(lastSlackError); }
      finally { slackPolling = false; }
    })();
  };
  let socketIdentity: { dev: number; ino: number } | undefined;
  let shuttingDown = false;
  const beginDrain = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping = true;
    if (timer) clearInterval(timer);
    if (slackTimer) clearInterval(slackTimer);
    void (async () => {
      await queue;
      while (manager.activeCount() || slackPolling) await Bun.sleep(100);
      server.close(() => {
        manager.close(); notices.close(); engine.close();
        try { const current = lstatSync(socketPath); if (socketIdentity && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) unlinkSync(socketPath); } catch {}
        process.exit(0);
      });
    })();
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { chmodSync(socketPath, 0o600); const stat = lstatSync(socketPath); socketIdentity = { dev: stat.dev, ino: stat.ino }; resolve(); }); });
  const slackSeconds = config.slackInterval;
  if (Number.isFinite(slackSeconds) && slackSeconds > 0) { pollSlack(); slackTimer = setInterval(pollSlack, slackSeconds * 1000); }
  process.on('SIGTERM', beginDrain); process.on('SIGINT', beginDrain);
  // Reconcile once after startup and coalesce overlapping periodic ticks.
  for (const project of engine.projects()) if (project.enabled) schedule(project.project);
  const seconds = config.githubInterval;
  if (process.env.HARNESS_RECONCILE !== '0' && Number.isFinite(seconds) && seconds > 0) {
    timer = setInterval(() => { for (const project of engine.projects()) if (project.enabled) schedule(project.project); }, seconds * 1000);
  }
}

if (import.meta.main) runService().catch(e => { console.error(e.message); process.exit(1); });
