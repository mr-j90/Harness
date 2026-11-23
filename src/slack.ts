import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type InboxMessage = { project: string; channel: string; ts: string; user: string; text: string };
export type Delivery = { status: 'sent' | 'failed' | 'unknown'; error?: string };
type SlackMessage = { ts: string; text: string; user?: string; bot_id?: string; subtype?: string };

/** Optional signal inbox. Slack messages never authorize or select work. */
export class SlackBridge {
  private db: Database;
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(stateDir, 'slack.sqlite'), { create: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cursors (project TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY(project, channel));
      CREATE TABLE IF NOT EXISTS inbox (project TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, user TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(project, channel, ts));
      CREATE TABLE IF NOT EXISTS notices (project TEXT NOT NULL, key TEXT NOT NULL, channel TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, PRIMARY KEY(project, key));`);
    // A process interruption after a request started leaves its outcome unknown.
    this.db.query("UPDATE notices SET status = 'unknown', error = 'interrupted during delivery' WHERE status = 'sending'").run();
  }

  async poll(project: string, channel: string, token: string, ownBotId: string): Promise<InboxMessage[]> {
    if (!project || !channel || !token || !ownBotId) throw new Error('Slack project, channel, token and own bot ID are required');
    let previous = this.db.query('SELECT ts FROM cursors WHERE project = ? AND channel = ?').get(project, channel) as { ts: string } | null;
    if (!previous) {
      const now = (Date.now() / 1000).toFixed(6);
      this.db.query('INSERT OR IGNORE INTO cursors VALUES (?, ?, ?)').run(project, channel, now);
      previous = this.db.query('SELECT ts FROM cursors WHERE project = ? AND channel = ?').get(project, channel) as { ts: string };
    }
    let page = '';
    const messages: SlackMessage[] = [];
    do {
      const query = new URLSearchParams({ channel, limit: '200' });
      if (previous) query.set('oldest', previous.ts);
      if (page) query.set('cursor', page);
      const response = await fetch(`https://slack.com/api/conversations.history?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Slack history HTTP ${response.status}`);
      const result = await response.json() as { ok?: boolean; error?: string; messages?: SlackMessage[]; response_metadata?: { next_cursor?: string }; has_more?: boolean };
      if (!result.ok || !Array.isArray(result.messages)) throw new Error(`Slack history failed: ${result.error || 'invalid response'}`);
      for (const message of result.messages) {
        if (typeof message.ts !== 'string' || !/^\d+\.\d+$/.test(message.ts) || typeof message.text !== 'string') throw new Error('Slack history returned an invalid message');
        messages.push(message);
      }
      page = result.response_metadata?.next_cursor || '';
      if (result.has_more && !page) throw new Error('Slack history pagination incomplete');
    } while (page);
    const accepted: InboxMessage[] = [];
    const ordered = messages.sort((a, b) => a.ts.localeCompare(b.ts));
    this.db.transaction(() => {
      const insert = this.db.query('INSERT OR IGNORE INTO inbox (project, channel, ts, user, text) VALUES (?, ?, ?, ?, ?)');
      for (const message of ordered) {
        if (message.bot_id === ownBotId || message.subtype === 'bot_message' || !message.user) continue;
        const item = { project, channel, ts: message.ts, user: message.user, text: message.text };
        if (insert.run(project, channel, item.ts, item.user, item.text).changes) accepted.push(item);
      }
      const newest = ordered.at(-1)?.ts;
      if (newest) this.db.query('INSERT INTO cursors VALUES (?, ?, ?) ON CONFLICT(project, channel) DO UPDATE SET ts = excluded.ts').run(project, channel, newest);
    })();
    return accepted;
  }

  context(project: string): InboxMessage[] {
    return this.db.query('SELECT * FROM (SELECT project, channel, ts, user, text FROM inbox WHERE project = ? ORDER BY ts DESC LIMIT 50) ORDER BY ts').all(project) as InboxMessage[];
  }

  async notify(project: string, channel: string, token: string, text: string, key: string): Promise<Delivery> {
    const prior = this.db.query('SELECT channel, text, status, error FROM notices WHERE project = ? AND key = ?').get(project, key) as {channel: string; text: string; status: string; error: string | null} | null;
    if (prior && (prior.channel !== channel || prior.text !== text)) throw new Error('Notification key already used for different content');
    if (prior && prior.status !== 'failed') return { status: prior.status === 'sent' ? 'sent' : 'unknown', ...(prior.error ? {error: prior.error} : {}) };
    this.db.query("INSERT INTO notices VALUES (?, ?, ?, ?, 'sending', NULL) ON CONFLICT(project, key) DO UPDATE SET status = 'sending', error = NULL").run(project, key, channel, text);
    let status: Delivery['status'] = 'unknown';
    let error: string | undefined;
    try {
      const response = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel, text }), signal: AbortSignal.timeout(10000) });
      const body = await response.json() as {ok?: boolean; error?: string};
      if (response.ok && body.ok === true) status = 'sent';
      else {
        error = body.error || `HTTP ${response.status}`;
        // Server-side errors and timeouts can follow a successful write.
        status = response.status === 429 || (response.ok && body.ok === false && !['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable'].includes(error)) ? 'failed' : 'unknown';
      }
    } catch (e) { error = e instanceof Error ? e.message : 'delivery error'; }
    this.db.query('UPDATE notices SET status = ?, error = ? WHERE project = ? AND key = ?').run(status, error ?? null, project, key);
    return { status, ...(error ? { error } : {}) };
  }
}
