/**
 * Custom Header Extension — Animated Rainbow Edition 🌈
 *
 * Replaces the built-in startup header with a smoothly animating
 * rainbow gradient across every character of the pi ASCII art.
 *
 * Run `/reload` or restart pi to see it.
 * To restore the built-in header: run `/builtin-header` in pi.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { VERSION, keyHint, rawKeyHint } from "@mariozechner/pi-coding-agent";

// ── Rainbow helpers ───────────────────────────────────────────────────

/**
 * Convert HSL to ANSI truecolor foreground code.
 * We only reset the foreground color (`\x1b[39m`) so that bold
 * (`\x1b[1m`) set at the start of the line stays active — no
 * need to re-apply per character.
 */
function hslAnsi(hue: number, sat = 0.85, light = 0.55): string {
	hue = ((hue % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * light - 1)) * sat;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = light - c / 2;
	let r1 = 0, g1 = 0, b1 = 0;
	if (hue < 60) { r1 = c; g1 = x; }
	else if (hue < 120) { r1 = x; g1 = c; }
	else if (hue < 180) { g1 = c; b1 = x; }
	else if (hue < 240) { g1 = x; b1 = c; }
	else if (hue < 300) { r1 = x; b1 = c; }
	else { r1 = c; b1 = x; }
	return `\x1b[38;2;${Math.round((r1 + m) * 255)};${Math.round((g1 + m) * 255)};${Math.round((b1 + m) * 255)}m`;
}

const COLOR_RESET = "\x1b[39m"; // reset foreground only (keeps bold)
const BOLD = "\x1b[1m";

// ── ASCII art geometry ────────────────────────────────────────────────

const LOGO_LINES = [
	"   ███████████████████████████╗  ",
	"   ╚══██████╔════════██████╔══╝  ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"      ██████║        ██████║     ",
	"   ████████████╗  ████████████╗  ",
	"   ╚═══════════╝  ╚═══════════╝  ",
];

/** Total visible (non-space) characters across all lines. */
const TOTAL_VISIBLE = LOGO_LINES.reduce(
	(sum, l) => sum + l.split("").filter((c) => c !== " ").length, 0,
);

// ── Clock-derived hue ─────────────────────────────────────────────────
// NOTE: pi renders inline (no alternate screen). A self-driven animation
// timer that calls tui.requestRender() forces a repaint every tick, and
// every repaint drags the terminal viewport back to the bottom — which
// breaks scrollback. So instead of a timer, we derive the hue from the
// wall clock: the gradient still shifts whenever the screen *naturally*
// repaints, but we never force our own repaints. ~0.03°/ms ≈ the old speed.
function currentHue(): number {
	return (Date.now() * 0.03) % 360;
}

// ── Build header ─────────────────────────────────────────────────────

/**
 * Render the pi logo with a per-character rainbow gradient.
 * Each visible character gets a hue determined by its position in
 * the full logo + a time-based offset, creating a smooth diagonal
 * rainbow that flows over time.
 *
 * We emit `\x1b[1m` once at the very start (bold) and only reset
 * the foreground color between characters (`\x1b[39m`), so bold
 * persists across the entire block without redundant codes.
 */
function buildHeader(): string {
	const lines: string[] = [];
	const hueOffset = currentHue();

	// ── Rainbow ASCII art ──
	// Scan through all lines. Each visible (non-space) character gets
	// its hue based on its global index / TOTAL_VISIBLE * 300°,
	// plus the animation offset. Spaces are emitted as-is.
	let charIndex = 0;
	for (const rawLine of LOGO_LINES) {
		let out = BOLD; // bold once per line
		for (const ch of rawLine) {
			if (ch === " ") {
				out += ch;
			} else {
				const hue = (charIndex / TOTAL_VISIBLE) * 300 + hueOffset;
				out += hslAnsi(hue) + ch + COLOR_RESET;
				charIndex++;
			}
		}
		out += ANSI_RESET_LINE; // reset all at end of line
		lines.push(out);
	}

	lines.push("");

	// ── "pi v{VERSION}" — also rainbow, same gradient continues ──
	const versionStr = `pi v${VERSION}`;
	let out = BOLD;
	for (let i = 0; i < versionStr.length; i++) {
		const hue = (charIndex / TOTAL_VISIBLE) * 300 + hueOffset;
		out += hslAnsi(hue) + versionStr[i] + COLOR_RESET;
		charIndex++;
	}
	out += ANSI_RESET_LINE;
	lines.push(out);

	// ── Keybinding hints (theme-dim, no rainbow) ──
	const hints = [
		rawKeyHint("escape", "to interrupt"),
		rawKeyHint("ctrl+c", "to clear"),
		rawKeyHint("ctrl+c twice", "to exit"),
		rawKeyHint("ctrl+d", "to exit (empty)"),
		rawKeyHint("ctrl+z", "to suspend"),
		keyHint("deleteToLineEnd", "to delete to end"),
		rawKeyHint("shift+tab", "to cycle thinking level"),
		rawKeyHint("ctrl+p/shift+ctrl+p", "to cycle models"),
		rawKeyHint("ctrl+l", "to select model"),
		rawKeyHint("ctrl+o", "to expand tools"),
		rawKeyHint("ctrl+t", "to expand thinking"),
		rawKeyHint("ctrl+g", "for external editor"),
		rawKeyHint("/", "for commands"),
		rawKeyHint("!", "to run bash"),
		rawKeyHint("!!", "to run bash (no context)"),
		rawKeyHint("alt+enter", "to queue follow-up"),
		rawKeyHint("alt+up", "to edit all queued messages"),
		rawKeyHint(process.platform === "win32" ? "alt+v" : "ctrl+v", "to paste image"),
		rawKeyHint("drop files", "to attach"),
	];

	return [...lines, ...hints].join("\n");
}

// Used at end of each line — resets everything so the next
// line starts clean.
const ANSI_RESET_LINE = "\x1b[0m";

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((_tui, _theme) => {
			// Compute the gradient ONCE and cache it. The output must be stable
			// across renders: pi repaints many times per second while streaming,
			// and a widget whose output changes every frame resets the terminal's
			// scroll position. A fixed (non-animated) gradient keeps the color
			// while preserving scrollback.
			let cached: string[] | undefined;
			return {
				render(_width: number): string[] {
					return (cached ??= buildHeader().split("\n"));
				},
				invalidate() {
					cached = undefined;
				},
			};
		});
	});

	// Command to restore the built-in header
	pi.registerCommand("builtin-header", {
		description: "Restore the built-in startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
