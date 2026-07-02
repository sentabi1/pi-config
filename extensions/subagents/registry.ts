import type { AgentConfig } from "./agents.ts";
import { emptyUsage, type RunEvent, type RunHandle, type RunResult, type RunStatus, type RunUsage } from "./engine.ts";

export interface RunRecord {
	id: number;
	agentName: string;
	color: string;
	task: string;
	status: RunStatus;
	lastTool?: string;
	lastText?: string;
	usage: RunUsage;
	contextPercent: number | null;
	startedAt: number;
	endedAt?: number;
	mode: "single" | "parallel" | "chain";
	chainStep?: number;
	handle?: RunHandle;
}

export class RunRegistry {
	private records: RunRecord[] = [];
	private listeners = new Set<() => void>();
	private nextId = 1;

	create(opts: { agent: AgentConfig; task: string; mode: "single" | "parallel" | "chain"; chainStep?: number }): RunRecord {
		if (process.env.SUBAGENT_ROUTING_EVAL === "1") console.error(`SUBAGENT_EVAL_SPAWN ${opts.agent.name}`);
		const rec: RunRecord = {
			id: this.nextId++,
			agentName: opts.agent.name,
			color: opts.agent.color,
			task: opts.task,
			status: "pending",
			usage: emptyUsage(),
			contextPercent: null,
			startedAt: Date.now(),
			mode: opts.mode,
			chainStep: opts.chainStep,
		};
		this.records.push(rec);
		this.notify();
		return rec;
	}

	applyEvent(rec: RunRecord, e: RunEvent): void {
		switch (e.type) {
			case "status":
				rec.status = e.status;
				break;
			case "tool":
				rec.lastTool = e.argsPreview;
				break;
			case "text":
				rec.lastText = e.text.split("\n").find((l) => l.trim()) ?? rec.lastText;
				break;
			case "usage":
				rec.usage = e.usage;
				rec.contextPercent = e.contextPercent;
				break;
		}
		this.notify();
	}

	finish(rec: RunRecord, result: RunResult): void {
		rec.status = result.ok ? "done" : rec.status === "aborted" ? "aborted" : "error";
		rec.usage = result.usage;
		rec.contextPercent = result.contextPercent;
		rec.endedAt = Date.now();
		rec.handle = undefined;
		this.notify();
	}

	stop(rec: RunRecord): void {
		rec.handle?.abort();
		rec.status = "aborted";
		this.notify();
	}

	elapsedMs(rec: RunRecord): number {
		return (rec.endedAt ?? Date.now()) - rec.startedAt;
	}

	running(): RunRecord[] {
		return this.records.filter((r) => r.status === "running" || r.status === "pending");
	}

	recent(limit: number): RunRecord[] {
		const finished = this.records.filter((r) => r.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
		return [...this.running(), ...finished].slice(0, limit);
	}

	hasActive(): boolean {
		return this.running().length > 0;
	}

	/** Cumulative cost of every subagent run this session (top-level dispatched/tool runs;
	 * nested spawns are summed inside the tool result, not here). */
	totalCost(): number {
		return this.records.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/** Force a render/notify (e.g. after toggling widget collapse state). */
	touch(): void {
		this.notify();
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}
}
