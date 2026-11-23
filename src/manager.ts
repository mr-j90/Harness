import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

type Claim = { project: string; issue_number: number; state: string; run_id: string; pid: number; summary: string | null; updated_at: string };

/** Select only an explicitly configured manager. The custom executable takes precedence. */
export function managerCommand(): string[] | null {
  const bin = process.env.HARNESS_MANAGER_BIN;
  if (bin !== undefined) return isAbsolute(bin) ? [bin] : null;
  if (process.env.HARNESS_MANAGER === "t3") return [process.execPath, join(import.meta.dir, "t3-manager.ts")];
  return null;
}

/** Configuration presence only; runtime readiness is checked by the adapter. */
export function managerConfigured(): boolean {
  const command = managerCommand();
  if (!command) return false;
  if (process.env.HARNESS_MANAGER_BIN !== undefined) return true;
  return !!process.env.HARNESS_T3_PROJECT_ID?.trim() && !!process.env.HARNESS_T3_THREAD_ID?.trim()
    && (!process.env.HARNESS_T3_BIN || isAbsolute(process.env.HARNESS_T3_BIN));
}

/** Optional handoff to an operator-provided manager. Never treats a handoff as verification. */
export class ManagerLoop {
  private db: Database;
  private active = new Set<string>();
  private closed = false;
  onWake?: (project: string) => void;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "manager.sqlite"), { create: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS claims (
        project TEXT NOT NULL, issue_number INTEGER NOT NULL, state TEXT NOT NULL,
        run_id TEXT NOT NULL, pid INTEGER NOT NULL, summary TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (project, issue_number)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_project ON claims(project) WHERE state = 'running';`);
    const columns = this.db.query("PRAGMA table_info(claims)").all() as {name: string}[];
    if (!columns.some(column => column.name === "child_pid")) this.db.exec("ALTER TABLE claims ADD COLUMN child_pid INTEGER");
    // A dead owner cannot establish whether the external manager finished its work.
    for (const claim of this.db.query("SELECT * FROM claims WHERE state = 'running'").all() as Claim[]) {
      let alive = true;
      try { process.kill(claim.pid, 0); } catch (error: any) { if (error.code === "ESRCH") alive = false; }
      if (!alive) this.db.query("UPDATE claims SET state = 'needs attention', summary = ?, updated_at = ? WHERE project = ? AND issue_number = ? AND run_id = ? AND state = 'running'")
        .run("Manager owner stopped before recording an outcome; inspect before retrying.", new Date().toISOString(), claim.project, claim.issue_number, claim.run_id);
    }
  }

  activeCount(): number { return this.active.size; }

  summary(project: string): any {
    return this.db.query("SELECT project, issue_number, state, run_id, summary, updated_at, child_pid FROM claims WHERE project = ? ORDER BY issue_number").all(project);
  }

  /** Explicitly release a blocked claim. Ambiguous runs require manual inspection, not retry. */
  retry(project: string, issueNumber: number): any {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("A valid issue number is required");
    const result = this.db.query("DELETE FROM claims WHERE project = ? AND issue_number = ? AND state = 'blocked'").run(project, issueNumber);
    if (!result.changes) throw new Error("Only a blocked claim can be retried; inspect uncertain runs manually");
    return this.summary(project);
  }

  /** Record an operator-verified outcome for precisely the uncertain run inspected. */
  resolve(project: string, issueNumber: number, runId: string, outcome: "complete" | "blocked", summary: string): any {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !runId || !["complete", "blocked"].includes(outcome) || typeof summary !== "string" || !summary.trim()) throw new Error("Issue number, run ID, outcome and an evidence summary are required");
    const result = this.db.query("UPDATE claims SET state = ?, summary = ?, updated_at = ? WHERE project = ? AND issue_number = ? AND run_id = ? AND state = 'needs attention'")
      .run(outcome, summary, new Date().toISOString(), project, issueNumber, runId);
    if (!result.changes) throw new Error("No matching needs-attention run; check the project, issue and run ID");
    return this.summary(project);
  }

  async run(status: any, contexts: any[] = []): Promise<void> {
    const command = managerCommand();
    if (this.closed || !command || !status || !status.enabled || status.paused || status.last_error || !status.last_reconciled_at || !Array.isArray(status.issues) || !Array.isArray(status.allowlist) || !status.allowlist.length) return;
    if (typeof status.project !== "string" || typeof status.root !== "string" || !isAbsolute(status.root) || this.active.has(status.project)) return;
    const project = status.project;
    this.active.add(project);
    let issue: any;
    let runId = "";
    let wake = false;
    try {
      const claimNext = this.db.transaction(() => {
        // Uncertain runs block all further handoffs until an operator investigates.
        const unresolved = this.db.query("SELECT 1 FROM claims WHERE project = ? AND state IN ('running', 'needs attention') LIMIT 1").get(project);
        if (unresolved) return null;
        for (const candidate of status.issues) {
          if (!Number.isInteger(candidate.number) || candidate.number <= 0 || typeof candidate.url !== "string" || !Array.isArray(candidate.assignees)) continue;
          if (!candidate.assignees.some((login: unknown) => typeof login === "string" && status.allowlist.some((allowed: string) => allowed.toLowerCase() === login.toLowerCase()))) continue;
          if (candidate.url.toLowerCase() !== `https://github.com/${project}/issues/${candidate.number}`.toLowerCase()) continue;
          const prior = this.db.query("SELECT state FROM claims WHERE project = ? AND issue_number = ?").get(project, candidate.number) as {state: string} | null;
          if (prior && prior.state !== "deferred") continue;
          if (prior) this.db.query("DELETE FROM claims WHERE project = ? AND issue_number = ? AND state = 'deferred'").run(project, candidate.number);
          runId = randomUUID();
          this.db.query("INSERT INTO claims (project, issue_number, state, run_id, pid, summary, updated_at) VALUES (?, ?, 'running', ?, ?, NULL, ?)").run(project, candidate.number, runId, process.pid, new Date().toISOString());
          return candidate;
        }
        return null;
      });
      issue = claimNext.immediate();
      if (!issue) return;
      const payload = { run_id: runId, project, root: status.root, issue, contexts, context_command: ["bun", join(import.meta.dir, "cli.ts"), "context", "--repo", project, "--json"], instructions: "Act as manager only. Validate actionability and policy before work. Delegate execution and review to workers using gpt-6.1-terra. Report only evidence actually observed." };
      let state = "needs attention";
      let summary = "Manager outcome was not recorded; inspect before retrying.";
      try {
        const git = Bun.spawnSync(["git", "-C", status.root, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
        const origin = new TextDecoder().decode(git.stdout).trim();
        const match = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
        if (git.exitCode !== 0 || !origin) throw new Error("Checkout has no readable origin remote");
        if (!match || match[1].toLowerCase() !== project.toLowerCase()) throw new Error("Checkout origin does not match configured GitHub repository");
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/SLACK/i.test(key)) delete env[key];
        const proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: status.root, env });
        this.db.query("UPDATE claims SET child_pid = ? WHERE project = ? AND issue_number = ? AND run_id = ?").run(proc.pid, project, issue.number, runId);
        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
        const configuredTimeout = Number(process.env.HARNESS_MANAGER_TIMEOUT_SECONDS ?? "3600");
        const timeoutSeconds = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(configuredTimeout, 86400) : 3600;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutSeconds * 1000);
        let stdout: string, stderr: string, exit: number;
        try { [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); }
        finally { clearTimeout(timer); }
        if (timedOut) throw new Error("Manager timed out; verify it and any workers have stopped");
        if (exit === 75 && process.env.HARNESS_MANAGER_BIN === undefined && process.env.HARNESS_MANAGER === "t3") {
          state = "deferred";
          summary = "T3 preflight failed before sending; retry on the next reconciliation.";
        } else if (exit !== 0) throw new Error(`Manager exited with status ${exit}; inspect the manager locally`);
        if (state !== "deferred") {
        const result = JSON.parse(stdout);
        if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).sort().join(",") !== "outcome,summary" || !["complete", "blocked"].includes(result.outcome) || typeof result.summary !== "string" || !result.summary.trim()) throw new Error("Manager returned invalid outcome JSON");
        state = result.outcome;
        summary = result.summary;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const reason = code === "ENOENT" ? "Manager executable or project directory was not found" : code === "EACCES" ? "Manager executable is not accessible" : error instanceof SyntaxError ? "Manager returned invalid JSON" : error instanceof Error && /^(Manager exited with status \d+; inspect the manager locally|Manager returned invalid outcome JSON|Checkout has no readable origin remote|Checkout origin does not match configured GitHub repository|Manager timed out; verify it and any workers have stopped)$/.test(error.message) ? error.message : "Manager handoff failed";
        if (reason.startsWith("Checkout ")) {
          state = "blocked";
          summary = `${reason}. Correct the origin and explicitly retry.`;
        } else {
          summary = `Uncertain handoff: ${reason}. Inspect before retrying.`;
        }
      }
      this.db.query("UPDATE claims SET state = ?, summary = ?, updated_at = ? WHERE project = ? AND issue_number = ? AND run_id = ? AND state = 'running'")
        .run(state, summary, new Date().toISOString(), project, issue.number, runId);
      wake = state !== "deferred";
    } finally {
      this.active.delete(project);
      if (wake && !this.closed) this.onWake?.(project);
      if (this.closed && !this.active.size) this.db.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.active.size) this.db.close();
  }
}
