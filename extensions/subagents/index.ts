import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { appendDebuggerNudge, isSveltePath, isTestOrBuildCommand, svelteBackstopReason, toolInputPath } from "./backstops.ts";
import { discoverAgents } from "./agents.ts";
import { ArmedChain, routeArmedChain } from "./chain-arm.ts";
import { openDashboard } from "./dashboard.ts";
import type { RunResult } from "./engine.ts";
import { buildActiveAgentsBlock } from "./guidance.ts";
import { Keymap } from "./keymap.ts";
import { RunRegistry } from "./registry.ts";
import { SubagentState } from "./state.ts";
import { type DispatchDeps, dispatchSingle, fmtDuration, progressLabel, registerSubagentTool } from "./tool.ts";
import { aggregateRunStats, appendRunLog, entryFromRecord, formatRunStats, readRunLog } from "./runlog.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type WritableAgent, writeAgentFile, deleteAgentFile } from "./agent-writer.ts";

interface OutputDetails {
	agent: string;
	ok: boolean;
	task?: string;
	elapsedMs?: number;
	text: string;
	usage: { input: number; output: number; cost: number; tools?: number };
}

export default function (pi: ExtensionAPI) {
	const registry = new RunRegistry();
	const state = new SubagentState();
	const km = new Keymap(state);
	const armed = new ArmedChain();
	const holder: { ctx?: ExtensionContext } = {};
	const registered = new Set<string>();
	const runLogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs.jsonl");

	// Cost feedback loop: persist every finished run so /agents stats can show
	// whether each agent's spawns pay for themselves across sessions.
	registry.onFinish((rec) => appendRunLog(runLogPath, entryFromRecord(rec)));

	// Backstops only make sense when the roster actually has the specialist they
	// route to — a shared install without svelte-worker must not block .svelte edits.
	const hasAgent = (ctx: ExtensionContext, name: string): boolean => {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		return agents.some((a) => a.name === name);
	};

	// Render a dispatched run's result into the transcript (for /<name> and sequences).
	pi.registerMessageRenderer<OutputDetails>("subagent-output", (msg, _opts, theme) => {
		const d = msg.details;
		if (!d) return undefined;
		const c = new Container();
		const icon = d.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const elapsed = d.elapsedMs != null ? `${fmtDuration(d.elapsedMs)} · ` : "";
		const tools = d.usage.tools != null ? `${d.usage.tools}⚒ · ` : "";
		c.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(d.agent))} ${theme.fg("dim", `${elapsed}${tools}↑${d.usage.input} ↓${d.usage.output} $${d.usage.cost.toFixed(4)}`)}`,
				0,
				0,
			),
		);
		// Echo what was asked, so you can see your own prompt next to the result.
		if (d.task) c.addChild(new Text(theme.fg("muted", `▸ ${d.task.replace(/\n/g, " ")}`), 0, 0));
		c.addChild(new Text(d.text || "(no output)", 0, 0));
		return c;
	});

	const showOutput = (agent: string, r: RunResult, task?: string, elapsedMs?: number): void => {
		const text = r.ok ? r.finalText : r.error ?? r.finalText;
		pi.sendMessage<OutputDetails>({
			customType: "subagent-output",
			content: text || "(no output)",
			display: true,
			details: { agent, ok: r.ok, task, elapsedMs, text: text || "(no output)", usage: { input: r.usage.input, output: r.usage.output, cost: r.usage.cost, tools: r.usage.toolCalls } },
		});
	};

	// /agents stats — the per-agent cost table, monospace-aligned in the transcript.
	pi.registerMessageRenderer<{ lines: string[] }>("subagent-stats", (msg, _opts, theme) => {
		const d = msg.details;
		if (!d) return undefined;
		const c = new Container();
		c.addChild(new Text(theme.fg("toolTitle", theme.bold("subagent stats")), 0, 0));
		d.lines.forEach((line, i) => {
			const isEdge = i === 0 || i === d.lines.length - 1;
			c.addChild(new Text(isEdge ? theme.fg("muted", line) : line, 0, 0));
		});
		return c;
	});

	const showStats = (): void => {
		const lines = formatRunStats(aggregateRunStats(readRunLog(runLogPath)));
		pi.sendMessage<{ lines: string[] }>({
			customType: "subagent-stats",
			content: lines.join("\n"),
			display: true,
			details: { lines },
		});
	};

	const deps: DispatchDeps = { registry, getCtx: () => holder.ctx as ExtensionContext, showOutput };

	registerSubagentTool(pi, deps);

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const filePath = toolInputPath(event.input as Record<string, unknown>);
		if (!isSveltePath(filePath)) return;
		if (!hasAgent(ctx, "svelte-worker")) return;
		return { block: true, reason: svelteBackstopReason(filePath) };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || !event.isError) return;
		const command = String(event.input.command ?? "");
		if (!isTestOrBuildCommand(command)) return;
		if (!hasAgent(ctx, "debugger")) return;
		return { content: appendDebuggerNudge(event.content, command) };
	});

	const killAll = (ctx: ExtensionContext): void => {
		let n = 0;
		for (const r of registry.running()) {
			registry.stop(r);
			n++;
		}
		ctx.ui.notify(n ? `Killed ${n} subagent${n > 1 ? "s" : ""}.` : "No running subagents.", "info");
	};

	// Auto-spawn: advertise agents to the main model each turn so it delegates proactively.
	// Default (advertiseAll) = every discovered agent in its policy tier; otherwise
	// hard-trigger agents plus toggled-active judgment/explicit agents.
	pi.on("before_agent_start", (event, ctx) => {
		holder.ctx = ctx;
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		const advertised = state.getAdvertiseAll() ? agents : agents.filter((a) => a.advertise === "always" || state.isActive(a.name));
		const block = buildActiveAgentsBlock(advertised);
		return block ? { systemPrompt: `${event.systemPrompt}\n${block}` } : {};
	});

	// Option A: an armed sequence consumes the next typed message.
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		holder.ctx = ctx;
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		const action = routeArmedChain(event.text, armed, deps, (n) => agents.find((a) => a.name === n), (m, t) => ctx.ui.notify(m, t));
		return { action };
	});

	pi.registerCommand("agents", {
		description: "Open the subagents dashboard. `/agents -k` kills running subagents; `/agents auto [on|off]` toggles proactive auto-delegation; `/agents stats` shows per-agent cost history.",
		handler: async (args, ctx) => {
			holder.ctx = ctx;
			const a = args.trim();
			if (a.includes("-k")) {
				killAll(ctx);
				return;
			}
			if (a === "stats") {
				showStats();
				return;
			}
			// `/agents auto [on|off]` — toggle proactive auto-delegation of all agents.
			if (a.startsWith("auto")) {
				const rest = a.slice(4).trim().toLowerCase();
				const next = rest === "on" ? true : rest === "off" ? false : !state.getAdvertiseAll();
				state.setAdvertiseAll(next);
				ctx.ui.notify(`Auto-delegation ${next ? "ON — all agents offered to the model each turn" : "OFF — only toggled-active agents"}.`, "info");
				return;
			}
			await openDashboard(ctx, {
				state, armed, registry, deps, km,
				runStats: () => new Map(aggregateRunStats(readRunLog(runLogPath)).map((s) => [s.agent, s])),
			});
			// Pick up any agent created via the wizard so its /<name> command exists immediately.
			registerAgentCommands(ctx);
		},
	});

	pi.registerCommand("stop-agents", {
		description: "Kill all running subagents (same as /agents -k)",
		handler: async (_args, ctx) => {
			holder.ctx = ctx;
			killAll(ctx);
		},
	});

	pi.registerCommand("_spawntest", {
		description: "Functional test for agent spawn: creates temp agents, runs a spawn sequence, shows output/cost, cleans up.",
		handler: async (_args, ctx) => {
			holder.ctx = ctx;
			const dir = path.join(getAgentDir(), "agents");
			const suffix = Date.now();
			let scoutFile = "";
			let spawnerFile = "";

			const log = (msg: string) => {
				try { ctx.ui.notify(msg, "info"); } catch { console.log(msg); }
			};
			const errLog = (msg: string) => {
				try { ctx.ui.notify(msg, "error"); } catch { console.error(msg); }
			};

			try {
				// 1. Create temp agent files (with unique suffix to avoid concurrent-run races)
				const scoutBasic: WritableAgent = {
					name: `_spawntest-scout-${suffix}`,
					description: "Test scout",
					tools: ["read", "grep", "find"],
					readonly: true,
					color: "cyan",
					conventions: false,
					spawn: [],
					systemPrompt: "You are a test scout. Use read, grep, and find to answer questions about the codebase quickly.",
				};
				scoutFile = writeAgentFile(scoutBasic, dir);

				const spawner: WritableAgent = {
					name: `_spawntest-spawner-${suffix}`,
					description: "Tests spawning",
					tools: ["read", "grep", "find"],
					readonly: false,
					color: "purple",
					conventions: false,
					spawn: [scoutBasic.name],
					systemPrompt: `You are a spawner test agent. When given a task, delegate to ${scoutBasic.name} via the subagent tool and report its findings.`,
				};
				spawnerFile = writeAgentFile(spawner, dir);

				// 2. Discover the new agents
				const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
				const spawnerAgent = agents.find(a => a.name === spawner.name);
				if (!spawnerAgent) {
					errLog(`${spawner.name} agent not found after creation`);
					return;
				}

				// 3. Run the functional test
				log("Running spawn test…");
				const result = await dispatchSingle(deps, spawnerAgent,
					`Use the ${scoutBasic.name} subagent to check if README.md exists in the current directory. Report what ${scoutBasic.name} finds.`
				);

				// 4. Show output — use console.log since we're in a test context
				const text = result.ok ? result.finalText : result.error ?? result.finalText;
				console.log(`
═══ Spawn test output ═══`);
				console.log(`Agent: ${spawner.name}`);
				console.log(`Status: ${result.ok ? "✓ passed" : "✗ failed"}`);
				console.log(`Cost: $${result.usage.cost.toFixed(4)} (↑${result.usage.input} ↓${result.usage.output})`);
				console.log(`Output:
${text || "(no output)"}`);
				console.log(`═══════════════════════\n`);

				log(`Spawn test ${result.ok ? "passed" : "failed"} — cost: ${result.usage.cost.toFixed(4)}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errLog(`Spawn test error: ${msg}`);
				console.error(`SPAWN TEST ERROR: ${msg}`);
			} finally {
				// 5. Clean up temp agent files on every path
				try { deleteAgentFile(scoutFile); } catch { /* best-effort */ }
				try { deleteAgentFile(spawnerFile); } catch { /* best-effort */ }
			}
		},
	});

	function registerAgentCommands(ctx: ExtensionContext) {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		for (const a of agents) {
			if (registered.has(a.name)) continue;
			registered.add(a.name);
			try {
				pi.registerCommand(a.name, {
					description: `Delegate to ${a.name}: ${a.description.slice(0, 60)}`,
					handler: async (args, c) => {
						holder.ctx = c;
						const task = args.trim() || (await c.ui.input(`Task for ${a.name}`, "Describe the task…")) || "";
						if (!task) return;
						// Live working line so you can see the agent is running (elapsed ticks every 1s).
						const startedAt = Date.now();
						let stats = { tools: 0, cost: 0 };
						const tick = () => c.ui.setWorkingMessage(progressLabel(a.name, Date.now() - startedAt, stats.tools, stats.cost));
						tick();
						const ticker = setInterval(tick, 1000);
						(ticker as any).unref?.();
						try {
							const result = await dispatchSingle(deps, a, task, (p) => { stats = p; tick(); });
							showOutput(a.name, result, task, Date.now() - startedAt);
						} finally {
							clearInterval(ticker);
							c.ui.setWorkingMessage();
						}
					},
				});
			} catch {
				/* duplicate across reloads */
			}
		}
	}

	// Show cumulative subagent cost as a footer segment next to pi's own $ figure.
	// (pi's built-in $ tracks only the main session; there's no API to add into it,
	// so we surface subagent spend as its own status-bar segment.)
	let costStatusWired = false;
	const updateCostStatus = () => {
		const ui = holder.ctx?.ui;
		if (!ui?.setStatus) return;
		const total = registry.totalCost();
		ui.setStatus("subagent-cost", total > 0 ? `⊕ $${total.toFixed(4)} subagents` : undefined);
	};

	// An armed sequence silently consumes the NEXT typed message — without a visible
	// indicator that's a trap. Show it in the footer until it fires or is cleared.
	const updateSequenceStatus = () => {
		const ui = holder.ctx?.ui;
		if (!ui?.setStatus) return;
		const names = armed.get();
		ui.setStatus("subagent-sequence", names.length ? `⛓ next message runs: ${names.join(" → ")}` : undefined);
	};

	pi.on("session_start", (_e, ctx) => {
		holder.ctx = ctx;
		if (!ctx.hasUI) return;
		// No status-bar widget: live progress lives in the tool result and the /name working line.
		// The footer carries a cumulative subagent-cost segment, refreshed on every run change.
		if (!costStatusWired) {
			costStatusWired = true;
			registry.onChange(updateCostStatus);
			armed.onChange(updateSequenceStatus);
		}
		updateCostStatus();
		updateSequenceStatus();
		registerAgentCommands(ctx);
	});
}
