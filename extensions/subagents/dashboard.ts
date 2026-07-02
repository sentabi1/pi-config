import { spawn } from "node:child_process";
import * as os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { deleteAgentFile } from "./agent-writer.ts";
import { colorDot } from "./colors.ts";
import { openEditor } from "./dashboard-edit.ts";
import { newAgentWizard } from "./wizard.ts";
import { pickGroupMembers } from "./pickers.ts";
import { showKeybindSettings } from "./settings.ts";
import type { Keymap } from "./keymap.ts";
import type { ArmedChain } from "./chain-arm.ts";
import type { RunRegistry } from "./registry.ts";
import type { AgentGroup, SubagentState } from "./state.ts";
import type { DispatchDeps } from "./tool.ts";
import type { AgentRunStats } from "./runlog.ts";

const CIRCLED = "①②③④⑤⑥⑦⑧⑨";
const UNGROUPED = -1;

/** Open a file in the OS default application. */
function openInOS(filePath: string): void {
	const plat = os.platform();
	const cmd = plat === "darwin" ? "open" : plat === "win32" ? "cmd" : "xdg-open";
	const args = plat === "win32" ? ["/c", "start", "", filePath] : [filePath];
	try {
		spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		/* ignore */
	}
}

type Row = { kind: "group"; gi: number } | { kind: "agent"; name: string; gi: number };

type DashExit =
	| { kind: "confirm" }
	| { kind: "cancel" }
	| { kind: "editAgent"; agent: AgentConfig }
	| { kind: "editGroup"; group: AgentGroup }
	| { kind: "newAgent" }
	| { kind: "newGroup" }
	| { kind: "deleteAgent"; agent: AgentConfig }
	| { kind: "deleteGroup"; groupName: string }
	| { kind: "settings" };

export interface DashboardEnv {
	state: SubagentState;
	armed: ArmedChain;
	registry: RunRegistry;
	deps: DispatchDeps;
	km: Keymap;
	/** All-sessions run history per agent (from runs.jsonl), for the per-row cost suffix. */
	runStats?: () => Map<string, AgentRunStats>;
}

interface DashResult {
	exit: DashExit;
	chain: string[];
	active: string[];
}

