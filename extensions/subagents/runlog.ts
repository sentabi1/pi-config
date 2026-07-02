import * as fs from "node:fs";
import type { RunRecord } from "./registry.ts";

/** One finished run, persisted as a JSON line in runs.jsonl. This is the feedback
 * loop for delegation tuning: aggregate it (`/agents stats`) to see whether each
 * agent's spawns actually pay for themselves across sessions. */
export interface RunLogEntry {
	ts: string;
	agent: string;
	mode: "single" | "parallel" | "chain";
	status: string;
	durationMs: number;
	/** Run cost including nested spawn children. */
	cost: number;
	input: number;
	output: number;
	tools: number;
	task: string;
}

export function entryFromRecord(rec: RunRecord): RunLogEntry {
	return {
		ts: new Date(rec.endedAt ?? Date.now()).toISOString(),
		agent: rec.agentName,
		mode: rec.mode,
		status: rec.status,
		durationMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
		cost: (rec.usage?.cost ?? 0) + (rec.childCost ?? 0),
		input: rec.usage?.input ?? 0,
		output: rec.usage?.output ?? 0,
		tools: rec.usage?.toolCalls ?? 0,
		task: rec.task.replace(/\s+/g, " ").slice(0, 80),
	};
}

/** Best-effort append; a broken log must never break a run. */
export function appendRunLog(file: string, entry: RunLogEntry): void {
	try {
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		/* best-effort */
	}
}

/** Read all entries, skipping blank/corrupt lines. Missing file = empty history. */
export function readRunLog(file: string): RunLogEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: RunLogEntry[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t) as RunLogEntry;
			if (e && typeof e.agent === "string" && typeof e.cost === "number") out.push(e);
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

export interface AgentRunStats {
	agent: string;
	runs: number;
	failed: number;
	totalCost: number;
	avgCost: number;
	avgDurationMs: number;
	avgOutput: number;
}

/** Per-agent aggregates, sorted by total cost descending (the tuning signal:
 * the top row is where your delegation money goes). */
export function aggregateRunStats(entries: RunLogEntry[]): AgentRunStats[] {
	const byAgent = new Map<string, RunLogEntry[]>();
	for (const e of entries) {
		const list = byAgent.get(e.agent) ?? [];
		list.push(e);
		byAgent.set(e.agent, list);
	}
	const stats: AgentRunStats[] = [];
	for (const [agent, list] of byAgent) {
		const totalCost = list.reduce((s, e) => s + e.cost, 0);
		stats.push({
			agent,
			runs: list.length,
			failed: list.filter((e) => e.status !== "done").length,
			totalCost,
			avgCost: totalCost / list.length,
			avgDurationMs: list.reduce((s, e) => s + e.durationMs, 0) / list.length,
			avgOutput: list.reduce((s, e) => s + e.output, 0) / list.length,
		});
	}
	stats.sort((a, b) => b.totalCost - a.totalCost);
	return stats;
}

function fmtMs(ms: number): string {
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Aligned monospace table for the /agents stats transcript message. */
export function formatRunStats(stats: AgentRunStats[]): string[] {
	if (stats.length === 0) return ["No subagent runs logged yet."];
	const nameW = Math.max(5, ...stats.map((s) => s.agent.length));
	const header = `${"agent".padEnd(nameW)}  runs  fail   total $     avg $  avg time  avg ↓out`;
	const rows = stats.map(
		(s) =>
			`${s.agent.padEnd(nameW)}  ${String(s.runs).padStart(4)}  ${String(s.failed).padStart(4)}  ${s.totalCost.toFixed(4).padStart(8)}  ${s.avgCost.toFixed(4).padStart(8)}  ${fmtMs(s.avgDurationMs).padStart(8)}  ${String(Math.round(s.avgOutput)).padStart(8)}`,
	);
	const total = stats.reduce((s, a) => s + a.totalCost, 0);
	const runs = stats.reduce((s, a) => s + a.runs, 0);
	return [header, ...rows, `${runs} runs · $${total.toFixed(4)} total, all sessions · nested spawn cost included`];
}
