import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { colorDot, SPINNER_FRAMES } from "./colors.ts";
import { emptyUsage, type RunResult, runAgent, type SpawnChildUpdate } from "./engine.ts";
import type { RunRecord, RunRegistry } from "./registry.ts";

export const MAX_PARALLEL = 6;
const PER_TASK_CAP = 16 * 1024;

export function substitutePrevious(task: string, previous: string): string {
	return task.replace(/\{previous\}/g, previous);
}

async function mapWithConcurrency<I, O>(items: I[], limit: number, fn: (item: I, i: number) => Promise<O>): Promise<O[]> {
	if (items.length === 0) return [];
	const n = Math.max(1, Math.min(limit, items.length));
	const out: O[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		new Array(n).fill(0).map(async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

function cap(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PER_TASK_CAP) return text;
	let t = text.slice(0, PER_TASK_CAP);
	while (Buffer.byteLength(t, "utf8") > PER_TASK_CAP) t = t.slice(0, -1);
	return `${t}\n[truncated]`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** mm:ss elapsed, shared by the tool result and the /name working line. */
export function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One-line live status for the editor's working indicator during a /name run. */
export function progressLabel(agent: string, elapsedMs: number, tools: number, cost: number): string {
	return `⟳ ${agent} · ${fmtDuration(elapsedMs)} · ${tools} tool${tools === 1 ? "" : "s"} · $${cost.toFixed(4)}`;
}

// --- shared dispatch surface (dashboard / sequence routing) ---

export interface DispatchDeps {
	registry: RunRegistry;
	getCtx: () => ExtensionContext;
	notify?: (rec: RunRecord, r: RunResult) => void;
	/** Render a dispatched run's result into the transcript (for /name and sequences). */
	showOutput?: (agent: string, r: RunResult) => void;
}

export async function dispatchSingle(deps: DispatchDeps, agent: AgentConfig, task: string, onProgress?: (p: { tools: number; cost: number }) => void): Promise<RunResult> {
	const ctx = deps.getCtx();
	const rec = deps.registry.create({ agent, task, mode: "single" });
	const resolveAgent = makeResolveAgent(deps);
	const handle = await runAgent({
		agent, task, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: agent.fork,
		spawn: agent.spawn.length > 0 ? { depth: 0, resolveAgent } : undefined,
		onEvent: (e) => {
			deps.registry.applyEvent(rec, e);
			onProgress?.({ tools: rec.usage.toolCalls, cost: rec.usage.cost });
		},
	});
	rec.handle = handle;
	const r = await handle.promise;
	deps.registry.finish(rec, r);
	return r;
}

/** Resolve an agent name against the current project's discovered agents (for spawn). */
function makeResolveAgent(deps: DispatchDeps): (name: string) => AgentConfig | undefined {
	return (name: string) => {
		const ctx = deps.getCtx();
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		return agents.find((a) => a.name === name);
	};
}

export async function dispatchChain(deps: DispatchDeps, steps: Array<{ agent: AgentConfig; task: string }>, signal?: AbortSignal): Promise<RunResult> {
	let previous = "";
	let last: RunResult = { ok: true, finalText: "", usage: emptyUsage(), contextPercent: null };
	for (let i = 0; i < steps.length; i++) {
		if (signal?.aborted) {
			last = { ok: false, finalText: previous, usage: emptyUsage(), contextPercent: null, error: "aborted" };
			break;
		}
		const ctx = deps.getCtx();
		const taskText = substitutePrevious(steps[i].task, previous);
		const rec = deps.registry.create({ agent: steps[i].agent, task: taskText, mode: "chain", chainStep: i + 1 });
		const handle = await runAgent({
			agent: steps[i].agent, task: taskText, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: steps[i].agent.fork, signal,
			spawn: steps[i].agent.spawn.length > 0 ? { depth: 0, resolveAgent: makeResolveAgent(deps) } : undefined,
			onEvent: (e) => deps.registry.applyEvent(rec, e),
		});
		rec.handle = handle;
		last = await handle.promise;
		deps.registry.finish(rec, last);
		if (!last.ok) break;
		previous = last.finalText;
	}
	return last;
}

// --- the subagent tool ---

const TaskItem = Type.Object({ agent: Type.String({ description: "Agent name" }), task: Type.String({ description: "Task for the agent" }) });
const ChainItem = Type.Object({ agent: Type.String({ description: "Agent name" }), task: Type.String({ description: "Task; may include {previous}" }) });
const RetryConfig = Type.Object({
	maxRetries: Type.Number({ description: "Max retry attempts when a step fails (sequence only)." }),
	retrySteps: Type.Array(ChainItem, { description: "Steps to retry, typically [reviewer-step, fix-step]" }),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single mode: the task" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequence mode; {previous} flows" })),
	retry: Type.Optional(RetryConfig, { description: "Optional retry loop at the end of the sequence. If set, the retrySteps run up to maxRetries times until the last step succeeds." }),
});