function showDashboard(ctx: ExtensionContext, env: DashboardEnv, agents: AgentConfig[], chain0: string[], active0: string[]): Promise<DashResult> {
	const { km } = env;
	return ctx.ui.custom<DashResult>((tui: any, theme: any, _kb: any, done: (r: DashResult) => void) => {
		const byName = new Map(agents.map((a) => [a.name, a]));
		const runStats = env.runStats?.() ?? new Map<string, AgentRunStats>();
		const groups = typeof (env.state as any).getGroups === "function" ? env.state.getGroups() : [];
		const chain = [...chain0].filter((n) => byName.has(n));
		const localActive = new Set(active0.filter((n) => byName.has(n)));

		// Build the flat focus-row list (groups + members + Ungrouped bucket).
		const rows: Row[] = [];
		const grouped = new Set<string>();
		groups.forEach((g, gi) => {
			rows.push({ kind: "group", gi });
			for (const m of g.members) if (byName.has(m)) {
				rows.push({ kind: "agent", name: m, gi });
				grouped.add(m);
			}
		});
		const ungrouped = agents.filter((a) => !grouped.has(a.name));
		rows.push({ kind: "group", gi: UNGROUPED });
		for (const a of ungrouped) rows.push({ kind: "agent", name: a.name, gi: UNGROUPED });

		let index = rows.findIndex((r) => r.kind === "agent");
		if (index < 0) index = 0;
		let confirm: "save" | "cancel" | null = null;
		let cached: string[] | undefined;
		const off = env.registry.onChange(() => {
			cached = undefined;
			tui.requestRender();
		});
		const spin = setInterval(() => {
			if (env.registry.hasActive()) {
				cached = undefined;
				tui.requestRender();
			}
		}, 200);
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		const cleanup = () => {
			off();
			clearInterval(spin);
		};
		const finish = (exit: DashExit) => {
			cleanup();
			done({ exit, chain, active: [...localActive] });
		};

		const groupMembers = (gi: number): string[] =>
			gi === UNGROUPED ? ungrouped.map((a) => a.name) : groups[gi].members.filter((m) => byName.has(m));

		function handleInput(data: string) {
			if (km.matches("confirm", data)) {
				if (confirm === "save") return finish({ kind: "confirm" });
				confirm = "save";
				return refresh();
			}
			if (km.matches("cancel", data)) {
				if (confirm === "cancel") return finish({ kind: "cancel" });
				confirm = "cancel";
				return refresh();
			}
			if (confirm) confirm = null;

			const row = rows[index];
			if (km.matches("up", data)) {
				index = Math.max(0, index - 1);
				refresh();
			} else if (km.matches("down", data)) {
				index = Math.min(rows.length - 1, index + 1);
				refresh();
			} else if (km.matches("settings", data)) {
				finish({ kind: "settings" });
			} else if (km.matches("newGroup", data)) {
				finish({ kind: "newGroup" });
			} else if (km.matches("new", data)) {
				finish({ kind: "newAgent" });
			} else if (km.matches("toggle", data)) {
				if (row.kind === "group") {
					const mems = groupMembers(row.gi);
					const allOn = mems.length > 0 && mems.every((m) => localActive.has(m));
					for (const m of mems) {
						if (allOn) localActive.delete(m);
						else localActive.add(m);
					}
				} else {
					if (localActive.has(row.name)) localActive.delete(row.name);
					else localActive.add(row.name);
				}
				refresh();
			} else if (km.matches("sequence", data)) {
				if (row.kind === "agent") {
					const at = chain.indexOf(row.name);
					if (at >= 0) chain.splice(at, 1);
					else chain.push(row.name);
					refresh();
				}
			} else if (km.matches("edit", data)) {
				if (row.kind === "group") {
					if (row.gi !== UNGROUPED) finish({ kind: "editGroup", group: groups[row.gi] });
				} else {
					const a = byName.get(row.name);
					if (a) finish({ kind: "editAgent", agent: a });
				}
			} else if (km.matches("delete", data)) {
				if (row.kind === "group") {
					if (row.gi !== UNGROUPED) finish({ kind: "deleteGroup", groupName: groups[row.gi].name });
				} else {
					const a = byName.get(row.name);
					if (a) finish({ kind: "deleteAgent", agent: a });
				}
			} else if (km.matches("open", data)) {
				if (row.kind === "agent") {
					const a = byName.get(row.name);
					if (a?.filePath) {
						openInOS(a.filePath);
						ctx.ui.notify(`Opening ${a.filePath}`, "info");
					}
				}
				refresh();
			} else {
				refresh();
			}
		}

		function build(width: number): string[] {
			const bc = confirm === "save" ? "success" : confirm === "cancel" ? "error" : "accent";
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg(bc, "─".repeat(width)));
			if (confirm === "save") add(theme.fg("success", theme.bold(" ✓ Saved!")) + theme.fg("dim", `   ${km.label("confirm")} again to confirm · any key to stay`));
			else if (confirm === "cancel") add(theme.fg("error", theme.bold(" ✗ Canceled!")) + theme.fg("dim", `   ${km.label("cancel")} again to discard changes · any key to stay`));
			else {
				const auto = env.state.getAdvertiseAll();
				add(
					theme.fg("text", " AGENTS") +
						theme.fg("dim", auto ? "   auto-delegation ON — every agent is advertised; [x] toggles apply when auto is off" : "   auto-delegation OFF — only hard triggers and [x]-active agents are advertised"),
				);
			}
			// grouped hints
			const H: Array<[string, string]> = [
				[`${km.label("up")}${km.label("down")}`, "move"],
				[km.label("toggle"), "toggle"],
				[km.label("sequence"), "sequence"],
				[km.label("edit"), "edit"],
				[km.label("open"), "open .md"],
				[km.label("new"), "new agent"],
				[km.label("newGroup"), "new group"],
				[km.label("delete"), "delete"],
				[km.label("settings"), "settings"],
				[km.label("confirm"), "confirm"],
				[km.label("cancel"), "cancel"],
			];
			for (const [k, act] of H) add(`   ${theme.fg("accent", k.padEnd(6))} ${theme.fg("dim", act)}`);
			lines.push("");

			for (let r = 0; r < rows.length; r++) {
				const row = rows[r];
				const foc = r === index;
				const mark = foc ? theme.fg("accent", "> ") : "  ";
				if (row.kind === "group") {
					const name = row.gi === UNGROUPED ? "Ungrouped" : groups[row.gi].name;
					const mems = groupMembers(row.gi);
					const onCount = mems.filter((m) => localActive.has(m)).length;
					const box = mems.length === 0 ? theme.fg("dim", "[ ]") : onCount === mems.length ? theme.fg("success", "[x]") : onCount > 0 ? theme.fg("warning", "[~]") : theme.fg("dim", "[ ]");
					const label = foc ? theme.fg("accent", theme.bold(name)) : theme.fg("text", theme.bold(name));
					add(`${mark}${box} ${label} ${theme.fg("dim", `(${mems.length})`)}`);
				} else {
					const a = byName.get(row.name)!;
					const on = localActive.has(a.name);
					const order = chain.indexOf(a.name);
					const numTag = order >= 0 ? theme.fg("accent", CIRCLED[order] ?? `(${order + 1})`) : " ";
					const toggle = on ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
					const tools = a.readonly ? theme.fg("muted", "read-only") : theme.fg("muted", a.tools?.join(",") ?? "default");
					const nm = foc ? theme.fg("accent", a.name) : theme.fg("text", a.name);
					const model = a.model ?? (a.tier ? `tier:${a.tier}` : "inherit");
					// Effective routing state, not just the frontmatter tier: with auto off,
					// a judgment/never agent that isn't toggled active is not advertised at all.
					const advertised = env.state.getAdvertiseAll() || a.advertise === "always" || on;
					const routing = advertised ? theme.fg("dim", a.advertise) : theme.fg("warning", "not advertised");
					// All-sessions cost history — the tuning signal, shown where activation decisions happen.
					const st = runStats.get(a.name);
					const hist = st ? `  ${theme.fg("dim", `${st.runs}r $${st.totalCost.toFixed(2)}`)}` : "";
					add(`${mark}  ${toggle} ${colorDot(a.color)} ${nm}  ${theme.fg("dim", model)}  ${routing}  ${tools}${hist}  ${numTag}`);
					if (foc) for (const w of wrapTextWithAnsi(theme.fg("muted", a.description), Math.max(1, width - 8))) add(`        ${w}`);
				}
			}

			if (chain.length) {
				lines.push("");
				add(theme.fg("accent", ` Sequence: ${chain.join(" → ")}`) + theme.fg("muted", ` — confirm (${km.label("confirm")}${km.label("confirm")}), then your next message runs through it`));
			}
			add(theme.fg(bc, "─".repeat(width)));
			return lines;
		}

		return {
			render: (w: number) => (cached ??= build(w)),
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
			dispose: () => cleanup(),
		};
	});
}

