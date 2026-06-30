import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import { deleteAgentFile, serializeAgent, writeAgentFile } from "./agent-writer.ts";
import { COLOR_HEX, colorize } from "./colors.ts";
import { pickTools } from "./pickers.ts";
import type { SubagentState } from "./state.ts";

const THINKING = ["", "minimal", "low", "medium", "high", "xhigh"];
const FIELDS = ["name", "model", "thinking", "readonly", "color", "tools", "description", "systemPrompt"] as const;
type FieldKey = (typeof FIELDS)[number];

interface Draft {
	name: string;
	model: string;
	thinking: string;
	readonly: boolean;
	color: string;
	tools: string;
	description: string;
	systemPrompt: string;
}

type EditorExit =
	| { action: "save"; draft: Draft }
	| { action: "cancel" }
	| { action: "editText"; field: "name" | "tools" | "description" | "systemPrompt"; draft: Draft; focus: number };

function showEditorOverlay(ctx: ExtensionContext, agentName: string, draft: Draft, models: string[], startFocus: number): Promise<EditorExit> {
	const colors = Object.keys(COLOR_HEX);
	const LABELS: Record<FieldKey, string> = {
		name: "Name",
		model: "Model",
		thinking: "Thinking",
		readonly: "Read-only",
		color: "Color",
		tools: "Tools",
		description: "Description",
		systemPrompt: "System prompt",
	};

	return ctx.ui.custom<EditorExit>((tui: any, theme: any, _kb: any, done: (r: EditorExit) => void) => {
		let focus = Math.max(0, Math.min(startFocus, FIELDS.length - 1));
		let confirm: "save" | "cancel" | null = null;
		let cached: string[] | undefined;
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		function edit(field: FieldKey, dir: number) {
			if (field === "model") {
				const opts = ["", ...models];
				const i = opts.indexOf(draft.model);
				draft.model = opts[(i + dir + opts.length) % opts.length];
			} else if (field === "thinking") {
				const i = THINKING.indexOf(draft.thinking);
				draft.thinking = THINKING[(i + dir + THINKING.length) % THINKING.length];
			} else if (field === "color") {
				const i = colors.indexOf(draft.color);
				draft.color = colors[(i + dir + colors.length) % colors.length];
			} else if (field === "readonly") {
				draft.readonly = !draft.readonly;
			} else {
				// text fields: name / tools / description / systemPrompt
				done({ action: "editText", field, draft, focus });
				return;
			}
			refresh();
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.enter)) {
				if (confirm === "save") return done({ action: "save", draft });
				confirm = "save";
				return refresh();
			}
			if (matchesKey(data, Key.escape)) {
				if (confirm === "cancel") return done({ action: "cancel" });
				confirm = "cancel";
				return refresh();
			}
			if (confirm) confirm = null;
			const field = FIELDS[focus];
			if (matchesKey(data, Key.up)) {
				focus = Math.max(0, focus - 1);
				refresh();
			} else if (matchesKey(data, Key.down)) {
				focus = Math.min(FIELDS.length - 1, focus + 1);
				refresh();
			} else if (matchesKey(data, Key.left)) {
				edit(field, -1);
			} else if (matchesKey(data, Key.right)) {
				edit(field, 1);
			} else {
				refresh();
			}
		}

		function build(width: number): string[] {
			const bc = confirm === "save" ? "success" : confirm === "cancel" ? "error" : "accent";
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg(bc, "─".repeat(width)));
			if (confirm === "save") add(theme.fg("success", theme.bold(" ✓ Saved!")) + theme.fg("dim", "   ⏎ again to confirm · any key to keep editing"));
			else if (confirm === "cancel") add(theme.fg("error", theme.bold(" ✗ Canceled!")) + theme.fg("dim", "   esc again to discard · any key to keep editing"));
			else add(theme.fg("text", " Agent Editor") + theme.fg("muted", `  ·  ${agentName}`));
			add(theme.fg("dim", " ↑↓ field   ←→ edit   ⏎ save   esc cancel"));
			lines.push("");
			for (let i = 0; i < FIELDS.length; i++) {
				const f = FIELDS[i];
				const foc = i === focus;
				// Long text fields render as full sections (shown once, never cut off).
				if (f === "description" || f === "systemPrompt") {
					const body = f === "description" ? draft.description : draft.systemPrompt;
					const maxLines = f === "systemPrompt" ? 14 : 6;
					lines.push("");
					add(`${foc ? theme.fg("accent", "> ") : "  "}${theme.fg(foc ? "accent" : "text", theme.bold(LABELS[f]))} ${theme.fg("dim", "(←→ to edit — multi-line, paste OK)")}`);
					const wrapped = wrapTextWithAnsi(theme.fg(foc ? "text" : "dim", body || "(empty)"), Math.max(1, width - 5));
					for (const w of wrapped.slice(0, maxLines)) add(`    ${w}`);
					if (wrapped.length > maxLines) add(theme.fg("dim", `    … +${wrapped.length - maxLines} more lines`));
					continue;
				}
				let val = "";
				if (f === "name") val = draft.name ? theme.fg("text", draft.name) : theme.fg("warning", "(unnamed)");
				else if (f === "model") val = draft.model || theme.fg("dim", "(inherit parent)");
				else if (f === "thinking") val = draft.thinking || theme.fg("dim", "(inherit)");
				else if (f === "readonly") val = draft.readonly ? theme.fg("success", "yes") : theme.fg("dim", "no");
				else if (f === "color") val = `${colorize(draft.color, "●")} ${draft.color}`;
				else val = draft.tools ? theme.fg("muted", draft.tools) : theme.fg("dim", "(default: read,bash,edit,write)");
				add(`${foc ? theme.fg("accent", "> ") : "  "}${theme.fg(foc ? "accent" : "text", LABELS[f].padEnd(13))} ${val}`);
				if (f === "color" && foc) {
					const swatches = colors.map((c) => (c === draft.color ? `[${colorize(c, "●")}]` : ` ${colorize(c, "●")} `)).join("");
					add(`     ${swatches}`);
				}
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
		};
	});
}

