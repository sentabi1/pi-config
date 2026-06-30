/**
 * Session Summary Extension — Animated Rainbow Edition 🌈
 *
 * Displays a smart session summary as a widget below the editor.
 * The summary is set manually via the /topic command,
 * and persists across /reload via custom session entries.
 *
 * Shows "Session in progress" if no summary has been set yet.
 * Toggle with /session-summary (on by default at startup).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Rainbow helpers ───────────────────────────────────────────────────

/**
 * Convert HSL to ANSI truecolor foreground code.
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

// ── Clock-derived hue ─────────────────────────────────────────────────
// NOTE: pi renders inline (no alternate screen). A self-driven animation
// timer that calls tui.requestRender() forces a repaint every tick, and
// every repaint drags the terminal viewport back to the bottom — which
// breaks scrollback. So instead of a timer, we derive the hue from the
// wall clock and recompute it on every *natural* repaint (typing, etc.),
// never forcing our own. ~0.03°/ms ≈ the old animation speed.
function currentHue(): number {
	return (Date.now() * 0.03) % 360;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let summaryText = "Session in progress";
	let tuiRef: { requestRender: () => void } | null = null;
	let widgetInvalidate: (() => void) | null = null;

	// ── Load latest stored summary from session ──────────────────────

	function loadSummary(ctx: {
		sessionManager: {
			getEntries: () => Array<{
				type: string;
				customType?: string;
				data?: { text?: string };
			}>;
		};
	}) {
		const entries = ctx.sessionManager.getEntries();
		// Walk backwards to find the latest session-summary custom entry
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === "session-summary" && e.data?.text) {
				summaryText = e.data.text;
				return;
			}
		}
		summaryText = "Session in progress";
	}

	// ── Widget setup ────────────────────────────────────────────────

	function setupWidget(ctx: any) {
		const widgetId = "session-summary";

		loadSummary(ctx);

		ctx.ui.setWidget(
			widgetId,
			(_tui, theme) => {
				tuiRef = _tui;

				// Cache the rendered line. Output MUST be stable across renders:
				// pi repaints many times per second while the agent streams, and a
				// widget whose output changes every frame resets the terminal's
				// scroll position. We only recompute when the summary text changes
				// (via /topic, which calls widgetInvalidate). The gradient is fixed.
				let cached: string | undefined;
				widgetInvalidate = () => {
					cached = undefined;
				};
				return {
					render: () => {
						if (cached !== undefined) return [cached];
						const hueOffset = currentHue();
						// Build rainbow-colored line: ⌘ <summaryText>
						// Span ~300° of hue across all visible characters
						const chars = "⌘ " + summaryText;
						const totalVisible = chars.split("").filter((c) => c !== " ").length;
						let out = BOLD;
						let charIndex = 0;
						for (const ch of chars) {
							if (ch === " ") {
								out += ch;
							} else {
								const hue = (charIndex / totalVisible) * 300 + hueOffset;
								out += hslAnsi(hue) + ch + COLOR_RESET;
								charIndex++;
							}
						}
						out += "\x1b[0m";
						cached = out;
						return [cached];
					},
					invalidate: () => {
						cached = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);

		if (summaryText !== "Session in progress") {
			ctx.ui.notify("Session summary loaded", "info");
		}
	}

	function teardownWidget(ctx: any) {
		tuiRef = null;
		ctx.ui.setWidget("session-summary", undefined);
	}

	// ── Toggle command ──────────────────────────────────────────────

	pi.registerCommand("session-summary", {
		description: "Toggle session summary widget",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				setupWidget(ctx);
			} else {
				teardownWidget(ctx);
			}
		},
	});

	// ── Manual topic command ─────────────────────────────────────────

	pi.registerCommand("topic", {
		description: "Set the session topic/summary text manually. Usage: /topic <text>",
		handler: async (args, ctx) => {
			if (!args || !args.trim()) {
				ctx.ui.notify("Usage: /topic <text>", "error");
				return;
			}
			summaryText = args.trim();
			ctx.sessionManager.appendCustomEntry("session-summary", {
				text: summaryText,
			});
			// Invalidate the cached line so the new text is rebuilt, then one
			// single repaint. A one-shot render is fine — it's continuous
			// per-frame changes that break scrollback.
			widgetInvalidate?.();
			tuiRef?.requestRender();
			ctx.ui.notify("Topic set", "info");
		},
	});

	// ── Auto-enable and restore on session start ────────────────────

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Load any existing summary from the session
		loadSummary(ctx);

		if (!enabled) {
			enabled = true;
			setupWidget(ctx);
		}
	});
}