export async function openDashboard(ctx: ExtensionContext, env: DashboardEnv): Promise<void> {
	let chain = env.armed.get();
	let active = env.state.activeNames();
	while (true) {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: (ctx as any).isProjectTrusted?.() ?? false });
		const agentList = agents.map((a) => ({ name: a.name, color: a.color }));
		const r = await showDashboard(ctx, env, agents, chain, active);
		chain = r.chain;
		active = r.active;
		const exit = r.exit;

		if (exit.kind === "confirm") {
			const names = new Set([...env.state.activeNames(), ...agents.map((a) => a.name), ...active]);
			for (const n of names) env.state.setActive(n, active.includes(n));
			env.armed.set(chain);
			return;
		}
		if (exit.kind === "cancel") {
			env.armed.clear();
			return;
		}
		if (exit.kind === "editAgent") {
			await openEditor(ctx, exit.agent, env.state);
		} else if (exit.kind === "newAgent") {
			await newAgentWizard(ctx);
		} else if (exit.kind === "settings") {
			await showKeybindSettings(ctx, env.km, env.state);
		} else if (exit.kind === "newGroup") {
			const name = (await ctx.ui.input("New group — name", "e.g. frontend"))?.trim();
			if (name) {
				const members = await pickGroupMembers(ctx, `Members of "${name}"`, agentList, []);
				env.state.addGroup(name, members ?? []);
				ctx.ui.notify(`Created group "${name}" (${(members ?? []).length} members).`, "info");
			}
		} else if (exit.kind === "editGroup") {
			const newName = await ctx.ui.input(`Rename group "${exit.group.name}" (blank = keep)`, exit.group.name);
			if (newName !== undefined && newName.trim() && newName.trim() !== exit.group.name) {
				env.state.renameGroup(exit.group.name, newName.trim());
			}
			const finalName = newName?.trim() || exit.group.name;
			const members = await pickGroupMembers(ctx, `Members of "${finalName}"`, agentList, exit.group.members);
			if (members !== undefined) {
				env.state.setGroupMembers(finalName, members);
				ctx.ui.notify(`Saved group "${finalName}" (${members.length} members).`, "info");
			}
		} else if (exit.kind === "deleteGroup") {
			const ok = await ctx.ui.confirm("Delete group", `Delete group "${exit.groupName}"? (the agents themselves are kept)`);
			if (ok) {
				env.state.deleteGroup(exit.groupName);
				ctx.ui.notify(`Deleted group "${exit.groupName}".`, "info");
			}
		} else if (exit.kind === "deleteAgent") {
			const ok = await ctx.ui.confirm("Delete agent", `Are you sure you want to delete this agent?\nThis also removes the file at ${exit.agent.filePath}`);
			if (ok) {
				deleteAgentFile(exit.agent.filePath);
				active = active.filter((n) => n !== exit.agent.name);
				env.state.setActive(exit.agent.name, false);
				ctx.ui.notify(`Deleted ${exit.agent.name}.`, "info");
			}
		}
	}
}
