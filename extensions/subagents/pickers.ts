import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { COLOR_HEX, colorize } from "./colors.ts";

/** The tools a subagent can be granted. read/grep/find/ls are read-only. */
export const ALL_TOOLS: Array<{ name: string; note: string }> = [
	{ name: "read", note: "read files (read-only)" },
	{ name: "grep", note: "search file contents (read-only)" },
	{ name: "find", note: "find files by name (read-only)" },
	{ name: "ls", note: "list directories (read-only)" },
	{ name: "bash", note: "run shell commands" },
	{ name: "edit", note: "edit existing files" },
	{ name: "write", note: "create/overwrite files" },
];

/** Tool checklist. Returns the selected tool names, or undefined if cancelled.
 * An empty selection means "inherit pi defaults" (read, bash, edit, write). */
export function pickTools(ctx: ExtensionContext, current: string[]): Promise<string[] | undefined> {
	return ctx.ui.custom<string[] | undefined>((tui: any, theme: any, _kb: any, done: (r: string[] | undefined) => void) => {
		let i = 0;
		let cached: string[] | undefined;
		const sel = new Set(current);
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) {
				i = (i - 1 + ALL_TOOLS.length) % ALL_TOOLS.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				i = (i + 1) % ALL_TOOLS.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				const n = ALL_TOOLS[i].name;
				if (sel.has(n)) sel.delete(n);
				else sel.add(n);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(ALL_TOOLS.filter((t) => sel.has(t.name)).map((t) => t.name));
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Tools") + theme.fg("dim", "   ↑↓ move   space toggle   ⏎ save   esc cancel"));
			add(theme.fg("dim", " (none selected = pi default: read, bash, edit, write)"));
			lines.push("");
			for (let j = 0; j < ALL_TOOLS.length; j++) {
				const t = ALL_TOOLS[j];
				const foc = j === i;
				const box = sel.has(t.name) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const name = foc ? theme.fg("accent", t.name.padEnd(7)) : theme.fg("text", t.name.padEnd(7));
				add(`${foc ? theme.fg("accent", " > ") : "   "}${box} ${name} ${theme.fg("muted", t.note)}`);
			}
			add(theme.fg("accent", "─".repeat(width)));
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

/** Agent checklist for group membership. Returns selected agent names, or
 * undefined if cancelled. */
export function pickGroupMembers(
	ctx: ExtensionContext,
	title: string,
	agents: Array<{ name: string; color: string }>,
	current: string[],
): Promise<string[] | undefined> {
	return ctx.ui.custom<string[] | undefined>((tui: any, theme: any, _kb: any, done: (r: string[] | undefined) => void) => {
		let i = 0;
		let cached: string[] | undefined;
		const sel = new Set(current);
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (agents.length === 0) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done(undefined);
				return;
			}
			if (matchesKey(data, Key.up)) {
				i = (i - 1 + agents.length) % agents.length;
				refresh();
			} else if (matchesKey(data, Key.down)) {
				i = (i + 1) % agents.length;
				refresh();
			} else if (matchesKey(data, Key.space)) {
				const n = agents[i].name;
				if (sel.has(n)) sel.delete(n);
				else sel.add(n);
				refresh();
			} else if (matchesKey(data, Key.enter)) {
				done(agents.filter((a) => sel.has(a.name)).map((a) => a.name));
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", ` ${title}`) + theme.fg("dim", "   ↑↓ move   space toggle   ⏎ save   esc cancel"));
			lines.push("");
			if (agents.length === 0) add(theme.fg("muted", " No agents to add."));
			for (let j = 0; j < agents.length; j++) {
				const a = agents[j];
				const foc = j === i;
				const box = sel.has(a.name) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				add(`${foc ? theme.fg("accent", " > ") : "   "}${box} ${colorize(a.color, "●")} ${theme.fg(foc ? "accent" : "text", a.name)}`);
			}
			add(theme.fg("accent", "─".repeat(width)));
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

/** Standalone swatch color picker overlay. Returns the chosen color name, or
 * undefined if cancelled. */
export function pickColor(ctx: ExtensionContext, current: string): Promise<string | undefined> {
	const colors = Object.keys(COLOR_HEX);
	return ctx.ui.custom<string | undefined>((tui: any, theme: any, _kb: any, done: (r: string | undefined) => void) => {
		let i = Math.max(0, colors.indexOf(current));
		let cached: string[] | undefined;
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
				i = (i - 1 + colors.length) % colors.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
				i = (i + 1) % colors.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(colors[i]);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Pick a color") + theme.fg("muted", "   ←→ move   ⏎ choose   esc cancel"));
			lines.push("");
			const swatches = colors.map((c, j) => (j === i ? `[${colorize(c, "●")}]` : ` ${colorize(c, "●")} `)).join("");
			add(` ${swatches}`);
			add(`   ${theme.fg("accent", colorize(colors[i], "●"))} ${theme.fg("text", colors[i])}`);
			add(theme.fg("accent", "─".repeat(width)));
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
