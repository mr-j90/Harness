"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, ChevronDown, CircleDot, Clock3, ExternalLink, GitPullRequest, Layers3, Radio, RefreshCw, Search, ShieldAlert, Sparkles, Terminal, Users, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Goal, Project, Snapshot } from "@/lib/snapshot";

type Theme = "system" | "light" | "dark";
type Tab = "overview" | "workers" | "claims" | "issues" | "goals";
const tabs: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Layers3 },
  { id: "workers", label: "Agent work", icon: Users },
  { id: "claims", label: "Harness claims", icon: CircleDot },
  { id: "issues", label: "Issue queue", icon: GitPullRequest },
  { id: "goals", label: "Project goals", icon: Sparkles },
];
const shortTime = (value: string | null) => {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const age = (value: string | null, now: number) => {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
const tone = (state: string) => /running|active|working|complete|success|enabled/i.test(state) ? "green" : /attention|error|fail|blocked|unavailable/i.test(state) ? "red" : /defer|wait|pause|drain/i.test(state) ? "amber" : "muted";
const label = (value: string) => value.replace(/[_-]/g, " ");
function Status({ value }: { value: string }) { return <Badge variant="secondary" className={`status ${tone(value)}`}><span />{label(value)}</Badge>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty"><div className="empty-icon"><Sparkles size={16}/></div><strong>{title}</strong><p>{detail}</p></div>; }
function PanelTitle({ eyebrow, title, detail, action }: { eyebrow?: string; title: string; detail?: string; action?: React.ReactNode }) { return <div className="panel-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</div>; }

export default function Dashboard() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("harness-theme");
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch { /* Storage may be unavailable; use the system preference. */ }
  }, []);
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const changeTheme = (next: Theme) => {
    setTheme(next);
    try { localStorage.setItem("harness-theme", next); } catch { /* Theme still applies for this session. */ }
  };
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<Tab>("overview");
  const [project, setProject] = useState("all");
  const [query, setQuery] = useState("");
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
      const data: Snapshot = await response.json();
      setSnapshot(data); setError(null); setNow(Date.now());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load snapshot"); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { void refresh(); const interval = window.setInterval(() => void refresh(), 30000); const ticker = window.setInterval(() => setNow(Date.now()), 10000); return () => { window.clearInterval(interval); window.clearInterval(ticker); }; }, [refresh]);
  const projects = useMemo(() => snapshot?.projects.filter(p => project === "all" || p.name === project) ?? [], [snapshot, project]);
  const workers = useMemo(() => snapshot?.workers.filter(w => project === "all" || w.project === project) ?? [], [snapshot, project]);
  const issues = projects.flatMap(p => p.issues.map(issue => ({ ...issue, project: p.name })));
  const jobs = projects.flatMap(p => p.jobs.map(job => ({ ...job, project: p.name, issue: p.issues.find(i => i.number === job.issueNumber) })));
  const needle = query.toLowerCase().trim();
  const visibleIssues = issues.filter(i => `${i.title} ${i.number} ${i.project} ${i.assignees.join(" ")}`.toLowerCase().includes(needle));
  const agentWorkers = workers.filter(w => /pending subagent/i.test(w.status));
  const prWatches = workers.filter(w => /PR watch/i.test(w.status));
  const attention = jobs.filter(j => /attention|blocked|error|fail/i.test(j.state)).length;
  const otherTasks = workers.filter(w => /monitor:|pending task/i.test(w.status));
  const chart = [{ name: "Subagents", count: agentWorkers.length }, { name: "PR watches", count: prWatches.length }, { name: "Other tasks", count: otherTasks.length }];
  const latestClaim = [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const thread = workers.find(w => /thread:/i.test(w.status));
  const events = snapshot?.events.filter(e => project === "all" || e.detail.includes(project)) ?? [];
  const service = snapshot?.service.state ?? "unavailable";
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span/><span/><span/><span/></div><div><strong>HARNESS</strong><small>OPERATIONS</small></div></div>
      <div className="side-label">WORKSPACE</div>
      <nav aria-label="Dashboard sections">{tabs.map(({ id, label: tabLabel, icon: Icon }) => <button key={id} className={`nav-item ${tab === id ? "selected" : ""}`} onClick={() => setTab(id)}><Icon size={17}/><span>{tabLabel}</span>{id === "claims" && attention > 0 && <b>{attention}</b>}</button>)}</nav>
      <div className="side-bottom"><div className="side-rule"/><div className="side-service"><span className={`live-dot ${tone(service)}`}/><div><strong>Local service</strong><small>{label(service)}</small></div><Activity size={16}/></div><div className="side-foot">LOCAL WORKSPACE <span>V1</span></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumb">WORKSPACE <span>/</span> <strong>{tabs.find(t => t.id === tab)?.label}</strong></div><div className="top-actions"><span className="updated"><span className="pulse"/> {snapshot ? `Updated ${age(snapshot.generatedAt, now)}` : "Awaiting snapshot"}</span><Button variant="ghost" className="icon-button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh snapshot"><RefreshCw size={16} className={refreshing ? "spin" : ""}/></Button><select className="theme-button" aria-label="Color theme" value={theme} onChange={e => { const next = e.target.value; if (next === "system" || next === "light" || next === "dark") changeTheme(next); }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><div className="avatar">H</div></div></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow"><span className="tiny-square"/> OPERATIONS / {tab.toUpperCase()}</div><h1>{tab === "overview" ? project === "all" ? "Workspace overview" : project : tabs.find(t => t.id === tab)?.label}</h1><p>{tab === "overview" ? snapshot ? `${latestClaim ? `#${latestClaim.issueNumber} ${label(latestClaim.state)}` : "No recorded claims"} · ${thread ? label(thread.status) : "No unsettled thread reported"} · ${agentWorkers.length} subagents · ${prWatches.length} PR watches` : "Loading workspace data…" : tab === "workers" ? "Pending agent tasks and PR monitors reported by the runtime." : tab === "claims" ? "Handoffs recorded by the harness, with their reported state." : tab === "goals" ? "Set an objective and priority order for each project." : "Discovered candidates across your attached projects."}</p></div><div className="select-wrap"><select aria-label="Filter by project" value={project} onChange={e => setProject(e.target.value)}><option value="all">All projects</option>{snapshot?.projects.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}</select><ChevronDown size={15}/></div></div>
        {error && <div className="notice error"><ShieldAlert size={17}/><div><strong>Couldn’t refresh the snapshot.</strong> {error}{snapshot && " Showing the last successful snapshot."}</div><button onClick={() => void refresh()}>Retry</button></div>}
        {snapshot?.errors.map((item, index) => <div className="notice" key={`${item}-${index}`}><ShieldAlert size={17}/><div>{item}</div></div>)}
        {loading && !snapshot ? <div className="loading"><RefreshCw size={18} className="spin"/> Loading workspace snapshot…</div> : !snapshot ? <Empty title="Workspace unavailable" detail="The dashboard could not load the local snapshot. Check the service and try again."/> : <>
          {(tab === "overview") && <>
            <div className="section-line"><div>AT A GLANCE</div><span>LIVE SNAPSHOT <span className="line-separator">/</span> {shortTime(snapshot.generatedAt)}</span></div>
            <div className="stats-grid">
              <button className="stat-card" onClick={() => setTab("workers")}><div className="stat-top"><span>AGENT WORK</span><Users size={17}/></div><div className="stat-value">{agentWorkers.length}<span className="stat-unit">pending</span></div><div className="stat-foot"><span><i className="dot green"/> {agentWorkers.length} reported tasks</span><ArrowUpRight size={15}/></div></button>
              <button className="stat-card" onClick={() => setTab("claims")}><div className="stat-top"><span>HARNESS CLAIMS</span><CircleDot size={17}/></div><div className="stat-value">{jobs.length}<span className="stat-unit">recorded</span></div><div className="stat-foot"><span><i className={`dot ${attention ? "red" : "muted"}`}/> {attention} need attention or blocked</span><ArrowUpRight size={15}/></div></button>
              <button className="stat-card" onClick={() => setTab("issues")}><div className="stat-top"><span>ISSUE QUEUE</span><GitPullRequest size={17}/></div><div className="stat-value">{issues.length}<span className="stat-unit">candidates</span></div><div className="stat-foot"><span><i className="dot blue"/> Across {projects.length} {projects.length === 1 ? "project" : "projects"}</span><ArrowUpRight size={15}/></div></button>
              <div className="stat-card quiet"><div className="stat-top"><span>PR WATCHES</span><Radio size={17}/></div><div className="stat-value">{prWatches.length}<span className="stat-unit">pending</span></div><div className="stat-foot"><span>Runtime-reported monitors</span></div></div>
            </div>
            <div className="section-line second"><div>WORK IN MOTION</div><span>RUNTIME AND HARNESS</span></div>
            <div className="overview-grid"><section className="panel activity-panel"><PanelTitle eyebrow="LIVE ACTIVITY" title="Agent work" detail="Pending runtime tasks, separate from harness claims." action={<button className="text-link" onClick={() => setTab("workers")}>View all <ArrowUpRight size={14}/></button>}/>{agentWorkers.length ? <div className="worker-list">{agentWorkers.slice(0, 5).map(w => <div className="worker-row" key={w.id}><div className="worker-icon"><Terminal size={16}/></div><div className="row-main"><strong>{w.name}</strong><small>{w.project || "Project not available"} <span>·</span> {w.updatedAt ? `Updated ${age(w.updatedAt, now)}` : "Update time unavailable"}</small></div><Status value={w.status}/></div>)}</div> : <Empty title="No agent work observed" detail="Pending tasks will appear here when the connected runtime reports them."/>}</section>
              <section className="panel chart-panel"><PanelTitle eyebrow="RUNTIME TASKS" title="Pending workload" detail="Tasks reported by the runtime in the selected projects."/>{workers.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={chart} layout="vertical" margin={{ left: 0, right: 15, top: 0, bottom: 0 }}><CartesianGrid horizontal={false} stroke="var(--line)"/><XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--gray-60)", fontSize: 11 }}/><YAxis type="category" dataKey="name" width={90} tickLine={false} axisLine={false} tick={{ fill: "var(--gray-40)", fontSize: 11 }}/><Tooltip cursor={{ fill: "var(--gray-100)" }} contentStyle={{ border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, background: "var(--gray-100)", color: "var(--ink)" }}/><Bar dataKey="count" fill="var(--gray-30)" radius={[0, 4, 4, 0]} barSize={18}/></BarChart></ResponsiveContainer></div> : <Empty title="No claims yet" detail="Recorded handoffs will be summarized here."/>}<div className="chart-note"><span className="legend"/> RUNTIME-REPORTED PENDING TASKS <span>NOT VERIFIED LIVE PROCESSES</span></div></section></div>
            <div className="bottom-grid"><section className="panel"><PanelTitle eyebrow="CANDIDATES" title="Issue queue" detail="Discovery does not verify actionability or dependencies." action={<button className="text-link" onClick={() => setTab("issues")}>View queue <ArrowUpRight size={14}/></button>}/><IssueList issues={issues.slice(0, 5)}/></section><section className="panel"><PanelTitle eyebrow="CONNECTIONS" title="Source health" detail="Where this snapshot comes from."/><div className="source-list"><div><span className="source-icon"><Activity size={15}/></span><div><strong>Harness service</strong><small>{snapshot.sources.harness}</small></div><Status value={service}/></div><div><span className="source-icon"><Terminal size={15}/></span><div><strong>Agent runtime</strong><small>{snapshot.sources.t3}</small></div></div></div><div className="source-foot"><Clock3 size={14}/> Snapshot generated {age(snapshot.generatedAt, now)}</div><div className="source-foot"><Clock3 size={14}/> Last reconciliation: {projects.map(p => `${p.name}: ${p.lastReconciledAt ? age(p.lastReconciledAt, now) : "unavailable"}`).join(" · ") || "unavailable"}</div></section></div><section className="panel recent-panel"><PanelTitle eyebrow="RECENT EVENTS" title="Latest activity" detail="Reconciliations and recorded claim updates."/>{events.length ? <div className="worker-list">{events.slice(0, 5).map((event, index) => <div className="worker-row" key={`${event.time}-${index}`}><div className="worker-icon"><Clock3 size={16}/></div><div className="row-main"><strong>{event.title}</strong><small>{event.detail}</small></div><span className="event-time">{age(event.time, now)}</span></div>)}</div> : <Empty title="No recent events" detail="Reconciliation and claim updates will appear here."/>}</section>
          </>}
          {tab === "workers" && <section className="panel full-panel"><PanelTitle eyebrow="RUNTIME OBSERVATIONS" title="Observed tasks" detail={`${workers.length} pending tasks in the selected scope. These are runtime reports, not proof of live processes.`}/>{workers.length ? <div className="worker-list">{workers.map(w => <div className="worker-row" key={w.id}><div className="worker-icon"><Terminal size={16}/></div><div className="row-main"><strong>{w.name}</strong><small>{w.project || "Project not available"} · {w.updatedAt ? `Updated ${age(w.updatedAt, now)}` : "Update time unavailable"}</small></div><Status value={w.status}/></div>)}</div> : <Empty title="No agent work observed" detail="Pending tasks will appear here when the connected runtime reports them."/>}</section>}
          {tab === "claims" && <section className="panel full-panel"><PanelTitle eyebrow="HARNESS RECORDS" title="Claims & handoffs" detail="A manager’s reported outcome is not independent verification of completion."/>{jobs.length ? <div className="claims-list">{jobs.map(j => <div className="claim-row" key={`${j.project}-${j.runId}`}><div className="claim-top"><div><strong>{j.issue?.title || `Issue #${j.issueNumber}`}</strong><small>{j.project} <span>·</span> #{j.issueNumber} <span>·</span> Updated {shortTime(j.updatedAt)}</small></div><Status value={j.state}/></div>{j.summary && <p>{j.summary}</p>}<div className="claim-id">RUN {j.runId}{j.childPid != null && ` · PID ${j.childPid}`}</div></div>)}</div> : <Empty title="No claims recorded" detail="Handoffs will appear here when the harness records them."/>}</section>}
          {tab === "issues" && <section className="panel full-panel"><PanelTitle eyebrow="DISCOVERED CANDIDATES" title="Issue queue" detail="Candidates may still require dependency and actionability checks." action={<label className="search"><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search issues"/>{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={15}/></button>}</label>}/><IssueList issues={visibleIssues}/></section>}
          {tab === "goals" && <div className="goal-list">{projects.length ? projects.map(p => <GoalEditor key={p.name} project={p} onSaved={() => void refresh()}/>) : <Empty title="No projects available" detail="Attach a project and start the local service to edit its goal."/>}</div>}
          <footer><div><span className="footer-mark">✳</span> HARNESS <span className="footer-divider">/</span> OPERATIONS WORKSPACE</div><span>LOCAL WORKSPACE <span className="footer-divider">·</span> AUTO-REFRESHES EVERY 30S</span></footer>
        </>}
      </div>
    </main>
  </div>;
}
function IssueList({ issues }: { issues: Array<{ number: number; title: string; url: string; assignees: string[]; state: string; project: string }> }) {
  if (!issues.length) return <Empty title="No issues to show" detail="Discovered issues matching this view will appear here."/>;
  return <div className="issue-list">{issues.map(i => <a className="issue-row" href={i.url} target="_blank" rel="noreferrer" key={`${i.project}-${i.number}`}><span className="issue-symbol"><CircleDot size={16}/></span><div className="row-main"><strong>{i.title}</strong><small>{i.project} <span>·</span> #{i.number}{i.assignees.length > 0 && <> <span>·</span> {i.assignees.join(", ")}</>}</small></div><Status value={i.state}/><ExternalLink size={14} className="external"/></a>)}</div>;
}

function GoalEditor({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [base, setBase] = useState<Goal | null>(project.goal ?? null);
  const [objective, setObjective] = useState(project.goal?.objective ?? "");
  const [priorities, setPriorities] = useState(project.goal?.priorityIssues.join(", ") ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error" | "conflict">("idle");
  const [message, setMessage] = useState("");
  const apply = (goal: Goal) => { setBase(goal); setObjective(goal.objective); setPriorities(goal.priorityIssues.join(", ")); };
  const reload = async () => {
    setState("saving");
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const snapshot: Snapshot = await response.json();
      const latest = snapshot.projects.find(p => p.name === project.name)?.goal;
      if (!latest) throw new Error();
      apply(latest); setState("idle"); setMessage("");
    } catch { setState("error"); setMessage("Could not reload the goal. Try again."); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!base) return;
    const entries = priorities.trim() ? priorities.split(",").map(s => s.trim()) : [];
    const numbers = entries.map(Number);
    if (entries.some(s => !/^[1-9]\d*$/.test(s)) || numbers.some(n => !Number.isSafeInteger(n)) || new Set(numbers).size !== numbers.length) { setState("error"); setMessage("Enter unique positive issue numbers separated by commas."); return; }
    setState("saving"); setMessage("");
    try {
      const response = await fetch("/api/goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: project.name, objective, priorityIssues: numbers, expectedRevision: base.revision }) });
      const data = await response.json();
      if (response.status === 409) { setState("conflict"); setMessage(data.error); return; }
      if (!response.ok) throw new Error(data.error || "Could not save the goal.");
      apply(data); setState("saved"); setMessage("Goal saved."); onSaved();
    } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "Could not save the goal."); }
  };
  return <section className="panel goal-panel"><PanelTitle eyebrow="PROJECT GOAL" title={project.name} detail={base ? `Revision ${base.revision} · ${base.updatedAt ? `Updated ${shortTime(base.updatedAt)}` : "Not yet updated"}` : "Goal unavailable"}/>
    <p className="goal-explainer">Priority numbers are considered in the order listed among discovered candidates. Other eligible candidates can still be considered afterward. Saving affects future dispatches; work already running keeps its original goal.</p>
    {base && <form onSubmit={save} className="goal-form"><label>Objective<textarea value={objective} maxLength={10000} onChange={e => { setObjective(e.target.value); if (state !== "conflict") setState("idle"); }} rows={3} placeholder="What should this project work toward?"/></label><label>Priority issue numbers<input value={priorities} onChange={e => { setPriorities(e.target.value); if (state !== "conflict") setState("idle"); }} placeholder="e.g. 42, 17, 9"/><small>Comma-separated issue numbers, highest priority first. Leave blank for no preferred order.</small></label><div className="goal-actions"><Button type="submit" disabled={state === "saving" || state === "conflict"}>{state === "saving" ? "Saving…" : "Save goal"}</Button><button type="button" className="text-link" onClick={() => void reload()} disabled={state === "saving"}>Reload latest</button><span role="status" className={state === "error" || state === "conflict" ? "goal-error" : ""}>{message}</span></div></form>}
  </section>;
}
