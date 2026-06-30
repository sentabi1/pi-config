import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfig } from "./agents.ts";
import { resolveChildToolNames } from "./agents.ts";

/** How deep a spawn chain may nest (worker → scout → … ) before delegation is refused. */
export const MAX_SPAWN_DEPTH = 3;

/** Default guards so a hung or looping child can never block forever / burn unbounded tokens. */
export const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_TURNS = 60;

/** Live snapshot of a nested (spawned) run, surfaced to the parent for the spawn tree. */
export interface SpawnChildUpdate {
	agent: string;
	color: string;
	status: "running" | "done" | "error";
	cost: number;
}

/** Lets a child agent delegate to the agents named in its `spawn:` list. */
export interface SpawnContext {
	depth: number;
	resolveAgent: (name: string) => AgentConfig | undefined;
	onChild?: (idx: number, update: SpawnChildUpdate) => void;
}

export type RunStatus = "pending" | "running" | "done" | "error" | "aborted";

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	contextTokens: number;
}

export type RunEvent =
	| { type: "status"; status: RunStatus }
	| { type: "tool"; name: string; argsPreview: string }
	| { type: "text"; text: string }
	| { type: "usage"; usage: RunUsage; contextPercent: number | null };

export interface RunResult {
	ok: boolean;
	finalText: string;
	usage: RunUsage;
	contextPercent: number | null;
	error?: string;
}

export interface RunHandle {
	promise: Promise<RunResult>;
	abort(): void;
}

export function emptyUsage(): RunUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		toolCalls: 0,
		contextTokens: 0,
	};
}

/** Collect AGENTS.md conventions for a forked child: the global one (~/.pi/agent) plus every
 * AGENTS.md from the filesystem root down to cwd (nearest wins, appended last). CLAUDE.md and
 * the rest of pi's context stack are deliberately excluded. */