interface LiveRow {
	color: string;
	agent: string;
	task: string;
	status: "running" | "done" | "error";
	elapsedMs: number;
	startedAt: number;
	preview: string;
	usage: { input: number; output: number; cost: number; turns: number; tools: number; ctx: number | null };
	/** Nested runs this agent spawned (spawn tree). Keyed by spawn index. */
	children?: SpawnChildUpdate[];
}
interface ToolDetails {
	mode: "single" | "parallel" | "chain";
	rows: LiveRow[];
}

export function registerSubagentTool(pi: ExtensionAPI, env: DispatchDeps): void {
	pi.registerTool<typeof Params, ToolDetails>({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to specialized subagents that run with their own isolated context and return only a summary.",
			"Modes: single { agent, task }; parallel { tasks:[…] }; sequence { chain:[…] } (sequential, {previous} passes the prior step's output forward).",
			"Add retry to a sequence: { chain: [...], retry: { maxRetries: N, retrySteps: [...] } } loops retrySteps until the last step succeeds, up to N attempts.",
			"Delegate read-only investigation to scout, planning to planner, post-change review to reviewer, implementation to worker.",
		].join(" "),
		promptSnippet: "Delegate recon/planning/review/implementation to subagents (single, parallel, or sequence) with isolated context. Retry sequences with { retry: { maxRetries, retrySteps } }.",
		promptGuidelines: [
			"Use subagent('scout', …) proactively for codebase questions instead of reading many files yourself.",
			"Use subagent('worker', …) for well-scoped implementation work; reviewer reports findings but does not write code.",
			"Use subagent('svelte-worker', …) for any .svelte/.svelte.ts/.svelte.js edit, even a tiny one.",
			"Use subagent('debugger', …) for a known failure, crash, stack trace, or non-zero test/build exit.",
			"After code changes, use subagent('reviewer', …) to review the diff.",
			"Use sequence mode + {previous} for multi-stage work; parallel mode for independent investigations.",
			"Add retry to a sequence: subagent({ chain: [reviewer-step, worker-fix-step], retry: { maxRetries: 2, retrySteps: [reviewer, worker] } }) to loop until clean.",
			"Subagents return only their final summary; their intermediate tool output is intentionally hidden.",
		],
		parameters: Params,
		renderShell: "self",

		async execute(_id, params, signal, onUpdate, ctx) {
			const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
			const byName = (n: string) => agents.find((a) => a.name === n);
			const modes = [Boolean(params.agent && params.task), (params.tasks?.length ?? 0) > 0, (params.chain?.length ?? 0) > 0].filter(Boolean).length;
			if (modes !== 1) {
				const list = agents.map((a) => a.name).join(", ") || "none";
				return { content: [{ type: "text", text: `Provide exactly one of single {agent,task}, parallel {tasks}, or sequence {chain}. Available: ${list}` }], details: { mode: "single", rows: [] } };
			}
			const mode: ToolDetails["mode"] = params.chain ? "chain" : params.tasks ? "parallel" : "single";
			const rows: LiveRow[] = [];
			const emit = () => onUpdate?.({ content: [{ type: "text", text: `${rows.filter((r) => r.status !== "running").length}/${rows.length} done` }], details: { mode, rows: rows.map((r) => ({ ...r, children: r.children ? [...r.children] : undefined })) } });

			// Tick the clock once a second so elapsed advances even during long, quiet tool calls.
			const ticker = setInterval(() => {
				const now = Date.now();
				for (let i = 0; i < rows.length; i++) {
					if (rows[i].status === "running") rows[i].elapsedMs = now - rows[i].startedAt;
				}
				if (rows.some((r) => r.status === "running")) emit();
			}, 1000);
			(ticker as any).unref?.();

			// Run one agent, streaming its live usage into rows[idx].
			const runRow = async (agent: AgentConfig, task: string, idx: number, chainStep?: number): Promise<RunResult> => {
				const startedAt = Date.now();
				rows[idx] = { color: agent.color, agent: agent.name, task, status: "running", elapsedMs: 0, startedAt, preview: "", usage: { input: 0, output: 0, cost: 0, turns: 0, tools: 0, ctx: null } };
				const rec = env.registry.create({ agent, task, mode, chainStep });
				const onChild = (cidx: number, update: SpawnChildUpdate) => {
					const children = (rows[idx].children ??= []);
					children[cidx] = update;
					emit();
				};
				const handle = await runAgent({
					agent, task, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: agent.fork, signal,
					spawn: agent.spawn.length > 0 ? { depth: 0, resolveAgent: byName, onChild } : undefined,
					onEvent: (e) => {
						env.registry.applyEvent(rec, e);
						const u = rec.usage;
						rows[idx].usage = { input: u.input, output: u.output, cost: u.cost, turns: u.turns, tools: u.toolCalls, ctx: rec.contextPercent };
						rows[idx].elapsedMs = Date.now() - startedAt;
						if (e.type === "text") rows[idx].preview = (e.text.split("\n").find((l) => l.trim()) ?? rows[idx].preview).slice(0, 80);
						emit();
					},
				});
				rec.handle = handle;
				const r = await handle.promise;
				env.registry.finish(rec, r);
				const u = r.usage;
				rows[idx] = { color: agent.color, agent: agent.name, task, status: r.ok ? "done" : "error", elapsedMs: Date.now() - startedAt, startedAt, preview: (r.finalText.split("\n").find((l) => l.trim()) ?? "").slice(0, 80), usage: { input: u.input, output: u.output, cost: u.cost, turns: u.turns, tools: u.toolCalls, ctx: r.contextPercent }, children: rows[idx].children };
				emit();
				return r;
			};

			try {
			if (params.agent && params.task) {
				const agent = byName(params.agent);
				if (!agent) return { content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${agents.map((a) => a.name).join(", ")}` }], details: { mode, rows: [] }, isError: true };
				const r = await runRow(agent, params.task, 0);
				return { content: [{ type: "text", text: r.ok ? cap(r.finalText) : `Agent failed: ${r.error ?? r.finalText}` }], details: { mode, rows }, isError: !r.ok };
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL) return { content: [{ type: "text", text: `Too many parallel tasks (max ${MAX_PARALLEL}).` }], details: { mode, rows: [] }, isError: true };
				const unknown = params.tasks.find((t) => !byName(t.agent));
				if (unknown) return { content: [{ type: "text", text: `Unknown agent "${unknown.agent}".` }], details: { mode, rows: [] }, isError: true };
				const results = await mapWithConcurrency(params.tasks, MAX_PARALLEL, (t, i) => runRow(byName(t.agent)!, t.task, i));
				const ok = results.filter((r) => r.ok).length;
				const text = results.map((r, i) => `### [${rows[i].agent}] ${r.ok ? "ok" : "failed"}\n\n${cap(r.finalText)}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${text}` }], details: { mode, rows }, isError: ok === 0 };
			}

			if (params.chain && params.chain.length > 0) {
				const unknown = params.chain.find((s) => !byName(s.agent));
				if (unknown) return { content: [{ type: "text", text: `Unknown agent "${unknown.agent}".` }], details: { mode, rows: [] }, isError: true };
				if (params.retry) {
						const unknownRetry = params.retry.retrySteps.find((s) => !byName(s.agent));
						if (unknownRetry) return { content: [{ type: "text", text: `Unknown agent in retrySteps "${unknownRetry.agent}".` }], details: { mode, rows: [] }, isError: true };
				}
				let previous = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const r = await runRow(byName(step.agent)!, substitutePrevious(step.task, previous), i, i + 1);
						if (!r.ok) return { content: [{ type: "text", text: `Sequence stopped at step ${i + 1} (${step.agent}): ${r.error ?? r.finalText}` }], details: { mode, rows }, isError: true };
					previous = r.finalText;
				}
				// Retry loop: if retry config is set, run retrySteps up to maxRetries times until the last step succeeds.
				if (params.retry && params.retry.maxRetries > 0) {
					const retrySteps = params.retry.retrySteps;
					const retryCount = params.retry.maxRetries;
					const startRow = params.chain.length;
					for (let attempt = 1; attempt <= retryCount; attempt++) {
						let retryOk = true;
						for (let j = 0; j < retrySteps.length; j++) {
							const step = retrySteps[j];
							const rowIdx = startRow + (attempt - 1) * retrySteps.length + j;
							const r = await runRow(byName(step.agent)!, substitutePrevious(step.task, previous), rowIdx, params.chain.length + j + 1);
							if (!r.ok) {
								previous = r.finalText;
								retryOk = false;
								break;
							}
							previous = r.finalText;
						}
						if (retryOk) break; // last retry step succeeded
						if (attempt === retryCount) {
							return { content: [{ type: "text", text: `Retry loop exhausted after ${retryCount} attempt(s). Last output:\n\n${cap(previous || "(no output)")}` }], details: { mode, rows }, isError: true };
						}
					}
				}
				return { content: [{ type: "text", text: cap(previous || "(no output)") }], details: { mode, rows } };
			}
			return { content: [{ type: "text", text: "No mode selected." }], details: { mode, rows: [] }, isError: true };
			} finally {
				clearInterval(ticker);
			}
		},

		renderCall(args, theme) {
			// Show which agent(s) and the task preview so the dispatch is legible at a glance.
			const head = theme.fg("toolTitle", theme.bold("subagent"));
			if (args.chain) {
				const names = args.chain.map((s) => s.agent).join(" → ");
				const retry = args.retry ? ` ↻×${args.retry.maxRetries}` : "";
					return new Text(`${head} ${theme.fg("accent", `sequence: ${names}`)}${theme.fg("warning", retry)}`, 0, 0);
			}
			if (args.tasks) {
				const names = args.tasks.map((t) => t.agent).join(", ");
				return new Text(`${head} ${theme.fg("accent", `parallel: ${names}`)}`, 0, 0);
			}
			return new Text(`${head} ${theme.fg("accent", args.agent ?? "?")}${theme.fg("dim", ` ${(args.task ?? "").slice(0, 60).replace(/\n/g, " ")}`)}`, 0, 0);
		},

		renderResult(result, options, theme, _context) {
			const d = result.details as ToolDetails | undefined;
			const rows = d?.rows ?? [];
			const t = result.content[0];
			const fullText = t?.type === "text" ? t.text : "(no output)";
			const c = new Container();
			const done = rows.filter((r) => r.status !== "running").length;
			// Total cost across every row and every nested (spawned) run.
			const totalCost = rows.reduce((sum, r) => sum + r.usage.cost + (r.children?.reduce((s, ch) => s + (ch?.cost ?? 0), 0) ?? 0), 0);
			// Time-based spinner frame — decouples from event frequency so it always animates.
			const frame = Math.floor(Date.now() / 120) % SPINNER_FRAMES.length;
			const spinnerFrame = SPINNER_FRAMES[frame];
			// Header: no "subagent" label here — renderCall already prints it (was doubled).
			c.addChild(new Text(theme.fg("muted", `${d?.mode ?? ""} · ${done}/${rows.length}`) + theme.fg("dim", ` · $${totalCost.toFixed(4)} total`), 0, 0));
			// One line per agent with LIVE elapsed/tools/usage/cost/context — scroll-safe (it's tool output).
			for (const r of rows) {
				const icon = r.status === "running" ? theme.fg("warning", spinnerFrame) : r.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const stats = `${theme.fg("dim", fmtDuration(r.elapsedMs))} ${theme.fg("muted", `${r.usage.tools}⚒`)} ${theme.fg("dim", `↑${fmtTokens(r.usage.input)} ↓${fmtTokens(r.usage.output)} $${r.usage.cost.toFixed(4)}`)}${r.usage.ctx != null ? theme.fg("dim", ` ${Math.round(r.usage.ctx)}%`) : ""}`;
				c.addChild(new Text(`${icon} ${colorDot(r.color)} ${theme.fg("accent", r.agent)} ${stats}`, 0, 0));
				// Echo the task so you can see what each agent was asked.
				if (r.task) c.addChild(new Text(`   ${theme.fg("muted", truncateToWidth(`▸ ${r.task.replace(/\n/g, " ")}`, 90))}`, 0, 0));
				if (r.preview) c.addChild(new Text(`   ${theme.fg("dim", truncateToWidth(r.preview, 90))}`, 0, 0));
				// Spawn tree: nested runs this agent delegated to, indented under it.
				for (const ch of r.children ?? []) {
					if (!ch) continue;
					const cicon = ch.status === "running" ? theme.fg("warning", spinnerFrame) : ch.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
					c.addChild(new Text(`   ${theme.fg("dim", "↳")} ${cicon} ${colorDot(ch.color)} ${theme.fg("accent", ch.agent)} ${theme.fg("dim", `$${ch.cost.toFixed(4)}`)}`, 0, 0));
				}
			}
			if (options.expanded) {
				c.addChild(new Spacer(1));
				c.addChild(new Text(fullText, 0, 0));
			} else if (rows.every((r) => r.status !== "running")) {
				c.addChild(new Text(theme.fg("muted", "(ctrl+o to expand full output)"), 0, 0));
			}
			return c;
		},
	});
}