export async function openEditor(ctx: ExtensionContext, agent: AgentConfig, state: SubagentState): Promise<void> {
	const avail = ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll();
	const models = avail.map((m: any) => `${m.provider}/${m.id}`);
	const draft: Draft = {
		name: agent.name,
		model: agent.model ?? "",
		thinking: agent.thinking ?? "",
		readonly: agent.readonly,
		color: agent.color,
		tools: agent.tools?.join(", ") ?? "",
		description: agent.description,
		systemPrompt: agent.systemPrompt,
	};
	let focus = 0;
	while (true) {
		const r = await showEditorOverlay(ctx, agent.name, draft, models, focus);
		if (r.action === "cancel") return;
		if (r.action === "save") {
			const newName = r.draft.name.trim() || agent.name;
			const tools = r.draft.tools.split(",").map((t) => t.trim()).filter(Boolean);
			const updated: AgentConfig = {
				...agent,
				name: newName,
				model: r.draft.model || undefined,
				thinking: r.draft.thinking || undefined,
				readonly: r.draft.readonly,
				color: r.draft.color,
				tools: tools.length ? tools : undefined,
				description: r.draft.description,
				systemPrompt: r.draft.systemPrompt,
			};
			if (newName !== agent.name) {
				const dir = path.dirname(agent.filePath);
				const newPath = writeAgentFile(updated, dir);
				if (newPath !== agent.filePath) deleteAgentFile(agent.filePath);
				state.renameAgentReferences(agent.name, newName);
				ctx.ui.notify(`Renamed ${agent.name} → ${newName}. Run /reload for /${path.basename(newPath, ".md")}.`, "info");
			} else {
				fs.writeFileSync(agent.filePath, serializeAgent(updated), "utf-8");
				ctx.ui.notify(`Saved ${agent.name}`, "info");
			}
			return;
		}
		focus = r.focus;
		if (r.field === "name") {
			const v = await ctx.ui.input("Agent name", draft.name);
			if (v !== undefined && v.trim()) draft.name = v.trim();
		} else if (r.field === "tools") {
			const picked = await pickTools(ctx, draft.tools.split(",").map((t) => t.trim()).filter(Boolean));
			if (picked !== undefined) draft.tools = picked.join(", ");
		} else {
			const v = await ctx.ui.editor(r.field === "description" ? "Description" : "System prompt", draft[r.field]);
			if (v !== undefined) draft[r.field] = v;
		}
	}
}