function collectAgentsMd(cwd: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (file: string) => {
		try {
			const real = fs.realpathSync(file);
			if (seen.has(real)) return;
			const txt = fs.readFileSync(file, "utf-8").trim();
			if (txt) {
				seen.add(real);
				out.push(`# Project conventions (${file})\n${txt}`);
			}
		} catch {
			/* missing/unreadable → skip */
		}
	};
	add(path.join(getAgentDir(), "AGENTS.md")); // global, least specific
	const dirs: string[] = [];
	let cur = cwd;
	while (true) {
		dirs.unshift(cur);
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	for (const dir of dirs) add(path.join(dir, "AGENTS.md")); // root → cwd, nearest last
	return out;
}

/** Match a model pattern against the registry. Supports "provider/id", bare "id", or substring. */
export function resolveModel(registry: ModelRegistry, pattern: string | undefined): Model<any> | undefined {
	if (!pattern) return undefined;
	const all = registry.getAll();
	if (pattern.includes("/")) {
		const [p, id] = pattern.split("/", 2);
		const exact = registry.find(p, id);
		if (exact) return exact;
	}
	const byId = all.find((m: any) => m.id === pattern);
	if (byId) return byId;
	return all.find((m: any) => `${m.provider}/${m.id}`.includes(pattern) || m.id.includes(pattern));
}

function argsPreview(name: string, args: any): string {
	try {
		if (name === "bash") return `$ ${String(args?.command ?? "").slice(0, 60)}`;
		if (name === "read" || name === "edit" || name === "write")
			return `${name} ${args?.file_path ?? args?.path ?? ""}`;
		if (name === "grep") return `grep /${args?.pattern ?? ""}/`;
		if (name === "find") return `find ${args?.pattern ?? ""}`;
		const s = JSON.stringify(args ?? {});
		return `${name} ${s.length > 50 ? `${s.slice(0, 50)}…` : s}`;
	} catch {
		return name;
	}
}

export async function runAgent(args: {
	agent: AgentConfig;
	task: string;
	parentModel: Model<any> | undefined;
	registry: ModelRegistry;
	cwd: string;
	fork: boolean;
	signal?: AbortSignal;
	spawn?: SpawnContext;
	/** Wall-clock cap; the child is aborted past this. Default DEFAULT_RUN_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Max assistant turns before the child is aborted. Default DEFAULT_MAX_TURNS. */
	maxTurns?: number;
	onEvent: (e: RunEvent) => void;
}): Promise<RunHandle> {
	const { agent, registry, cwd, onEvent } = args;
	const model = resolveModel(registry, agent.model) ?? args.parentModel;

	// Fast-fail guards: never hang on an already-aborted run or a missing model.
	if (args.signal?.aborted) {
		return {
			promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "aborted" }),
			abort: () => {},
		};
	}
	if (!model) {
		const err = `No model available for agent "${agent.name}" (pattern: ${agent.model ?? "inherit"})`;
		onEvent({ type: "status", status: "error" });
		return {
			promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: err }),
			abort: () => {},
		};
	}

	// Spawn: if this agent may delegate and we're under the depth cap, hand the child
	// session a scoped `subagent` tool limited to the agents in its `spawn:` list.
	const spawnDepth = args.spawn?.depth ?? 0;
	const canSpawn = agent.spawn.length > 0 && spawnDepth < MAX_SPAWN_DEPTH;
	const customTools: ToolDefinition[] = [];
	if (canSpawn) {
		const allow = agent.spawn;
		const resolveAgent = args.spawn?.resolveAgent ?? (() => undefined);
		let seq = 0;
		customTools.push({
			name: "subagent",
			label: "Subagent",
			description: `Delegate a focused subtask to one specialized subagent (single mode). Allowed: ${allow.join(", ")}. The subagent runs in isolation and returns only its summary.`,
			parameters: Type.Object({ agent: Type.String({ description: `One of: ${allow.join(", ")}` }), task: Type.String({ description: "The task for the subagent" }) }),
			async execute(_id, params: { agent: string; task: string }, signal) {
				if (!allow.includes(params.agent)) return { content: [{ type: "text", text: `Not allowed to delegate to "${params.agent}". Allowed: ${allow.join(", ")}` }], isError: true };
				const child = resolveAgent(params.agent);
				if (!child) return { content: [{ type: "text", text: `Unknown agent "${params.agent}".` }], isError: true };
				const idx = seq++;
				args.spawn?.onChild?.(idx, { agent: child.name, color: child.color, status: "running", cost: 0 });
				const handle = await runAgent({
					agent: child, task: params.task, parentModel: model, registry, cwd, fork: child.fork, signal: signal ?? args.signal,
					spawn: { depth: spawnDepth + 1, resolveAgent, onChild: args.spawn?.onChild },
					onEvent: () => {},
				});
				const r = await handle.promise;
				args.spawn?.onChild?.(idx, { agent: child.name, color: child.color, status: r.ok ? "done" : "error", cost: r.usage.cost });
				return { content: [{ type: "text", text: r.ok ? r.finalText : `Subagent ${child.name} failed: ${r.error ?? r.finalText}` }], isError: !r.ok };
			},
		});
	}

	// Lean, isolated resource loader. systemPrompt = agent body → child sees only its prompt + task.
	// fork: true inherits ONLY your AGENTS.md conventions (not CLAUDE.md or the full context
	// stack) — we keep noContextFiles true and inject the AGENTS.md text via appendSystemPrompt.
	const conventions = args.fork ? collectAgentsMd(cwd) : [];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager: SettingsManager.create(cwd, getAgentDir()),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPrompt: conventions.length > 0 ? conventions : undefined,
		systemPrompt: agent.systemPrompt || undefined,
	});
	await loader.reload();

	const toolCfg = resolveChildToolNames(agent, canSpawn);
	const authStorage = AuthStorage.create();
	const { session } = await createAgentSession({
		cwd,
		model,
		thinkingLevel: agent.thinking as any,
		tools: toolCfg.tools,
		noTools: toolCfg.noTools,
		customTools: customTools.length > 0 ? customTools : undefined,
		resourceLoader: loader,
		modelRegistry: registry,
		authStorage,
		sessionManager: SessionManager.inMemory(cwd),
	});

	const usage = emptyUsage();
	const recomputeContext = (): number | null => {
		const cu = session.getContextUsage();
		if (cu?.tokens != null) usage.contextTokens = cu.tokens;
		return cu?.percent ?? null;
	};

	// Stop reason: external abort, wall-clock timeout, or turn-cap. All abort the session.
	let stopReason: "aborted" | "timeout" | "turnlimit" | null = null;
	const stop = (reason: "aborted" | "timeout" | "turnlimit") => {
		if (!stopReason) stopReason = reason;
		void session.abort();
	};
	const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS;

	const unsubscribe = session.subscribe((e) => {
		switch (e.type) {
			case "agent_start":
				onEvent({ type: "status", status: "running" });
				break;
			case "tool_execution_start":
				usage.toolCalls += 1;
				onEvent({ type: "tool", name: e.toolName, argsPreview: argsPreview(e.toolName, e.args) });
				break;
			case "message_end": {
				const msg: any = e.message;
				if (msg?.role === "assistant") {
					usage.turns += 1;
					if (usage.turns >= maxTurns) stop("turnlimit");
					const u = msg.usage;
					if (u) {
						usage.input += u.input || 0;
						usage.output += u.output || 0;
						usage.cacheRead += u.cacheRead || 0;
						usage.cacheWrite += u.cacheWrite || 0;
						usage.cost += u.cost?.total || 0;
						if (u.totalTokens) usage.contextTokens = u.totalTokens;
					}
					for (const part of msg.content ?? []) {
						if (part.type === "text" && part.text?.trim()) onEvent({ type: "text", text: part.text });
					}
				}
				onEvent({ type: "usage", usage: { ...usage }, contextPercent: recomputeContext() });
				break;
			}
		}
	});

	const onAbort = () => stop("aborted");
	if (args.signal) {
		if (args.signal.aborted) onAbort();
		else args.signal.addEventListener("abort", onAbort, { once: true });
	}

	const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	if (typeof timer === "object" && "unref" in timer) timer.unref?.();

	const firstMessage = `Task: ${args.task}`;
	const reasonText = (r: "aborted" | "timeout" | "turnlimit"): string =>
		r === "timeout" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : r === "turnlimit" ? `hit turn limit (${maxTurns})` : "aborted";

	const promise: Promise<RunResult> = (async () => {
		try {
			onEvent({ type: "status", status: "running" });
			await session.prompt(firstMessage);
			const finalText = session.getLastAssistantText() ?? "";
			const contextPercent = recomputeContext();
			// A timeout/turn-cap that produced partial text is still a failure, but we keep the text.
			const ok = !stopReason && !!finalText.trim();
			const status: RunStatus = stopReason === "aborted" ? "aborted" : ok ? "done" : "error";
			onEvent({ type: "status", status });
			return {
				ok,
				finalText: finalText || "(no output)",
				usage: { ...usage },
				contextPercent,
				error: stopReason ? reasonText(stopReason) : undefined,
			};
		} catch (err) {
			onEvent({ type: "status", status: stopReason === "aborted" ? "aborted" : "error" });
			return {
				ok: false,
				finalText: "",
				usage: { ...usage },
				contextPercent: recomputeContext(),
				error: stopReason ? reasonText(stopReason) : err instanceof Error ? err.message : String(err),
			};
		} finally {
			clearTimeout(timer);
			unsubscribe();
			args.signal?.removeEventListener("abort", onAbort);
			session.dispose();
		}
	})();

	return {
		promise,
		abort: onAbort,
	};
}
