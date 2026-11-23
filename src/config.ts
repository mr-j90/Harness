import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

type Config = { stateDir: string; slackInterval: number; githubInterval: number; workerModel: string; reviewerModel: string };

/** Load shared settings; explicit environment values take precedence. */
export function loadConfig(): Config {
  const home = process.env.HOME || homedir();
  const expand = (path: string) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  const configPath = expand(process.env.HARNESS_CONFIG || join(home, '.config', 'portable-harness', 'config.toml'));
  if (process.env.HARNESS_CONFIG && !existsSync(configPath)) throw new Error(`Configuration file not found: ${configPath}`);
  const config = existsSync(configPath) ? Bun.TOML.parse(readFileSync(configPath, 'utf8')) as any : {};
  const state = process.env.HARNESS_STATE_DIR ?? config.state?.directory ?? join(home, '.local', 'state', 'portable-harness');
  if (typeof state !== 'string' || !state.trim()) throw new Error('State directory must be a nonempty path');
  const expandedState = expand(state);
  const interval = (value: unknown, name: string): number => {
    const n = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of seconds`);
    return n;
  };
  const workerModel = config.models?.worker ?? 'gpt-6.1-terra';
  const reviewerModel = config.models?.reviewer ?? 'gpt-6.1-terra';
  if (workerModel !== 'gpt-6.1-terra' || reviewerModel !== 'gpt-6.1-terra') throw new Error('v1 supports only gpt-6.1-terra for worker and reviewer models');
  return {
    stateDir: isAbsolute(expandedState) ? expandedState : resolve(expandedState),
    slackInterval: interval(process.env.HARNESS_SLACK_INTERVAL_SECONDS ?? config.standing_goal?.slack_poll_interval_seconds ?? 30, 'Slack interval'),
    githubInterval: interval(process.env.HARNESS_RECONCILE_SECONDS ?? config.standing_goal?.github_reconcile_interval_seconds ?? 300, 'GitHub interval'),
    workerModel, reviewerModel,
  };
}
