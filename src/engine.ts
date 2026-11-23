import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

type Issue = { number: number; title: string; url: string; assignees: { login: string }[]; state: string };
type ProjectRow = { root: string; project: string; enabled: number; allowlist: string; paused: number; last_reconciled_at: string | null; last_error: string | null; goal_objective: string; goal_priority_issues: string; goal_revision: number; goal_updated_at: string | null };

/** Durable local state and read-only GitHub reconciliation. This engine never dispatches workers. */
export class Engine {
  private db: Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "harness.sqlite"), { create: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        root TEXT PRIMARY KEY, project TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL,
        allowlist TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        last_reconciled_at TEXT, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS issues (
        project TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        assignees TEXT NOT NULL, PRIMARY KEY (project, number)
      );`);
    const columns = this.db.query("PRAGMA table_info(projects)").all() as {name: string}[];
    for (const [name, definition] of [["goal_objective", "TEXT NOT NULL DEFAULT ''"], ["goal_priority_issues", "TEXT NOT NULL DEFAULT '[]'"], ["goal_revision", "INTEGER NOT NULL DEFAULT 0"], ["goal_updated_at", "TEXT"]]) {
      if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
    }
  }

  attach(root: string): any {
    const resolved = realpathSync(root);
    const config = Bun.TOML.parse(readFileSync(join(resolved, ".harness.toml"), "utf8")) as any;
    const project = config.repository?.github;
    if (typeof project !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project)) {
      throw new Error("[repository].github must be an owner/repository identifier");
    }
    const enabled = config.standing_goal?.enabled === true;
    const allowlist = config.standing_goal?.github_assignee_allowlist ?? [];
    if (!Array.isArray(allowlist) || !allowlist.every((name: unknown) => typeof name === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(name))) {
      throw new Error("[standing_goal].github_assignee_allowlist must be an array of GitHub logins");
    }
    const existing = this.db.query("SELECT root FROM projects WHERE project = ? COLLATE NOCASE AND root != ?").get(project, resolved) as {root: string} | null;
    if (existing) throw new Error(`Repository ${project} is already attached at ${existing.root}`);
    const prior = this.db.query("SELECT * FROM projects WHERE root = ?").get(resolved) as ProjectRow | null;
    if (prior && prior.project.toLowerCase() !== project.toLowerCase()) throw new Error("Attached checkout changed repository identity; use a separate state directory");
    const normalizedAllowlist = JSON.stringify([...new Set(allowlist)]);
    this.db.transaction(() => {
      this.db.query(`INSERT INTO projects (root, project, enabled, allowlist) VALUES (?, ?, ?, ?)
        ON CONFLICT(root) DO UPDATE SET enabled = excluded.enabled, allowlist = excluded.allowlist`).run(resolved, prior?.project ?? project, Number(enabled), normalizedAllowlist);
      if (prior && (prior.enabled !== Number(enabled) || prior.allowlist !== normalizedAllowlist)) {
        this.db.query("DELETE FROM issues WHERE project = ?").run(prior.project);
        this.db.query("UPDATE projects SET last_reconciled_at = NULL, last_error = NULL WHERE root = ?").run(resolved);
      }
    })();
    return this.status(resolved);
  }

  private row(identifier: string): ProjectRow {
    const rows = this.db.query("SELECT * FROM projects").all() as ProjectRow[];
    const matches = rows.filter(row => row.root === identifier || row.project.toLowerCase() === identifier.toLowerCase() || basename(row.root).toLowerCase() === identifier.toLowerCase());
    if (matches.length === 0) throw new Error(`Project not attached: ${identifier}`);
    if (matches.length > 1) throw new Error(`Ambiguous project: ${identifier}; use owner/repository or full path`);
    return matches[0];
  }

  projects(): any[] {
    return (this.db.query("SELECT root FROM projects ORDER BY project").all() as {root: string}[]).map(row => this.status(row.root));
  }

  status(project: string): any {
    const row = this.row(project);
    const issues = (this.db.query("SELECT number, title, url, assignees FROM issues WHERE project = ? ORDER BY number").all(row.project) as any[])
      .map(issue => ({ ...issue, assignees: JSON.parse(issue.assignees), state: "candidate: eligibility unverified" }));
    const allowlist = JSON.parse(row.allowlist) as string[];
    const state = row.paused ? "paused" : !row.enabled ? "disabled" : !allowlist.length ? "blocked: empty assignee allowlist" : row.last_error ? "reconciliation error" : !row.last_reconciled_at ? "awaiting reconciliation" : issues.length ? "candidates require review" : "no assigned open issues found";
    return { goal: { objective: row.goal_objective, priorityIssues: JSON.parse(row.goal_priority_issues), revision: row.goal_revision, updatedAt: row.goal_updated_at }, project: row.project, root: row.root, enabled: !!row.enabled, paused: !!row.paused, allowlist, state, issues, last_reconciled_at: row.last_reconciled_at, last_error: row.last_error,
      evidence_limits: "GitHub issue assignment and open state only, limited to 1000 results per assignee; dependencies and actionability are not checked. This engine does not validate worker outcomes, checks, or notifications." };
  }

  setGoal(project: string, objective: string, priorityIssues: number[], expectedRevision?: number): any {
    if (typeof objective !== "string") throw new Error("Objective must be a string");
    if (!Array.isArray(priorityIssues) || !priorityIssues.every(n => Number.isSafeInteger(n) && n > 0) || new Set(priorityIssues).size !== priorityIssues.length) throw new Error("Priority issues must be unique positive issue numbers");
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error("Expected revision must be a non-negative integer");
    const row = this.row(project);
    this.db.transaction(() => {
      const current = this.row(row.root);
      if (expectedRevision !== undefined && current.goal_revision !== expectedRevision) throw new Error("Goal revision conflict");
      this.db.query("UPDATE projects SET goal_objective = ?, goal_priority_issues = ?, goal_revision = goal_revision + 1, goal_updated_at = ? WHERE root = ?").run(objective.trim(), JSON.stringify(priorityIssues), new Date().toISOString(), row.root);
    }).immediate();
    return this.status(row.root);
  }

  pause(project: string): any {
    const row = this.row(project);
    this.db.query("UPDATE projects SET paused = 1 WHERE root = ?").run(row.root);
    return this.status(row.root);
  }

  resume(project: string): any {
    const row = this.row(project);
    this.db.query("UPDATE projects SET paused = 0, last_reconciled_at = NULL WHERE root = ?").run(row.root);
    return this.status(row.root);
  }

  async reconcile(project: string): Promise<any> {
    const row = this.row(project);
    const allowlist = JSON.parse(row.allowlist) as string[];
    if (!row.enabled || !allowlist.length) return this.status(row.root);
    try {
      const found = new Map<number, Issue>();
      for (const login of allowlist) {
        const env: Record<string, string> = { GH_PROMPT_DISABLED: "1" };
        for (const key of ["PATH", "HOME", "GH_CONFIG_DIR", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
          if (process.env[key] !== undefined) env[key] = process.env[key]!;
        }
        const proc = Bun.spawn(["gh", "issue", "list", "--repo", row.project, "--state", "open", "--assignee", login, "--limit", "1000", "--json", "number,title,url,assignees,state"], { stdout: "pipe", stderr: "pipe", env });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 30_000);
        let out: string, err: string, code: number;
        try { [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); }
        finally { clearTimeout(timer); }
        if (timedOut) throw new Error("GitHub query timed out after 30 seconds");
        if (code !== 0) throw new Error(`GitHub query failed: ${err.trim() || `exit ${code}`}`);
        const issues = JSON.parse(out) as Issue[];
        if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid issue list");
        for (const issue of issues) {
          const expected = `https://github.com/${row.project}/issues/${issue.number}`;
          if (!Number.isInteger(issue.number) || issue.number <= 0 || typeof issue.title !== "string" || typeof issue.url !== "string" || issue.url.toLowerCase() !== expected.toLowerCase() || !Array.isArray(issue.assignees) || issue.state.toLowerCase() !== "open") throw new Error("GitHub returned invalid issue data");
          if (issue.assignees.some(a => typeof a.login === "string" && allowlist.some(name => name.toLowerCase() === a.login.toLowerCase()))) found.set(issue.number, issue);
        }
      }
      this.db.transaction(() => {
        const current = this.row(row.root);
        if (current.enabled !== row.enabled || current.allowlist !== row.allowlist) throw new Error("Configuration changed during reconciliation; retry");
        this.db.query("DELETE FROM issues WHERE project = ?").run(row.project);
        const insert = this.db.query("INSERT INTO issues (project, number, title, url, assignees) VALUES (?, ?, ?, ?, ?)");
        for (const issue of found.values()) insert.run(row.project, issue.number, issue.title, issue.url, JSON.stringify(issue.assignees.map(a => a.login)));
        this.db.query("UPDATE projects SET last_reconciled_at = ?, last_error = NULL WHERE root = ?").run(new Date().toISOString(), row.root);
      })();
    } catch (error) {
      this.db.query("UPDATE projects SET last_error = ? WHERE root = ?").run(error instanceof Error ? error.message : String(error), row.root);
    }
    return this.status(row.root);
  }

  close(): void { this.db.close(); }
}
