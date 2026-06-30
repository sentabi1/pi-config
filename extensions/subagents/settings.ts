import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { ACTIONS, DEFAULT_KEYS, keyLabel, type Keymap } from "./keymap.ts";
import type { SubagentState } from "./state.ts";

/** Keybind settings overlay. Navigation here is FIXED (↑↓ / enter / esc / r) and
 * NOT remappable, so a bad rebind can never lock you out. */
export function showKeybindSettings(ctx: ExtensionContext, km: Keymap, state: SubagentState): Promise<void> {
	return ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: (r: void) => void) => {
		let i = 0;
		let capturing = false;
		let cached: string[] | undefined;
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (capturing) {
				if (matchesKey(data, Key.escape)) {
					capturing = false;
					refresh();
					return;
				}
				const ok = km.rebind(ACTIONS[i].action, data);
				if (!ok) ctx.ui.notify("Unsupported key — try another.", "warning");
				capturing = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				i = Math.max(0, i - 1);
				refresh();
			} else if (matchesKey(data, Key.down)) {
				i = Math.min(ACTIONS.length - 1, i + 1);
				refresh();
			} else if (matchesKey(data, Key.enter)) {
				capturing = true;
				refresh();
			} else if (data === "r") {
				state.resetKeybinds();
				refresh();
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Keybind settings") + theme.fg("dim", "   ↑↓ move · ⏎ rebind · r reset all · esc close"));
			add(theme.fg("dim", " (these nav keys are fixed so you can't lock yourself out)"));
			lines.push("");
			for (let j = 0; j < ACTIONS.length; j++) {
				const a = ACTIONS[j];
				const foc = j === i;
				const cur = km.label(a.action);
				const isDefault = (state.getKeybinds()[a.action] ?? DEFAULT_KEYS[a.action]) === DEFAULT_KEYS[a.action];
				const keyCol = foc && capturing ? theme.fg("warning", "press a key…") : theme.fg("accent", cur);
				const def = isDefault ? "" : theme.fg("dim", `  (default ${keyLabel(DEFAULT_KEYS[a.action])})`);
				add(`${foc ? theme.fg("accent", " > ") : "   "}${theme.fg(foc ? "accent" : "text", a.label.padEnd(20))} ${keyCol}${def}`);
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
