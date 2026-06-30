/**
 * Modal Editor - vim-like modal editing for pi's input box
 *
 * Features:
 * - Insert / Normal modes (toggle with Escape)
 * - h/j/k/l navigation
 * - w/b word navigation
 * - 0/$ line start/end
 * - i/a/I/A insert/append at various positions
 * - o/O open new line below/above
 * - x delete character, u undo
 * - Mode indicator in the border
 *
 * Place in ~/.pi/agent/extensions/ for automatic loading.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";

class ModalEditor extends CustomEditor {
	private mode: Mode = "insert";

	handleInput(data: string): void {
		// Escape: toggle to normal mode, or pass through for app handling (abort, etc.)
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
			} else {
				super.handleInput(data);
			}
			return;
		}

		// Insert mode: pass everything through to the underlying editor
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// ── Normal mode ────────────────────────────────────────────
		switch (data) {
			// ── Mode switching ──
			case "i":
				this.mode = "insert";
				return;
			case "a":
				// Append: enter insert mode after moving right one char
				this.mode = "insert";
				super.handleInput("\x1b[C");
				return;
			case "I":
				// Insert at beginning of line
				this.mode = "insert";
				super.handleInput("\x01"); // ctrl+a = line start
				return;
			case "A":
				// Append at end of line
				this.mode = "insert";
				super.handleInput("\x05"); // ctrl+e = line end
				return;

			// ── Opening new lines ──
			case "o": {
				// Open new line below: go to end, insert new line
				this.mode = "insert";
				super.handleInput("\x05"); // ctrl+e = line end
				super.handleInput("\x0a"); // ctrl+j = new line
				return;
			}
			case "O": {
				// Open new line above: go to start, insert new line, go up
				this.mode = "insert";
				super.handleInput("\x01"); // ctrl+a = line start
				super.handleInput("\x0a"); // ctrl+j = new line
				super.handleInput("\x1b[A"); // cursor up
				return;
			}

			// ── Cursor navigation ──
			case "h":
				super.handleInput("\x1b[D");
				return;
			case "j":
				super.handleInput("\x1b[B");
				return;
			case "k":
				super.handleInput("\x1b[A");
				return;
			case "l":
				super.handleInput("\x1b[C");
				return;

			// ── Word navigation ──
			case "w":
			case "e":
				super.handleInput("\x1b[1;5C"); // ctrl+right = word right
				return;
			case "b":
				super.handleInput("\x1b[1;5D"); // ctrl+left = word left
				return;

			// ── Line navigation ──
			case "0":
				super.handleInput("\x01"); // ctrl+a = line start
				return;
			case "$":
				super.handleInput("\x05"); // ctrl+e = line end
				return;

			// ── Editing ──
			case "x":
				super.handleInput("\x1b[3~"); // delete = delete char forward
				return;
			case "u":
				super.handleInput("\x1f"); // ctrl+- = undo
				return;

			// ── Default: pass control sequences to super, ignore printable chars ──
			default:
				if (data.length === 1 && data.charCodeAt(0) >= 32) return;
				super.handleInput(data);
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// Add mode indicator to the bottom border
		const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Replace the default editor with our modal editor
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
	});
}
