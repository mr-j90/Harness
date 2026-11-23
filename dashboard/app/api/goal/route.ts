import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const exec = promisify(execFile);
const root = resolve(process.cwd(), process.cwd().endsWith("/dashboard") ? ".." : ".");

function sameLocalOrigin(request: Request): boolean {
  try {
    const host = request.headers.get("host");
    const origin = request.headers.get("origin");
    if (!host || !origin) return false;
    const url = new URL(origin);
    return url.origin === origin && url.host === host && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

export async function POST(request: Request) {
  if (!sameLocalOrigin(request)) return Response.json({ error: "Request origin is not allowed." }, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return Response.json({ error: "Expected JSON." }, { status: 415 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid goal." }, { status: 400 });
  const value = Object.fromEntries(Object.entries(body));
  if (Object.keys(value).sort().join(",") !== "expectedRevision,objective,priorityIssues,project" || typeof value.project !== "string" || !value.project.trim() || value.project.length > 500 || typeof value.objective !== "string" || value.objective.length > 10000 || !Array.isArray(value.priorityIssues) || value.priorityIssues.length > 1000 || !value.priorityIssues.every((n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0) || new Set(value.priorityIssues).size !== value.priorityIssues.length || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) return Response.json({ error: "Invalid goal." }, { status: 400 });
  try {
    const { stdout } = await exec("bun", ["src/cli.ts", "--json", "goal-set", "--project", value.project, "--objective", value.objective, "--priority-issue-ids", JSON.stringify(value.priorityIssues), "--expected-revision", String(value.expectedRevision)], { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 });
    return Response.json(JSON.parse(stdout), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
      try { if (JSON.parse(error.stderr).code === "GOAL_REVISION_CONFLICT") return Response.json({ error: "The goal changed since you opened it. Reload the latest goal before saving.", code: "GOAL_REVISION_CONFLICT" }, { status: 409 }); } catch { /* Return a generic error below. */ }
    }
    return Response.json({ error: "Could not save the goal. Check the local service and try again." }, { status: 500 });
  }
}
